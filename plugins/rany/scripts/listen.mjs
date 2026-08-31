#!/usr/bin/env node
// RANY -> Claude Code bridge.
//
// Claude Code has no inbound webhook: every hook fires on its OWN lifecycle, and HTTP hooks only
// go outward. The one door in is `asyncRewake` — a background hook process that exits with code 2
// wakes the session and hands Claude its stdout as a system reminder. So this script holds a
// gateway WebSocket open as the persona, and the first thing worth acting on becomes that exit.
//
// It is therefore a LISTENER, not a worker: it never answers anything itself. It prints what
// happened and which MCP tool reaches it, and Claude — in the session you already have open, with
// your repo and your context — does the work. That is the whole point of doing this here instead
// of in a daemon: the daemon would have to rebuild the context this session already has.
//
// Consequence, stated plainly: nothing happens while no session is open. There is no queue and no
// catch-up. A task assigned overnight is seen when a session next starts only if the gateway still
// has it in the resume window; otherwise it is simply missed, and RANY's own unread state is where
// you find it.
//
// Zero dependencies on purpose — a plugin that needs `npm install` before it works is a plugin
// most people never finish installing. Node 22's global WebSocket is all this needs.

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const WAKE = 2   // exit code asyncRewake watches for
const QUIET = 0  // "nothing to say" — the session is not disturbed

/** CLAUDE_PLUGIN_DATA is set for hook processes; tmp is the fallback for someone running this by
 *  hand to debug it. */
const stateDir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'rany-plugin')

/**
 * WHICH project this session is. The plugin is installed per user, so it is live in every session
 * on the machine — and a task belongs to one repository, not to whichever session happened to
 * start first. Everything that is per-session (the lock, the say-once marker) is therefore keyed
 * by project, and the board→project bindings below decide whose task this is.
 */
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const projectKey = createHash('sha256').update(projectDir).digest('hex').slice(0, 16)
const projectState = join(stateDir, 'projects', projectKey)
const pidFile = join(projectState, 'listener.pid')
const saidFile = join(projectState, 'said.json')
/**
 * Shared across projects: one BOARD's tasks belong to one repository. A board is the closest thing
 * RANY has to a project — a guild is a company or a community and holds many.
 *
 * Deliberately NOT under CLAUDE_PLUGIN_DATA. That variable reaches hook processes and MCP
 * subprocesses, but `--bind` runs as an ordinary command where it is unset — so the writer fell
 * back to a temp directory while the listener, being a hook, read the real one. The binding was
 * saved correctly and never seen. A path both sides compute from nothing cannot drift apart.
 */
const bindFile = join(homedir(), '.rany-plugin', 'bindings.json')

/** Compare paths, not strings. Windows hands the same directory back as `E:\Works\x` or `E:/Works/x`
 *  depending on who asked, and a case difference in a drive letter is not a different repository —
 *  a binding that fails on punctuation is worse than no binding at all. */
const samePath = (a, b) => norm(a) === norm(b)
const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

function loadBindings() {
  try { return JSON.parse(readFileSync(bindFile, 'utf8')).boards ?? {} } catch { return {} }
}

/** `--bind <boardId>`: run in the repo that owns that board's work. */
function bindBoard(boardId) {
  const boards = loadBindings()
  boards[boardId] = projectDir
  try {
    mkdirSync(dirname(bindFile), { recursive: true })
    writeFileSync(bindFile, JSON.stringify({ boards }, null, 2))
    process.stdout.write(`RANY: board ${boardId} is now handled in ${projectDir}\n`)
  } catch (e) {
    process.stdout.write(`RANY: could not save the binding (${e?.message ?? e})\n`)
  }
}

/**
 * Say a setup problem ONCE, then never again for the same problem.
 *
 * The two failure shapes pull in opposite directions. Staying silent means someone installs the
 * plugin, nothing ever happens, and they conclude it is broken — which is exactly what a stranger
 * experiences today. Speaking every turn means a nag in every session, and a plugin that nags gets
 * disabled. So each distinct problem interrupts exactly one turn; the marker resets when the
 * problem changes, so fixing one and hitting the next still gets you told.
 */
function sayOnce(key, text) {
  let said = {}
  try { if (existsSync(saidFile)) said = JSON.parse(readFileSync(saidFile, 'utf8')) } catch { /* re-say */ }
  if (said[key]) return null
  try {
    mkdirSync(dirname(saidFile), { recursive: true })
    writeFileSync(saidFile, JSON.stringify({ [key]: true }))  // one key: a new problem replaces the old
  } catch { /* unwritable: it will say it again, which beats never saying it */ }
  return text
}

function loadConfig() {
  let file = {}
  const path = join(stateDir, 'rany.json')
  try { if (existsSync(path)) file = JSON.parse(readFileSync(path, 'utf8')) } catch { /* malformed → env only */ }

  const apiUrl = (process.env.RANY_API_URL || file.apiUrl || 'https://www.rany.work/api').replace(/\/+$/, '')
  const token = process.env.RANY_PERSONA_TOKEN || file.token || ''
  // Same host, /gateway instead of /api — the deployment nobody configured explicitly.
  const gatewayUrl = process.env.RANY_GATEWAY_URL || file.gatewayUrl
    || apiUrl.replace(/^http/, 'ws').replace(/\/api$/, '/gateway')
  return {
    apiUrl, token, gatewayUrl,
    // Which events are worth interrupting you for. The first three are things addressed TO your
    // persona; the last two are it overhearing your own conversations, which is a firehose in a
    // busy guild and is off unless you ask for it.
    wake: {
      tasks: true, addressed: true, sessions: true, forwards: true,
      ownerMentions: false, ownerDms: false,
      ...(file.wake ?? {}),
    },
    // Backstop only. The Stop hook respawns this after every turn, and the pidfile keeps that to
    // one live listener; this just guarantees an abandoned process eventually goes away.
    maxMinutes: file.maxMinutes ?? 480,
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** True when this process may run. One listener per PROJECT — not per machine: sessions open in
 *  different repositories each need their own, or only one project could ever be woken. Within a
 *  project the lock still holds, so the Stop hook respawning after every turn adds no sockets. */
function claimLock() {
  try {
    mkdirSync(dirname(pidFile), { recursive: true })
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid && pid !== process.pid && alive(pid)) return false
    }
    writeFileSync(pidFile, String(process.pid))
    return true
  } catch {
    return true // unwritable state dir: better a possible duplicate than a plugin that never runs
  }
}

function releaseLock() {
  try {
    if (!existsSync(pidFile)) return
    if (Number(readFileSync(pidFile, 'utf8').trim()) === process.pid) unlinkSync(pidFile)
  } catch { /* nothing to do */ }
}

/** `--bind <boardId>`: claim that board's tasks for THIS repository. */
const bindAt = process.argv.indexOf('--bind')
if (bindAt !== -1) {
  const boardId = process.argv[bindAt + 1]
  if (!boardId || !/^[0-9]+$/.test(boardId)) {
    process.stdout.write('RANY: --bind needs a board id — the wake-up notice prints the command with it filled in\n')
    process.exit(QUIET)
  }
  bindBoard(boardId)
  process.exit(QUIET)
}

/** `--stop`: SessionEnd asks the live listener to go away, so a closed terminal leaves no socket. */
if (process.argv.includes('--stop')) {
  try {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid && alive(pid)) process.kill(pid)
      unlinkSync(pidFile)
    }
  } catch { /* already gone */ }
  process.exit(QUIET)
}

const config = loadConfig()

if (typeof WebSocket === 'undefined') {
  const msg = sayOnce('node', [
    `RANY plugin: this Node (${process.version}) has no global WebSocket, so the plugin cannot`,
    `listen. Node 22 or newer fixes it. Everything else — the MCP tools, /rany-task, /rany-reply —`,
    `still works; you just have to ask rather than be told.`,
  ].join('\n'))
  if (msg) process.stdout.write(msg + '\n')
  process.exit(msg ? WAKE : QUIET)
}

if (!config.token) {
  const msg = sayOnce('token', [
    `RANY plugin: installed but not configured, so it is doing nothing.`,
    `Set RANY_PERSONA_TOKEN (RANY → persona settings → Rotate token; shown once) and`,
    `RANY_API_URL if your deployment is not ${config.apiUrl}.`,
  ].join('\n'))
  if (msg) process.stdout.write(msg + '\n')
  process.exit(msg ? WAKE : QUIET)
}

if (!claimLock()) process.exit(QUIET)

const OP = { Dispatch: 0, Hello: 1, Identify: 2, Heartbeat: 3, Resume: 6, InvalidSession: 9 }

let personaUserId = null
let heartbeat = null
let socket = null

const done = (code, text) => {
  if (text) process.stdout.write(text + '\n')
  if (heartbeat) clearInterval(heartbeat)
  try { socket?.close() } catch { /* closing anyway */ }
  releaseLock()
  process.exit(code)
}

process.on('SIGTERM', () => done(QUIET))
process.on('SIGINT', () => done(QUIET))
setTimeout(() => done(QUIET), config.maxMinutes * 60_000).unref()

/**
 * What this event means for the persona, or null to keep waiting. The gateway already decides what
 * a persona may hear (owner-resolved visibility, guild opt-out, persona_depth), so this only sorts
 * what arrives into "worth waking you" and "not".
 */
function classify(type, d) {
  if (type === 'TASK_UPDATED') {
    const added = Array.isArray(d.addedAssigneeIds) ? d.addedAssigneeIds : []
    if (!config.wake.tasks || !added.includes(personaUserId)) return null
    // A private board's payload drops guildId so the gateway cannot fan it guild-wide, and carries
    // the same value as taskGuildId for addressing (db/0242).
    const guildId = String(d.guildId ?? d.taskGuildId ?? '')

    // WHOSE task is this? A session open in an unrelated repository can do nothing useful with it,
    // and waking it is worse than silence — it interrupts one piece of work with another project's.
    // Keyed by BOARD, not guild: a guild is a company or a community and holds many projects, while
    // a board is the closest thing RANY has to one. (They coincide while a guild has only its
    // default board, which is exactly the case that would make a guild binding look correct.)
    const boardId = String(d.boardId ?? '')
    const boundTo = boardId ? loadBindings()[boardId] : undefined
    if (boundTo && !samePath(boundTo, projectDir)) return null
    if (!boundTo) {
      // Nothing bound yet. Said once per board per project, rather than waking every open session
      // for every task or silently dropping the first one — and it carries the exact command,
      // because a board id is not in any URL and nobody should have to go find it.
      return sayOnce(`unbound:${boardId}`, [
        `RANY: "${d.title ?? 'a task'}" was assigned to your persona, but no repository is bound to`,
        `its board (${boardId || 'unknown'}), so I cannot tell whether it belongs to this one:`,
        `  ${projectDir}`,
        ``,
        `If it does: /rany-bind ${boardId} — then that board's tasks wake THIS project and no other.`,
        `If it does not: run that in the repository that owns it. Until then I stay out of the way.`,
        ``,
        // The ids ride along, because the event that carried them is gone by the time anyone binds
        // and it is never redelivered — so without this the FIRST task on a board is always lost and
        // has to be re-assigned by hand just to produce a second notice.
        `Either way the task itself is not lost — once bound, act on it now:`,
        `  get_task({guildId:"${guildId}", taskId:"${d.id}"})`,
      ].join('\n'))
    }

    return [
      `RANY: a task was assigned to your persona.`,
      `  task ${d.id} in guild ${guildId} — "${d.title ?? '(untitled)'}"`,
      ``,
      `Read it with the rany MCP tool get_task({guildId:"${guildId}", taskId:"${d.id}"}), do the work`,
      `in this project, and report what you did with comment_task on the same task. If it is not`,
      `about this project, say so in the comment instead of guessing.`,
    ].join('\n')
  }

  if (type === 'PERSONA_FORWARD') {
    if (!config.wake.forwards) return null
    const msgs = Array.isArray(d.messages) ? d.messages : []
    const target = msgs.find((m) => m.target) ?? msgs[msgs.length - 1]
    return [
      `RANY: your owner forwarded a conversation to your persona.`,
      `  channel ${d.channelId}${d.channelName ? ` (#${d.channelName})` : ''}`,
      `  >>> ${target?.content ?? ''}`,
      ``,
      `Answer with post_message({channelId:"${d.channelId}", content:"…", replyToId:"${target?.id ?? ''}"}).`,
      `get_recent_messages on that channel gives you the rest of the thread.`,
    ].join('\n')
  }

  if (type !== 'MESSAGE_CREATED') return null

  const recipients = Array.isArray(d.recipientIds) ? d.recipientIds : []
  const mentions = Array.isArray(d.mentions) ? d.mentions : []
  const isGuild = typeof d.guildId === 'string' && d.guildId.length > 0

  // The persona is itself a member of the conversation: a session with your owner, or a group DM
  // it was added to. Always its own conversation, never eavesdropping.
  if (!isGuild && recipients.includes(personaUserId)) {
    if (!config.wake.sessions) return null
    return [
      `RANY: a message in your persona's own chat (channel ${d.channelId}).`,
      `  user ${d.authorId}: ${d.content ?? ''}`,
      ``,
      `Reply with post_message({channelId:"${d.channelId}", content:"…"}).`,
    ].join('\n')
  }

  // Someone wrote <@persona> in a guild channel — they are talking to your AI, not to you.
  if (isGuild && mentions.includes(personaUserId)) {
    if (!config.wake.addressed) return null
    return [
      `RANY: someone addressed your persona directly in channel ${d.channelId}.`,
      `  user ${d.authorId}: ${d.content ?? ''}`,
      ``,
      `They are asking YOUR AI, not you. Answer them with`,
      `post_message({channelId:"${d.channelId}", content:"…", replyToId:"${d.messageId}"}).`,
      `get_recent_messages on that channel for what was said before.`,
    ].join('\n')
  }

  // Overhearing the owner's own conversations (the listen_dms / listen_mentions flags). Off by
  // default: in a busy guild this is a firehose, and it is not addressed to the persona.
  if (isGuild ? config.wake.ownerMentions : config.wake.ownerDms) {
    return [
      `RANY: ${isGuild ? 'you were mentioned in' : 'a direct message arrived in'} channel ${d.channelId}.`,
      `  user ${d.authorId}: ${d.content ?? ''}`,
    ].join('\n')
  }
  return null
}

function connect() {
  try {
    socket = new WebSocket(config.gatewayUrl)
  } catch {
    done(QUIET) // bad URL — not worth interrupting a session over
    return
  }

  socket.addEventListener('message', (ev) => {
    let frame
    try { frame = JSON.parse(String(ev.data)) } catch { return }

    if (frame.op === OP.Hello) {
      const interval = frame.d?.heartbeatInterval ?? 30000
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = setInterval(() => {
        try { socket.send(JSON.stringify({ op: OP.Heartbeat })) } catch { /* close handler follows */ }
      }, interval)
      socket.send(JSON.stringify({ op: OP.Identify, d: { token: config.token } }))
      return
    }

    // The gateway refused us. Retrying cannot fix any of the reasons, and the reasons are exactly
    // what someone staring at a plugin that does nothing needs to be told — so say it once.
    if (frame.op === OP.InvalidSession) {
      const msg = sayOnce('auth', [
        `RANY plugin: the gateway refused the persona token, so nothing will wake this session.`,
        `Usually one of:`,
        `  · a model API key is stored on the persona — that moves its brain to the server and`,
        `    retires this connection by design. Clear the key to hand it back to Claude Code.`,
        `  · the persona is paused or revoked, or the token was rotated after you exported it.`,
        `Fix it in RANY → persona settings. Nothing else in the plugin is affected.`,
      ].join('\n'))
      done(msg ? WAKE : QUIET, msg)
      return
    }

    if (frame.op !== OP.Dispatch) return
    if (frame.t === 'READY') { personaUserId = String(frame.d?.userId ?? '') || null; return }
    if (!personaUserId) return

    const summary = classify(frame.t, frame.d ?? {})
    if (summary) done(WAKE, summary)
  })

  // A dropped socket is not news. Reconnect quietly; the Stop hook would respawn us anyway.
  socket.addEventListener('close', () => {
    if (heartbeat) clearInterval(heartbeat)
    setTimeout(connect, 3000)
  })
  socket.addEventListener('error', () => { /* 'close' follows and owns the retry */ })
}

connect()
