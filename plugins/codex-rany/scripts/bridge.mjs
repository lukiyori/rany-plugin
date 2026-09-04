#!/usr/bin/env node
// RANY -> Codex bridge.
//
// Same job as the Claude Code plugin's listener (plugins/rany/scripts/listen.mjs), different door.
//
// Claude Code has no inbound webhook, so that plugin holds a gateway socket INSIDE each session and
// wakes it by exiting with code 2. Codex has a real one: `codex queue --thread <id> --message <text>`
// delivers a message into a session from outside, and `thread/list` (the app-server, over stdio)
// says which threads exist and in which directory. So the shape inverts — ONE daemon per machine
// holds the RANY socket, and it decides which open session an event belongs to and writes to that
// one. Nothing is broadcast, and a session in an unrelated repository is never interrupted.
//
// What that buys over the Claude side, concretely:
//   · updating the plugin reaches every session, because the daemon is not per-session;
//   · a task that arrives while the session is mid-turn is queued, not dropped;
//   · a task for a repository whose session is closed WAITS in that thread's queue instead of
//     vanishing (Codex delivers it when the thread is next resumed).
//
// Zero dependencies. Node 22's global WebSocket is all this needs.

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Shared with the Claude Code plugin ON PURPOSE: a board belongs to a repository, not to whichever
 *  agent you happen to be running. Bind once, and both bridges route it the same way. */
const HOME = join(homedir(), '.rany-plugin')
const bindFile = join(HOME, 'bindings.json')
const unroutedFile = join(HOME, 'unrouted.json')
/** One file per open Codex session, refreshed every turn — see `--ping`. */
const sessionsDir = join(HOME, 'codex-sessions')
const pidFile = join(HOME, 'codex-bridge.pid')
const stateFile = join(HOME, 'codex-bridge.json')

/** RANY's notification bot (db/0251 seeds it at the reserved id 1). Its DMs restate events the
 *  gateway already delivered, so they are never a reason to wake anybody. */
const SYSTEM_BOT_ID = '1'

/** A session whose last turn is older than this is treated as gone: its heartbeat stops counting
 *  toward "a runtime is handling this board" (ADR-033) and it is no longer a wake target. Wide
 *  enough that a long turn — or a coffee — does not drop a session that is plainly still open. */
const SESSION_STALE_MS = 20 * 60_000
const CLAIM_REFRESH_MS = 5 * 60_000

const norm = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
const samePath = (a, b) => norm(a) === norm(b)
const projectKeyOf = (dir) => createHash('sha256').update(norm(dir)).digest('hex').slice(0, 16)

const VERSION = (() => {
  try {
    const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    return JSON.parse(readFileSync(join(here, '..', '.codex-plugin', 'plugin.json'), 'utf8')).version ?? '?'
  } catch { return '?' }
})()

function loadBindings() {
  try { return JSON.parse(readFileSync(bindFile, 'utf8')).boards ?? {} } catch { return {} }
}

/** Which repository claims this id, if any. One map holds boards and guilds, because RANY makes them
 *  the same number for a guild's DEFAULT board. What the id MEANS is decided by the caller: tasks look
 *  up the board and only the board (see the task branch), guild conversations look up the guild. */
const claimedBy = (id) => (id ? loadBindings()[String(id)] : undefined)

/** Why an event went where it went. The daemon outlives every session, so without this the only
 *  record of a routing decision is the interruption itself. Best-effort; never worth an error. */
function logRoute(type, ids, decision) {
  try {
    appendFileSync(join(HOME, 'routing.log'),
      `${new Date().toISOString()} codex-v${VERSION} ${type} ${JSON.stringify(ids)} -> ${decision}\n`)
  } catch { /* diagnostics are not worth an interruption */ }
}

// ---- open Codex sessions ---------------------------------------------------------------------
// A hook writes one file per session and refreshes it on every prompt. `thread/list` cannot answer
// this: its `status` and `canAcceptDirectInput` are per app-server PROCESS, so a separate process
// (this daemon) sees every thread as `notLoaded` no matter how alive it is.

function noteSession(cwd) {
  try {
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(join(sessionsDir, `${projectKeyOf(cwd)}.json`),
      JSON.stringify({ dir: cwd, ts: Date.now() }))
  } catch { /* unwritable state dir: the daemon falls back to thread recency */ }
}

function forgetSession(cwd) {
  try { rmSync(join(sessionsDir, `${projectKeyOf(cwd)}.json`), { force: true }) } catch { /* gone */ }
}

/** Directories with a session that has run a turn recently. */
function liveProjectDirs() {
  const out = []
  let names = []
  try { names = readdirSync(sessionsDir) } catch { return out }
  for (const n of names) {
    try {
      const row = JSON.parse(readFileSync(join(sessionsDir, n), 'utf8'))
      if (row?.dir && Date.now() - (row.ts ?? 0) < SESSION_STALE_MS) out.push(row.dir)
      else rmSync(join(sessionsDir, n), { force: true }) // stale: stop claiming its boards
    } catch { /* unreadable: ignore it rather than drop every other session */ }
  }
  return out
}

// ---- the Codex app-server --------------------------------------------------------------------

/** Resolve the codex CLI entrypoint. Spawning `codex.cmd` directly fails with EINVAL on Windows, and
 *  `shell: true` would need quoting for every path with a space, so run the JS entrypoint under the
 *  Node we are already in. Falls back to the PATH name where the layout is different. */
function codexEntry() {
  const guesses = [
    process.env.RANY_CODEX_JS,
    join(process.env.ProgramFiles ?? 'C:/Program Files', 'nodejs/node_modules/@openai/codex/bin/codex.js'),
    join(homedir(), 'AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js'),
    '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    '/usr/lib/node_modules/@openai/codex/bin/codex.js',
  ].filter(Boolean)
  for (const g of guesses) if (existsSync(g)) return { cmd: process.execPath, pre: [g] }
  return { cmd: process.platform === 'win32' ? 'codex.cmd' : 'codex', pre: [], shell: process.platform === 'win32' }
}

/** One JSON-RPC round trip against a fresh `codex app-server`. Started per call on purpose: the
 *  daemon asks maybe once a minute, and a long-lived child that dies quietly would be worse. */
function appServer(method, params, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const { cmd, pre, shell } = codexEntry()
    let child
    try { child = spawn(cmd, [...pre, 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'], shell }) }
    catch { return resolve(null) }
    let buf = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; try { child.kill() } catch { /* exiting */ } resolve(v) } }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    child.on('error', () => finish(null))
    child.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n')
        else if (msg.id === 2) { clearTimeout(timer); finish(msg.result ?? null) }
      }
    })
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'rany-bridge', title: 'RANY', version: VERSION } },
    }) + '\n')
  })
}

/** The thread to write into for a repository: the most recently touched one opened in that exact
 *  directory. `thread/list` filters by cwd server-side, so this cannot drift into a sibling checkout. */
async function threadForDir(dir) {
  const res = await appServer('thread/list', { cwd: dir, limit: 10 })
  const rows = (res?.data ?? []).filter((t) => t?.id && t?.cwd && samePath(t.cwd, dir))
  if (rows.length === 0) return null
  rows.sort((a, b) => (b.updatedAt ?? b.recencyAt ?? 0) - (a.updatedAt ?? a.recencyAt ?? 0))
  return rows[0].id
}

/** Deliver. `codex queue` is the supported door and it is what the TUI drains — a live session picks
 *  the message up within a second, and a closed one keeps it until the thread is resumed. */
function queueMessage(threadId, text) {
  return new Promise((resolve) => {
    const { cmd, pre, shell } = codexEntry()
    let child
    try {
      child = spawn(cmd, [...pre, 'queue', '--thread', threadId, '--message', text],
        { stdio: 'ignore', shell })
    } catch { return resolve(false) }
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

// ---- unrouted boards -------------------------------------------------------------------------

/** Remember a board nobody claimed, so silence is not the same as forgetting. Keyed by board: what
 *  you need later is "which board, and what was the most recent thing on it". */
function noteUnrouted(boardId, guildId, d) {
  if (!boardId) return
  let seen = {}
  try { seen = JSON.parse(readFileSync(unroutedFile, 'utf8')).boards ?? {} } catch { /* first one */ }
  seen[boardId] = {
    guildId,
    lastTaskId: String(d.id ?? ''),
    lastTitle: String(d.title ?? ''),
    lastSeen: new Date().toISOString(),
  }
  try {
    mkdirSync(dirname(unroutedFile), { recursive: true })
    writeFileSync(unroutedFile, JSON.stringify({ boards: seen }, null, 2))
  } catch { /* unwritable: the sighting is lost, the silence is not */ }
}

function listUnrouted() {
  let seen = {}
  try { seen = JSON.parse(readFileSync(unroutedFile, 'utf8')).boards ?? {} } catch { /* none */ }
  const bound = loadBindings()
  const rows = Object.entries(seen).filter(([id]) => !bound[id])
  if (rows.length === 0) {
    process.stdout.write('RANY: no unrouted boards seen. Copy a board id from RANY (board header → ID) to bind one.\n')
    return
  }
  process.stdout.write('RANY: boards seen on an assignment but bound to no repository:\n')
  for (const [id, v] of rows)
    process.stdout.write(`  ${id}  — last: "${v.lastTitle}" (${v.lastSeen.slice(0, 16).replace('T', ' ')})\n`)
  process.stdout.write('\nRun /rany-bind <boardId> in the repository that owns that board.\n')
}

// ---- config ----------------------------------------------------------------------------------

function loadConfig() {
  let file = {}
  try { file = JSON.parse(readFileSync(join(HOME, 'codex.json'), 'utf8')) } catch { /* env only */ }
  const apiUrl = (process.env.RANY_API_URL || file.apiUrl || 'https://www.rany.work/api').replace(/\/+$/, '')
  const token = process.env.RANY_PERSONA_TOKEN || file.token || ''
  const gatewayUrl = process.env.RANY_GATEWAY_URL || file.gatewayUrl
    || apiUrl.replace(/^http/, 'ws').replace(/\/api$/, '/gateway')
  return {
    apiUrl, token, gatewayUrl,
    wake: {
      tasks: true, addressed: true, sessions: true, forwards: true,
      ownerMentions: false, ownerDms: false,
      ...(file.wake ?? {}),
    },
  }
}

const config = loadConfig()

/** Tell RANY which boards are being handled right now (ADR-033, db/0285), so a persona is offered as
 *  a task assignee only where something is listening. Declared PER PROJECT, because one daemon covers
 *  every checkout on the machine and a project's claims must not delete another's. */
function declareBoards(projectKey, boardIds, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!config.token) return resolve()
    let url
    try { url = new URL(`${config.apiUrl}/personas/@self/boards`) } catch { return resolve() }
    const body = JSON.stringify({ projectKey, boardIds })
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    const req = send(url, {
      method: 'POST',
      agent: false,
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Bearer ${config.token}`,
      },
    }, (res) => { res.resume(); res.on('end', resolve); res.on('error', () => resolve()) })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve()) // offline, old server, no such route: not the bridge's problem
    req.end(body)
  })
}

/** Every open session's boards, declared per project; projects that went quiet declare nothing and
 *  their claims expire server-side. */
async function refreshClaims() {
  const bindings = loadBindings()
  const known = new Set()
  for (const dir of liveProjectDirs()) {
    const boards = Object.entries(bindings).filter(([, d]) => samePath(d, dir)).map(([id]) => id)
    known.add(projectKeyOf(dir))
    await declareBoards(projectKeyOf(dir), boards)
  }
  // A project whose session just closed must stop claiming immediately, not in 20 minutes.
  let previous = []
  try { previous = JSON.parse(readFileSync(stateFile, 'utf8')).projects ?? [] } catch { /* first run */ }
  for (const key of previous) if (!known.has(key)) await declareBoards(key, [])
  try { writeFileSync(stateFile, JSON.stringify({ projects: [...known] })) } catch { /* best effort */ }
}

// ---- commands --------------------------------------------------------------------------------

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : (process.argv[i + 1] ?? '')
}
const has = (name) => process.argv.includes(name)

/** `--bind <id>`: claim that board's work for THIS repository (the same file the Claude plugin uses). */
if (has('--bind')) {
  const boardId = arg('--bind')
  if (!boardId) { listUnrouted(); process.exit(0) }
  if (!/^[0-9]+$/.test(boardId)) {
    process.stdout.write('RANY: --bind needs a board id (RANY → board header → ID), or no argument to list unrouted boards\n')
    process.exit(0)
  }
  const boards = loadBindings()
  boards[boardId] = process.cwd()
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(bindFile, JSON.stringify({ boards }, null, 2))
    process.stdout.write(`RANY: ${boardId} is now handled in ${process.cwd()}\n`)
  } catch (e) {
    process.stdout.write(`RANY: could not save the binding (${e?.message ?? e})\n`)
    process.exit(0)
  }
  noteSession(process.cwd())
  await declareBoards(projectKeyOf(process.cwd()),
    Object.entries(loadBindings()).filter(([, d]) => samePath(d, process.cwd())).map(([id]) => id))
  process.exit(0)
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

/** SessionStart: record this session and make sure the machine's one daemon is running. */
if (has('--ensure') || has('--ping')) {
  noteSession(process.cwd())
  let running = false
  try {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      running = Boolean(pid) && alive(pid)
    }
  } catch { /* treat as not running */ }
  if (!running && config.token) {
    const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    const child = spawn(process.execPath, [join(here, 'bridge.mjs'), '--daemon'],
      { detached: true, stdio: 'ignore' })
    child.unref()
  }
  if (!config.token && has('--ensure')) {
    // Say it once per session rather than never: a plugin that is installed and silent reads as broken.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'RANY plugin: installed but not configured, so nothing will wake this session. '
          + 'Set RANY_PERSONA_TOKEN (RANY → persona settings → Rotate token; shown once) and, if this is a '
          + 'self-hosted deployment, RANY_API_URL.',
      },
    }) + '\n')
  }
  process.exit(0)
}

/** SessionEnd: this repository stops being a wake target straight away. */
if (has('--bye')) { forgetSession(process.cwd()); process.exit(0) }

if (has('--stop')) {
  try {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid && alive(pid)) process.kill(pid)
      unlinkSync(pidFile)
    }
  } catch { /* already gone */ }
  process.exit(0)
}

if (!has('--daemon')) {
  process.stdout.write('RANY codex bridge. Usage: --bind [boardId] | --ensure | --ping | --bye | --daemon | --stop\n')
  process.exit(0)
}

// ---- the daemon ------------------------------------------------------------------------------

if (typeof WebSocket === 'undefined') process.exit(0) // Node 22+ only; nothing to say to nobody
if (!config.token) process.exit(0)

try {
  mkdirSync(HOME, { recursive: true })
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (pid && pid !== process.pid && alive(pid)) process.exit(0) // one daemon per machine
  }
  writeFileSync(pidFile, String(process.pid))
} catch { /* unwritable: better a possible duplicate than a bridge that never runs */ }

const OP = { Dispatch: 0, Hello: 1, Identify: 2, Heartbeat: 3, InvalidSession: 9 }

let personaUserId = null
let personaName = null   // from READY; the name every post is attributed to
let heartbeat = null
let socket = null

const shutdown = () => {
  if (heartbeat) clearInterval(heartbeat)
  try { socket?.close() } catch { /* closing anyway */ }
  try {
    if (existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8').trim()) === process.pid) unlinkSync(pidFile)
  } catch { /* nothing to do */ }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

void refreshClaims()
setInterval(() => void refreshClaims(), CLAIM_REFRESH_MS).unref?.()

/** Who the session speaks as. Every queued message carries it, because a session that is not told
 *  signs as the model underneath ("— Codex") under a comment RANY already labels with the persona's
 *  name — and a commit made for the task then credits the model too. */
function asPersona() {
  const who = personaName ? `the persona "${personaName}"` : 'your persona'
  return [
    `You act as ${who}. RANY attributes posts and comments to that name by itself: do not sign`,
    `them, and never name the model underneath ("Codex", "— AI"). A commit made for RANY work is`,
    `${who}'s as well — author or Co-Authored-By ${personaName ?? 'the persona'} <noreply@rany.work>.`,
  ].join('\n')
}

/**
 * Where does this event belong, and what should that session be told? Returns `{ dir, text }`, or
 * null to stay quiet. The gateway already decides what a persona may HEAR; this only decides which
 * repository it is about.
 */
function route(type, d) {
  if (type === 'TASK_UPDATED') {
    const added = Array.isArray(d.addedAssigneeIds) ? d.addedAssigneeIds : []
    if (!config.wake.tasks || !added.includes(personaUserId)) return null
    const guildId = String(d.guildId ?? d.taskGuildId ?? '')
    // BOARD ONLY, and deliberately no guild fallback: a guild's DEFAULT board carries the guild's own
    // id, so "I bound the board" and "I bound the server" are the same keystrokes — a fallback would
    // make binding the default board silently claim every board added to that server later.
    const boardId = String(d.boardId ?? '')
    const dir = claimedBy(boardId)
    if (!dir) {
      noteUnrouted(boardId, guildId, d)
      logRoute('TASK_UPDATED', { boardId, guildId }, 'skip (unbound)')
      return null
    }
    return {
      dir,
      text: [
        `RANY: a task was assigned to your persona.`,
        `  task ${d.id} in guild ${guildId} — "${d.title ?? '(untitled)'}"`,
        ``,
        `Read it with the rany MCP tool get_task({guildId:"${guildId}", taskId:"${d.id}"}), do the work`,
        `in this project, report what you did with comment_task, and move the card with`,
        `set_task_status (get_task lists the board's statuses and their categories). If it is not`,
        `about this project, say so in the comment instead of guessing.`,
        ``,
        asPersona(),
      ].join('\n'),
    }
  }

  if (type === 'PERSONA_FORWARD') {
    if (!config.wake.forwards) return null
    const dir = claimedBy(d.guildId)
    if (!dir) { logRoute('PERSONA_FORWARD', { guildId: d.guildId }, 'skip (unclaimed guild)'); return null }
    const msgs = Array.isArray(d.messages) ? d.messages : []
    const target = msgs.find((m) => m.target) ?? msgs[msgs.length - 1]
    return {
      dir,
      text: [
        `RANY: your owner forwarded a conversation to your persona.`,
        `  channel ${d.channelId}${d.channelName ? ` (#${d.channelName})` : ''}`,
        `  >>> ${target?.content ?? ''}`,
        ``,
        `Answer with post_message({channelId:"${d.channelId}", content:"…", replyToId:"${target?.id ?? ''}"}).`,
        ``,
        asPersona(),
      ].join('\n'),
    }
  }

  if (type !== 'MESSAGE_CREATED') return null

  const recipients = Array.isArray(d.recipientIds) ? d.recipientIds : []
  const mentions = Array.isArray(d.mentions) ? d.mentions : []
  const isGuild = typeof d.guildId === 'string' && d.guildId.length > 0

  // A conversation in a guild belongs to whoever claimed that guild. Unlike the Claude listener there
  // is no "any open session may answer" case here: this daemon can see every session at once, so
  // picking one at random would not be a fallback, it would be a coin toss.
  if (isGuild) {
    const dir = claimedBy(d.guildId)
    if (!dir) { logRoute('MESSAGE_CREATED', { guildId: d.guildId }, 'skip (unclaimed guild)'); return null }
    if (mentions.includes(personaUserId) && config.wake.addressed) {
      return {
        dir,
        text: [
          `RANY: someone addressed your persona directly in channel ${d.channelId}.`,
          `  user ${d.authorId}: ${d.content ?? ''}`,
          ``,
          `They are asking YOUR AI, not you. Answer them with`,
          `post_message({channelId:"${d.channelId}", content:"…", replyToId:"${d.messageId}"}).`,
          ``,
          asPersona(),
        ].join('\n'),
      }
    }
    if (config.wake.ownerMentions) {
      return { dir, text: `RANY: you were mentioned in channel ${d.channelId}.\n  user ${d.authorId}: ${d.content ?? ''}` }
    }
    return null
  }

  // The persona's own conversation (a session with its owner, or a group DM it was added to). A DM
  // carries no board and no guild, so there is nothing to route it BY — it goes to the session the
  // owner most recently worked in, which is the only honest answer.
  if (recipients.includes(personaUserId) && config.wake.sessions) {
    // ...unless RANY's own notification bot wrote it. Those DMs mirror events the gateway ALREADY
    // delivered, so acting on them announces the same thing twice — and the copy carries no board.
    if (String(d.authorId ?? '') === SYSTEM_BOT_ID) {
      logRoute('MESSAGE_CREATED', { channelId: d.channelId }, 'skip (notification bot)')
      return null
    }
    const dir = mostRecentLiveDir()
    if (!dir) { logRoute('MESSAGE_CREATED', { channelId: d.channelId }, 'skip (no open session)'); return null }
    return {
      dir,
      text: [
        `RANY: a message in your persona's own chat (channel ${d.channelId}).`,
        `  user ${d.authorId}: ${d.content ?? ''}`,
        ``,
        `Reply with post_message({channelId:"${d.channelId}", content:"…"}).`,
        ``,
        asPersona(),
      ].join('\n'),
    }
  }
  return null
}

/** The session the owner is actually sitting in — for the events that name no repository. */
function mostRecentLiveDir() {
  let best = null
  let bestTs = 0
  let names = []
  try { names = readdirSync(sessionsDir) } catch { return null }
  for (const n of names) {
    try {
      const row = JSON.parse(readFileSync(join(sessionsDir, n), 'utf8'))
      if (row?.dir && (row.ts ?? 0) > bestTs && Date.now() - row.ts < SESSION_STALE_MS) {
        best = row.dir; bestTs = row.ts
      }
    } catch { /* skip */ }
  }
  return best
}

async function deliver(type, ids, { dir, text }) {
  const threadId = await threadForDir(dir)
  if (!threadId) { logRoute(type, ids, `no thread in ${dir}`); return }
  const ok = await queueMessage(threadId, text)
  logRoute(type, ids, ok ? `queued -> ${threadId} @ ${dir}` : `queue FAILED -> ${threadId} @ ${dir}`)
}

function connect() {
  try { socket = new WebSocket(config.gatewayUrl) } catch { return void setTimeout(connect, 15000) }

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

    // Refused: a hosted persona (its brain moved to the server), a paused/revoked persona, or a
    // rotated token. Retrying cannot fix any of them, so stop rather than reconnect forever.
    if (frame.op === OP.InvalidSession) {
      logRoute('AUTH', {}, 'gateway refused the persona token — daemon exiting')
      shutdown()
      return
    }

    if (frame.op !== OP.Dispatch) return
    if (frame.t === 'READY') {
      personaUserId = String(frame.d?.userId ?? '') || null
      personaName = String(frame.d?.persona?.displayName ?? '').trim() || null
      return
    }
    if (!personaUserId) return

    const d = frame.d ?? {}
    const target = route(frame.t, d)
    if (target) void deliver(frame.t, { boardId: d.boardId, guildId: d.guildId, channelId: d.channelId }, target)
  })

  socket.addEventListener('close', () => {
    if (heartbeat) clearInterval(heartbeat)
    setTimeout(connect, 3000)
  })
  socket.addEventListener('error', () => { /* 'close' follows and owns the retry */ })
}

connect()
