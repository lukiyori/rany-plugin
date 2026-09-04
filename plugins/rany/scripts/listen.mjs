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

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

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

/**
 * WHICH session this is. A binding belongs to the session that ran `/rany-bind`, not merely to the
 * directory — open two terminals in one repo and only the one you bound wakes (ADR-038). Claude Code
 * exports this in the environment of every command AND hook process it spawns, so `--bind` and the
 * listener agree on it without a handshake. Absent on an older Claude: everything then falls back to
 * the previous directory-scoped behaviour, so nothing breaks where the id cannot be had.
 */
const sessionId = process.env.CLAUDE_CODE_SESSION_ID || null

// Per-session, not per-project: the point is that two sessions in one repo each wake only for what
// THEY bound. The project key still folds in the directory so the server's board claim (db/0285) can
// tell two checkouts apart, and now the session so it can tell two windows apart too.
const projectKey = createHash('sha256').update(projectDir + '|' + (sessionId ?? '')).digest('hex').slice(0, 16)
const projectState = join(stateDir, 'projects',
  createHash('sha256').update(projectDir).digest('hex').slice(0, 16))
// One listener PER SESSION (keyed by the session id), so a second window in the same repo does not
// kill the first's socket. Falls back to the old per-project pidfile when there is no session id.
const pidFile = sessionId
  ? join(stateDir, 'sessions', createHash('sha256').update(sessionId).digest('hex').slice(0, 16) + '.pid')
  : join(projectState, 'listener.pid')
const saidFile = join(projectState, 'said.json')
/** The machine's most-recently-active session, refreshed every turn (the Stop hook respawns the
 *  listener, which stamps this). Events that name no board and no guild — the persona's own DM — have
 *  nothing to route BY, so they wake only this session, the window the owner is actually sitting in. */
const activeFile = join(stateDir, 'active-session.json')
const ACTIVE_STALE_MS = 15 * 60_000
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

/** RANY's notification bot (db/0251 seeds it at the reserved id 1). Its DMs restate events the
 *  gateway already delivered, so they are never a reason to wake. */
const SYSTEM_BOT_ID = '1'

/** Compare paths, not strings. Windows hands the same directory back as `E:\Works\x` or `E:/Works/x`
 *  depending on who asked, and a case difference in a drive letter is not a different repository —
 *  a binding that fails on punctuation is worse than no binding at all. */
const samePath = (a, b) => norm(a) === norm(b)
const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

function loadBindings() {
  try { return JSON.parse(readFileSync(bindFile, 'utf8')).boards ?? {} } catch { return {} }
}

/**
 * Which binding claims this id, if any. One map holds both kinds, because RANY makes them the same
 * number: a guild's DEFAULT board carries the guild's own id. What the id MEANS is decided by the
 * caller — tasks look up the board and only the board; guild conversations, which carry no board id at
 * all, look up the guild. Never one falling back to the other: see the task branch for why.
 *
 * A binding is one of two shapes. The new one is `{ dir, agent, sessionId, ts }` — owned by the exact
 * session that ran `/rany-bind` (ADR-038). The legacy one is a bare directory string, from before
 * session ownership; it is honoured for compatibility but treated as directory-scoped, so an existing
 * setup keeps working until it is re-bound.
 */
function claimedBy(id) {
  return id ? loadBindings()[String(id)] : undefined
}

const entryDir = (e) => (typeof e === 'string' ? e : e?.dir)
const entrySession = (e) => (typeof e === 'string' ? null : e?.sessionId ?? null)

/** The session the marker says is active right now (the window that most recently finished a turn),
 *  or null when the mark is missing or stale. */
function activeSessionId() {
  try {
    const m = JSON.parse(readFileSync(activeFile, 'utf8'))
    if (m?.sessionId && Date.now() - (m.ts ?? 0) < ACTIVE_STALE_MS) return String(m.sessionId)
  } catch { /* none */ }
  return null
}
/** Am I the window the owner is sitting in? True when I hold the mark, or when nobody fresh does. */
const isActiveSession = () => { const a = activeSessionId(); return !a || a === sessionId }

/**
 * Is THIS session the one that should act on a binding?
 *   · session-scoped entry → only its owning session (the whole point).
 *   · legacy directory string → the directory must match AND, because there is now one listener per
 *     session rather than one per repo, only the active window answers — otherwise every window open
 *     in that repo would wake at once, the very thing session ownership removes.
 */
function ownedHere(entry) {
  if (!entry) return false
  if (typeof entry === 'string') return samePath(entry, projectDir) && isActiveSession()
  return Boolean(sessionId) && entry.sessionId === sessionId
}

/**
 * Why this session did (or did not) wake, appended for every routed event. The routing bug that
 * survived two fixes was impossible to diagnose after the fact: the listener EXITS when it wakes, so
 * there is no process left to ask, and the notice on screen never said which project it decided it
 * belonged to. One line per decision, in the shared directory, so a wake in the wrong repo can be
 * traced instead of argued about. Best-effort — a failure here must never affect routing.
 */
function logRoute(type, ids, decision) {
  try {
    const line = `${new Date().toISOString()} v${VERSION} ${type} ${JSON.stringify(ids)} -> ${decision} @ ${projectDir}\n`
    appendFileSync(join(homedir(), '.rany-plugin', 'routing.log'), line)
  } catch { /* diagnostics are not worth an interruption */ }
}

/**
 * This listener's own plugin version, stamped on every routed decision.
 *
 * Not decoration. Updating the plugin does NOT change a session that is already open: the hook spawns
 * the listener from a VERSIONED path, so a long-running session keeps whatever it loaded, forever, and
 * early versions had no routing at all — they woke every session for every task. Such a process is
 * invisible here (it predates this log), so the absence of a project from the log is itself the
 * signal: a wake that no line explains came from a stale listener, and only restarting that session
 * fixes it.
 */
const VERSION = (() => {
  try {
    const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    return JSON.parse(readFileSync(join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '?'
  } catch { return '?' }
})()

/** Boards seen on an assignment but bound to nothing — the list `--bind` prints with no argument.
 *  Written beside the bindings for the same reason: any process must be able to find it. */
const unroutedFile = join(homedir(), '.rany-plugin', 'unrouted.json')

/** Remember a board nobody claimed, so silence does not mean the task was forgotten. Keyed by
 *  board: the newest sighting replaces the last, since what you need is "which board, and what was
 *  the most recent thing on it", not an audit log. */
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

/** `--bind` with no argument: what has been seen and never routed. */
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

/** `--bind <id>`: run in the repo that owns that work. The id may be a BOARD or a GUILD — a board is
 *  the precise unit, a guild claims everything in a server that is one project (and covers the guild
 *  conversations a board id can never match). Both live in the same map; a board binding wins. */
function bindBoard(boardId) {
  const boards = loadBindings()
  // Session-scoped when we know the session (the normal case); a bare directory string only on an
  // older Claude that does not export the id, which keeps the previous behaviour rather than losing
  // the binding entirely.
  boards[boardId] = sessionId
    ? { dir: projectDir, agent: 'claude', sessionId, ts: Date.now() }
    : projectDir
  try {
    mkdirSync(dirname(bindFile), { recursive: true })
    writeFileSync(bindFile, JSON.stringify({ boards }, null, 2))
    process.stdout.write(sessionId
      ? `RANY: ${boardId} is now handled in THIS session (${projectDir}). It stops when this session closes; re-run /rany-bind in another to move it.\n`
      : `RANY: ${boardId} is now handled in ${projectDir}\n`)
  } catch (e) {
    process.stdout.write(`RANY: could not save the binding (${e?.message ?? e})\n`)
  }
}

/** The boards THIS session claims — its own session-scoped entries, plus any legacy directory string
 *  pointing at this repo. Guild ids bound for conversations ride along harmlessly: a guild's default
 *  board carries the guild's own id, so what the server records is a board either way. */
function boardsHere() {
  return Object.entries(loadBindings())
    .filter(([, e]) => (typeof e === 'string' ? samePath(e, projectDir) : e?.sessionId === sessionId))
    .map(([id]) => id)
}

/** Drop every binding this session owns — SessionEnd, so a closed window stops being a wake target
 *  and RANY stops offering the persona for boards nothing can now pick up. Legacy directory strings
 *  are left alone: they are not this session's to remove. */
function dropMyBindings() {
  if (!sessionId) return
  const boards = loadBindings()
  let changed = false
  for (const [id, e] of Object.entries(boards))
    if (typeof e === 'object' && e?.sessionId === sessionId) { delete boards[id]; changed = true }
  if (!changed) return
  try { writeFileSync(bindFile, JSON.stringify({ boards }, null, 2)) } catch { /* best effort */ }
}

/**
 * Tell RANY which boards this checkout is handling.
 *
 * The binding is a file on this machine, so until now RANY had no way to know whether ANY runtime
 * was listening for a board's work — and offered every persona as an assignee on every board,
 * including boards where the card would simply never move. This is the other half of `--bind`.
 *
 * A heartbeat, not a registration: the server keeps a claim only while it is refreshed, so closing
 * the terminal stops offering a persona that can no longer do anything. Best-effort by design — an
 * older server has no such route, and a plugin that breaks when the server is behind is worse than
 * one whose personas stay listed.
 */
function declareBoards(boardIds, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!config.token) return resolve()
    let url
    try { url = new URL(`${config.apiUrl}/personas/@self/boards`) } catch { return resolve() }
    const body = JSON.stringify({ projectKey, boardIds })
    // node:http rather than fetch, for one reason: `--bind` and `--stop` call process.exit the
    // moment this resolves, and exiting after a fetch trips a libuv assertion on Windows
    // (`!(handle->flags & UV_HANDLE_CLOSING)`) — a crash banner after a command that in fact worked.
    // `agent: false` also means no keep-alive socket left idling, so the process can just end.
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
    req.on('error', () => resolve()) // offline, old server, no such route: not the listener's problem
    req.end(body)
  })
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

/** True when this process may run. One listener PER SESSION now (ADR-038): two windows in one repo
 *  each hold their own socket and wake only for what they bound. The pidfile is keyed by session, so
 *  the only holder we ever take over is our OWN previous process — the Stop hook respawns the
 *  listener every turn, and that respawn should replace the last one, never a sibling window's. */
function claimLock() {
  try {
    mkdirSync(dirname(pidFile), { recursive: true })
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      // Same session, previous turn's listener: replace it. (Without a session id the pidfile is
      // per-project, and this is the old take-the-repo-listener behaviour.)
      if (pid && pid !== process.pid && alive(pid)) {
        try { process.kill(pid) } catch { /* exited between check and here: fine */ }
      }
    }
    writeFileSync(pidFile, String(process.pid))
    return true
  } catch {
    return true // unwritable state dir: better a possible duplicate than a plugin that never runs
  }
}

/** Stamp this session as the machine's active window. The Stop hook respawns the listener at the end
 *  of every turn, so this runs once per turn and lands on whichever window the owner just used —
 *  which is who un-routable events (a persona DM) should wake. */
function markActive() {
  if (!sessionId) return
  try {
    mkdirSync(dirname(activeFile), { recursive: true })
    writeFileSync(activeFile, JSON.stringify({ sessionId, ts: Date.now() }))
  } catch { /* best effort */ }
}

function releaseLock() {
  try {
    if (!existsSync(pidFile)) return
    if (Number(readFileSync(pidFile, 'utf8').trim()) === process.pid) unlinkSync(pidFile)
  } catch { /* nothing to do */ }
}

/** Read before the early-exit commands below, because `--bind` and `--stop` both talk to RANY now
 *  (they declare and withdraw this checkout's board claims). */
const config = loadConfig()

/** `--bind <boardId>`: claim that board's tasks for THIS repository. */
const bindAt = process.argv.indexOf('--bind')
if (bindAt !== -1) {
  const boardId = process.argv[bindAt + 1]
  // No argument: show what has gone unrouted rather than erroring. That is the question someone
  // actually has when they reach for this command with nothing in hand.
  if (!boardId) { listUnrouted(); process.exit(QUIET) }
  if (!/^[0-9]+$/.test(boardId)) {
    process.stdout.write('RANY: --bind needs a board id (RANY → board header → ID), or no argument to list unrouted boards\n')
    process.exit(QUIET)
  }
  bindBoard(boardId)
  // Tell RANY straight away. Waiting for the next session start would leave the board looking
  // unhandled in the assignee picker right after someone deliberately bound it.
  await declareBoards(boardsHere())
  process.exit(QUIET)
}

/** `--stop`: SessionEnd asks this session's listener to go away, so a closed terminal leaves no
 *  socket AND no binding — ADR-038's "closing the window drops the bind, re-bind to move it". */
if (process.argv.includes('--stop')) {
  try {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid && alive(pid)) process.kill(pid)
      unlinkSync(pidFile)
    }
  } catch { /* already gone */ }
  // Drop this session's bindings and, if it held the active mark, release it. With the window closed
  // nothing here would pick a task up, so the persona must stop being offered for its boards.
  dropMyBindings()
  try { if (activeSessionId() === sessionId) unlinkSync(activeFile) } catch { /* fine */ }
  // Withdraw this session's board claims from RANY. They also expire on their own — this just makes
  // closing a terminal immediate instead of eventual.
  await declareBoards([], 2000)
  process.exit(QUIET)
}

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
markActive() // this window just started or finished a turn — it is the one to wake for un-routable events

const OP = { Dispatch: 0, Hello: 1, Identify: 2, Heartbeat: 3, Resume: 6, InvalidSession: 9 }

let personaUserId = null
let ownerUserId = null
let personaName = null   // from READY; the name every post is attributed to
let heartbeat = null
let claimBeat = null
let socket = null

const done = (code, text) => {
  if (text) process.stdout.write(text + '\n')
  if (heartbeat) clearInterval(heartbeat)
  if (claimBeat) clearInterval(claimBeat)
  try { socket?.close() } catch { /* closing anyway */ }
  releaseLock()
  process.exit(code)
}

/** Board claims are refreshed on this cadence while a session is open. Well under the server's
 *  freshness window, so one missed beat (a suspended laptop, a blip) does not drop the claim. */
const CLAIM_REFRESH_MS = 5 * 60_000

process.on('SIGTERM', () => done(QUIET))
process.on('SIGINT', () => done(QUIET))
setTimeout(() => done(QUIET), config.maxMinutes * 60_000).unref()

/** Who the session speaks as. Every wake-up carries it, because a session that is not told signs
 *  as the model underneath ("— Claude (AI)") under a comment RANY already labels with the persona's
 *  name — and a commit made for the task then credits the model too. */
function asPersona() {
  const who = personaName ? `the persona "${personaName}"` : 'your persona'
  return [
    `You act as ${who}. RANY attributes posts and comments to that name by itself: do not sign`,
    `them, and never name the model underneath ("Claude", "— AI"). A commit made for RANY work is`,
    `${who}'s as well — author or Co-Authored-By ${personaName ?? 'the persona'} <noreply@rany.work>.`,
  ].join('\n')
}

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
    // BOARD ONLY. There is deliberately no guild fallback here, and the reason is a trap in the data:
    // a guild's DEFAULT board carries the guild's own id (`tasks.task_boards.id = guild_id` for it).
    // So "I bound the board" and "I bound the server" are the same keystrokes, and a guild fallback
    // would make binding the default board silently claim every board added to that server later —
    // waking a repository with work it never claimed, which is the exact complaint board routing
    // exists to answer. A second board is a second project until someone says otherwise.
    const boardId = String(d.boardId ?? '')
    const boundTo = claimedBy(boardId)

    // ONLY the session that bound this board. An unbound board wakes nobody at all — not "everybody
    // once". And a board bound in ANOTHER session stays that session's, even in this same repo:
    // that is the whole of ADR-038, the thing that makes "which of my windows wakes" answerable.
    //
    // Nothing is lost when unbound: the sighting is recorded, and `/rany-bind` with no argument
    // prints what has been seen and never routed. Silence here is not the same as forgetting.
    if (!ownedHere(boundTo)) {
      if (!boundTo) noteUnrouted(boardId, guildId, d)
      const why = !boundTo ? 'skip (unbound)'
        : entrySession(boundTo) ? `skip (bound to session ${entrySession(boundTo)})`
        : `skip (owned by ${entryDir(boundTo)})`
      logRoute('TASK_UPDATED', { boardId, guildId }, why)
      return null
    }
    logRoute('TASK_UPDATED', { boardId, guildId }, 'wake')

    return [
      `RANY: a task was assigned to your persona.`,
      `  task ${d.id} in guild ${guildId} — "${d.title ?? '(untitled)'}"`,
      ``,
      `Read it with the rany MCP tool get_task({guildId:"${guildId}", taskId:"${d.id}"}), do the work`,
      `in this project, report what you did with comment_task, and move the card with`,
      `set_task_status (get_task lists the board's statuses and their categories). If it is not`,
      `about this project, say so in the comment instead of guessing.`,
      ``,
      asPersona(),
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
      ``,
      asPersona(),
    ].join('\n')
  }

  if (type !== 'MESSAGE_CREATED') return null

  const recipients = Array.isArray(d.recipientIds) ? d.recipientIds : []
  const mentions = Array.isArray(d.mentions) ? d.mentions : []
  const isGuild = typeof d.guildId === 'string' && d.guildId.length > 0

  // A guild message belongs to a guild, and a guild can be CLAIMED by a repository. If it is, only
  // that repository hears it; every other session stays quiet.
  //
  // This was the hole the board routing left open. Tasks were routed and messages were not, on the
  // reasoning that a message is "a conversation, not work on a repository, so any open session can
  // answer". That reasoning does not survive contact: someone writing to your persona in a project's
  // guild — a question about a task, a review request — IS that project's work, and answering it from
  // an unrelated checkout is the same interruption, with the same session that cannot tell.
  //
  // Unclaimed guilds keep the old behaviour deliberately: if no repository has said "this server is
  // mine", any session may answer, because a conversation nobody claims is better answered than
  // dropped. Silence is only the right default once someone has claimed the work.
  if (isGuild) {
    const owner = claimedBy(d.guildId)
    if (owner && !ownedHere(owner)) {
      const why = entrySession(owner) ? `skip (bound to session ${entrySession(owner)})` : `skip (owned by ${entryDir(owner)})`
      logRoute('MESSAGE_CREATED', { guildId: d.guildId, channelId: d.channelId }, why)
      return null
    }
    // An unclaimed guild is answered only by the window you are sitting in — with one listener per
    // session now, "any session may answer" would mean every session answering the same message.
    if (!owner && !isActiveSession()) {
      logRoute('MESSAGE_CREATED', { guildId: d.guildId, channelId: d.channelId }, 'skip (guild unclaimed, not active session)')
      return null
    }
    logRoute('MESSAGE_CREATED', { guildId: d.guildId, channelId: d.channelId },
      owner ? 'wake' : 'wake (guild unclaimed)')
  }

  // The persona is itself a member of the conversation: a session with your owner, or a group DM
  // it was added to. Always its own conversation, never eavesdropping.
  if (!isGuild && recipients.includes(personaUserId)) {
    if (!config.wake.sessions) return null
    // A DM carries no board and no guild, so there is nothing to route it BY. It goes to the window
    // the owner is sitting in — the active session — and to that one only; with a listener per
    // session, anything else would wake every open window for one message.
    if (!isActiveSession()) {
      logRoute('MESSAGE_CREATED', { channelId: d.channelId }, 'skip (persona DM, not active session)')
      return null
    }
    // Only the persona's OWN chat with its owner may wake a coding session. A conversation somebody
    // else opened with the persona (ADR-037) must not: waking this session hands a stranger the
    // repository, the shell and the tools. Those are answered by a hosted persona on the server, or
    // not at all — "no code access" has to be a rule in the runtime, not a hope about who talks.
    if (!(ownerUserId && recipients.length === 2 && recipients.includes(ownerUserId))) {
      logRoute('MESSAGE_CREATED', { channelId: d.channelId, recipients }, 'skip (not the owner own chat)')
      return null
    }
    // ...unless RANY's own notification bot wrote it. Those DMs mirror events the gateway ALREADY
    // delivered (a task assignment arrives as TASK_UPDATED, which is routed by board), so waking on
    // them announces the same thing twice — and, being a DM rather than a guild event, the second
    // copy carries no board and cannot be routed at all. That is how one assignment came to wake
    // every open session on the machine while the task itself was routed correctly: the notice and
    // the routing were two different events. A notification is not a conversation.
    if (String(d.authorId ?? '') === SYSTEM_BOT_ID) {
      logRoute('MESSAGE_CREATED', { channelId: d.channelId, authorId: d.authorId }, 'skip (notification bot)')
      return null
    }
    return [
      `RANY: a message in your persona's own chat (channel ${d.channelId}).`,
      `  user ${d.authorId}: ${d.content ?? ''}`,
      ``,
      `Reply with post_message({channelId:"${d.channelId}", content:"…"}).`,
      ``,
      asPersona(),
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
      ``,
      asPersona(),
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
    if (frame.t === 'READY') {
      personaUserId = String(frame.d?.userId ?? '') || null
      personaName = String(frame.d?.persona?.displayName ?? '').trim() || null
      // Who the persona belongs to. Needed to tell the persona's OWN chat from a conversation some
      // third party opened with it — see the DM branch, where that distinction is the whole of
      // "a stranger must never reach your code".
      ownerUserId = String(frame.d?.persona?.ownerUserId ?? '') || null
      // Authenticated and listening → this checkout is genuinely handling its boards. Declared here
      // rather than at startup so a persona is never advertised on the strength of a token that the
      // gateway then refuses (paused, revoked, or hosted).
      void declareBoards(boardsHere())
      if (claimBeat) clearInterval(claimBeat)
      claimBeat = setInterval(() => void declareBoards(boardsHere()), CLAIM_REFRESH_MS)
      claimBeat.unref?.()
      return
    }
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
