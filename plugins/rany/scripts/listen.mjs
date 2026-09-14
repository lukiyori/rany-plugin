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

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
 *  listener, which stamps this). Guild events nobody has claimed wake only this session, the window
 *  the owner is actually sitting in — with one listener per session, "any session may answer" would
 *  mean every session answering. (The persona's DMs used to route here too; they are hosted-only
 *  since ADR-044.) */
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
/**
 * Cards handed to a work-room seat (MCP assign_task, ADR-046): taskId → seat id. Every agent is the same
 * persona, so the assignment event alone would wake the session that bound the card's BOARD — the wrong
 * agent, or nobody for a seat that joined by link. The handoff event names the seat and always arrives
 * first; whichever runtime hears it records it here (shared with the Codex bridge), and the assignment
 * and later comments on that card follow the seat instead of the board.
 */
const taskSeatsFile = join(homedir(), '.rany-plugin', 'task-seats.json')
function taskSeatOf(taskId) {
  try { return JSON.parse(readFileSync(taskSeatsFile, 'utf8'))[String(taskId)] ?? null } catch { return null }
}
function noteTaskSeat(taskId, agentId) {
  if (!taskId || !agentId) return
  let map = {}
  try { map = JSON.parse(readFileSync(taskSeatsFile, 'utf8')) } catch { /* first handoff */ }
  delete map[String(taskId)]          // re-insert, so the newest handoffs are the ones kept
  map[String(taskId)] = String(agentId)
  const keys = Object.keys(map)
  for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete map[k]
  try { mkdirSync(dirname(taskSeatsFile), { recursive: true }); writeFileSync(taskSeatsFile, JSON.stringify(map)) }
  catch { /* unwritable: the card routes by board, as before */ }
}

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
async function bindBoard(boardId) {
  // Resolve the human names first, so the binding carries "General (Rany)" — legible in the file, in
  // the confirmation, and in the next session's re-bind reminder — not a bare number.
  const info = await fetchBoardInfo(boardId)
  const boards = loadBindings()
  // Session-scoped when we know the session (the normal case); a bare directory string only on an
  // older Claude that does not export the id, which keeps the previous behaviour rather than losing
  // the binding entirely.
  boards[boardId] = sessionId
    ? { dir: projectDir, agent: 'claude', sessionId, ts: Date.now(),
        boardName: info?.name ?? null, guildName: info?.guildName ?? null }
    : projectDir
  try {
    mkdirSync(dirname(bindFile), { recursive: true })
    writeFileSync(bindFile, JSON.stringify({ boards }, null, 2))
    recordHistory(boardId, info)
    const label = info?.name
      ? (info.guildName ? `${info.name} (${info.guildName})` : info.name)
      : `board ${boardId}`
    process.stdout.write(sessionId
      ? `RANY: ${label} is now handled in THIS session (${projectDir}). It stops when this session closes; re-run /rany-bind in another to move it.\n`
      : `RANY: ${label} is now handled in ${projectDir}\n`)
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

/** A durable, per-repository record of every board ever bound here, WITH its human names. Unlike a
 *  binding (which is session-scoped and dies with the window), this survives — so a fresh session can
 *  open and say "this repo has handled General (Rany) and Tasks (Cocktail) before — re-bind them?"
 *  instead of leaving you to remember the numbers. Keyed by normalized repo dir. */
const historyFile = join(homedir(), '.rany-plugin', 'board-history.json')

function loadHistory() {
  try { return JSON.parse(readFileSync(historyFile, 'utf8')).repos ?? {} } catch { return {} }
}

/** Remember (or refresh) a board bound in THIS repo, with the names resolved at bind time. */
function recordHistory(boardId, info) {
  const repos = loadHistory()
  const key = norm(projectDir)
  const boards = repos[key] ?? {}
  boards[String(boardId)] = {
    boardName: info?.name ?? null,
    guildName: info?.guildName ?? null,
    guildId: info?.guildId ?? null,
    dir: projectDir,
    lastBound: new Date().toISOString(),
  }
  repos[key] = boards
  try {
    mkdirSync(dirname(historyFile), { recursive: true })
    writeFileSync(historyFile, JSON.stringify({ repos }, null, 2))
  } catch { /* best effort — the binding itself still saved */ }
}

/** This repo's remembered boards. */
const historyForRepo = () => Object.entries(loadHistory()[norm(projectDir)] ?? {})

/** A board's human label for a message: "General (Rany)" when known, else the bare id. */
function boardLabel(boardId, h) {
  const name = h?.boardName, space = h?.guildName
  if (name && space) return `${name} (${space}) — board ${boardId}`
  if (name) return `${name} — board ${boardId}`
  return `board ${boardId}`
}

/** Resolve a board id to its name + space via the persona token (server ADR: GET
 *  /personas/@self/boards/{id}). Best-effort: an older server, offline, or no access yields null and
 *  the binding is stored by id alone. Uses node:http like declareBoards so `--bind` can exit cleanly. */
function fetchBoardInfo(boardId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!config.token) return resolve(null)
    let url
    try { url = new URL(`${config.apiUrl}/personas/@self/boards/${boardId}`) } catch { return resolve(null) }
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    const req = send(url, {
      method: 'GET', agent: false, timeout: timeoutMs,
      headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null) }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve(null) } })
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
}

/** GET JSON with the persona token → the parsed body, or null (offline, unconfigured, not 200). */
function getJson(path, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!config.token) return resolve(null)
    let url
    try { url = new URL(`${config.apiUrl}${path}`) } catch { return resolve(null) }
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    const req = send(url, {
      method: 'GET', agent: false, timeout: timeoutMs,
      headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null) }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve(null) } })
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
}

/**
 * The persona's HOME (ADR-047): the one session its owner chose to BE the persona. Conversations —
 * being addressed in a channel, forwards, workflow steps and questions no board claims — wake the home
 * and nothing else; while it is closed RANY's hosted brain answers them (when a model key is stored),
 * and without a key nobody does. There is no "the window you typed in last" any more: that is how a
 * work-room question got answered from an unrelated repository. Asked of the server on each such
 * event, so a home moved or cleared from the web takes effect at once.
 */
async function homeIsHere() {
  const h = (await getJson('/personas/@self/home'))?.home
  return Boolean(h && h.agent === 'claude' && h.live && sessionId && h.ref === sessionId)
}

/** Make THIS session the persona's home — `/rany-home`, via the prompt hook or `--home`. */
async function setHome(sid = sessionId) {
  if (!sid) return 'RANY: could not tell which session this is — type /rany-home inside the session itself.'
  const r = await postJson('/personas/@self/home', { agent: 'claude', ref: sid, label: projectDir })
  if (!r) return 'RANY: could not reach RANY to set the home — check RANY_API_URL / RANY_PERSONA_TOKEN.'
  if (!r.ok) return `RANY: the home was refused (${r.body?.error ?? r.status}).`
  return [
    `RANY: this session is now your persona's home (${projectDir}).`,
    `Being addressed in a channel, forwards and workflow steps wake THIS session and no other. While it`,
    `is closed, RANY's hosted AI answers them if a model key is stored — otherwise they go unanswered.`,
    `Move it with /rany-home in another session, or clear it in RANY → persona settings.`,
  ].join('\n')
}

/** POST JSON with the persona token → `{ ok, status, body }`, or null when offline / unconfigured.
 *  node:http like declareBoards, so a command can exit right after it resolves. */
function postJson(path, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!config.token) return resolve(null)
    let url
    try { url = new URL(`${config.apiUrl}${path}`) } catch { return resolve(null) }
    const body = JSON.stringify(payload)
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    const req = send(url, {
      method: 'POST', agent: false, timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Bearer ${config.token}`,
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { text += d })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(text) } catch { /* not JSON */ }
        resolve({ ok: res.statusCode === 200, status: res.statusCode, body: parsed })
      })
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end(body)
  })
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
function declareBoards(boardIds, timeoutMs = 5000, extra = {}) {
  return new Promise((resolve) => {
    if (!config.token) return resolve()
    let url
    try { url = new URL(`${config.apiUrl}/personas/@self/boards`) } catch { return resolve() }
    // `ref` names this session, so the same heartbeat keeps the persona's home live when it is this
    // session (ADR-047); `closing` (SessionEnd) makes it stop being live at once.
    const body = JSON.stringify({ projectKey, boardIds, ref: sessionId ?? undefined, ...extra })
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
    // Which events are worth interrupting you for. All of these are things addressed TO your
    // persona in a guild or a board; `ownerMentions` is it overhearing a mention of you, which is a
    // firehose in a busy guild and is off unless you ask for it. There is deliberately no switch for
    // the persona's own chats: those are answered on the server (ADR-044), and reach this session
    // only as an `ask` — a question its chat brain could not answer without the code (ADR-045). A
    // `sessions` or `ownerDms` key left in the file is accepted and ignored.
    wake: {
      tasks: true, comments: true, addressed: true, forwards: true, workflows: true, asks: true,
      ownerMentions: false,
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

/** The re-bind reminder is shown ONCE per session (a binding is session-scoped, so every fresh window
 *  starts owning nothing — but nagging it every turn would be unbearable). Marked per session id. */
const remindedFile = join(projectState, 'reminded.json')
function alreadyReminded(sid) {
  try { return JSON.parse(readFileSync(remindedFile, 'utf8'))[sid] === true } catch { return false }
}
function markReminded(sid) {
  let m = {}
  try { m = JSON.parse(readFileSync(remindedFile, 'utf8')) } catch { /* first */ }
  m[sid] = true
  try { mkdirSync(dirname(remindedFile), { recursive: true }); writeFileSync(remindedFile, JSON.stringify(m)) }
  catch { /* unwritable: it reminds again next turn, which beats never */ }
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
  await bindBoard(boardId)
  // Tell RANY straight away. Waiting for the next session start would leave the board looking
  // unhandled in the assignee picker right after someone deliberately bound it.
  await declareBoards(boardsHere())
  process.exit(QUIET)
}

/** A work-room invite link — or its bare `/join-room/<code>` path — anywhere in some text → its code. */
function inviteCodeIn(text) {
  const m = /\/join-room\/([A-Za-z0-9]{8,64})\b/.exec(String(text ?? ''))
  return m ? m[1] : null
}

/** What a hook pipes on stdin (`prompt`, `session_id`, `cwd`, …), read with a deadline — a hand-run
 *  command from a shell whose stdin never closes must not hang. */
function readHookInput(ms = 700) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({})
    let raw = ''
    const parse = () => { try { return raw.trim() ? JSON.parse(raw) : {} } catch { return {} } }
    const timer = setTimeout(() => resolve(parse()), ms)
    const finish = () => { clearTimeout(timer); resolve(parse()) }
    try {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (d) => { raw += d })
      process.stdin.on('end', finish)
      process.stdin.on('error', finish)
    } catch { finish() }
  })
}

const JOIN_REFUSALS = {
  invalid_invite: 'that invite link is not valid',
  invite_used: 'that link was already used — ask the owner for a new one',
  invite_expired: 'that link expired — ask the owner for a new one',
  not_your_room: 'that room belongs to another persona',
  room_full: 'the room is full',
  persona_not_active: 'the persona is paused',
}

/**
 * Take a seat in a work room (ADR-046) from an invite code: RANY seats this persona's agent and answers
 * with the SEAT, which is bound to the session exactly like a board — so room events for that seat wake
 * this window and no other. No board has to exist, be bound or be chosen. Shared by `--join` (typed)
 * and the UserPromptSubmit hook (the link simply pasted into the chat). Returns the text to show.
 */
async function joinSeat(code, sid = sessionId) {
  const boards = loadBindings()
  const held = Object.entries(boards).find(([, e]) => e && typeof e === 'object' && e.room?.invite === code)
  if (held && sid && held[1].sessionId === sid)
    return `RANY: this session already sits in that work room (channel ${held[1].room.channelId}) as "${held[1].room.name}" — agentId ${held[0]}.`
  const res = await postJson('/personas/@self/rooms/join',
    { code, name: `${basename(projectDir)} · Claude`.slice(0, 40), agent: 'claude' }, 6000)
  if (!res?.ok)
    return `RANY: could not join the work room — ${JOIN_REFUSALS[res?.body?.error] ?? `the server refused (${res?.status ?? 'offline'})`}.`
  const seat = res.body
  boards[seat.agentId] = sid
    ? { dir: projectDir, agent: 'claude', sessionId: sid, ts: Date.now(),
        room: { channelId: seat.channelId, guildId: seat.guildId, name: seat.name, invite: code } }
    : projectDir
  try {
    mkdirSync(dirname(bindFile), { recursive: true })
    writeFileSync(bindFile, JSON.stringify({ boards }, null, 2))
  } catch (e) {
    return `RANY: joined the work room, but could not save the seat binding (${e?.message ?? e}).`
  }
  // Declared with the boards, so the room shows this seat as live straight away.
  await declareBoards(boardsHere())
  return [
    `RANY: THIS session joined the work room at channel ${seat.channelId} as "${seat.name}" (agentId ${seat.agentId}).`,
    `From now on it is woken for that room, until this session closes.`,
    `Next: get_room({channelId:"${seat.channelId}"}) and read the brief documents it lists; then tell the room in ONE`,
    `line which part of the job you take — post_message({channelId:"${seat.channelId}", agentId:"${seat.agentId}", content:"…"}).`,
  ].join('\n')
}

/** `--home`: make THIS session the persona's home (ADR-047) — /rany-home's fallback when the prompt hook
 *  did not already do it. */
if (process.argv.includes('--home')) {
  process.stdout.write((await setHome(sessionId ?? activeSessionId())) + '\n')
  process.exit(QUIET)
}

/** `--join <link|code>`: the same, typed by hand (the /rany-join command). */
const joinAt = process.argv.indexOf('--join')
if (joinAt !== -1) {
  const raw = String(process.argv[joinAt + 1] ?? '').trim()
  const code = inviteCodeIn(raw) ?? (/^[A-Za-z0-9]{8,64}$/.test(raw) ? raw : null)
  if (!code) {
    process.stdout.write('RANY: --join needs the work-room invite link (RANY → the room → Invite agent)\n')
    process.exit(QUIET)
  }
  process.stdout.write((await joinSeat(code)) + '\n')
  process.exit(QUIET)
}

/**
 * UserPromptSubmit: a work-room invite link PASTED into the chat joins the room by itself. The link is a
 * web address — nothing in a coding session understands it on its own, and the agent fetching it would
 * only find a page telling it to paste the link into a session. So the plugin reads the prompt before
 * the model does, joins, and hands the model the seat as context. No link in the prompt = no work, no
 * network, no output: this runs on every prompt.
 */
if (process.argv.includes('--prompt')) {
  const hook = await readHookInput()
  // `/rany-home` makes THIS session the persona's home (ADR-047). Done here rather than by the command
  // alone because the hook knows the session for certain; the command's own run is the fallback.
  if (/^\s*\/rany(?::rany)?-home\b/i.test(String(hook.prompt ?? '')) && config.token) {
    const homeSid = sessionId ?? (typeof hook.session_id === 'string' && hook.session_id ? hook.session_id : null)
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: await setHome(homeSid) },
    }) + '\n')
    process.exit(QUIET)
  }
  const code = inviteCodeIn(hook.prompt)
  if (code && config.token) {
    const sid = sessionId ?? (typeof hook.session_id === 'string' && hook.session_id ? hook.session_id : null)
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: await joinSeat(code, sid) },
    }) + '\n')
  }
  process.exit(QUIET)
}

/**
 * `--beat` (PostToolUse, async): keep this session's claims fresh WHILE it works. The listener only runs
 * between turns — it exits to wake the session and is re-spawned by Stop — so a long turn let every claim
 * lapse and the room showed a busy agent as "session closed". Throttled to one declare per refresh
 * interval; every other tool call costs a stat and nothing else.
 */
if (process.argv.includes('--beat')) {
  const mark = join(stateDir, `beat-${sessionId ?? projectKey}`)
  let last = 0
  try { last = statSync(mark).mtimeMs } catch { /* never beaten */ }
  if (config.token && Date.now() - last >= 5 * 60_000) { // CLAIM_REFRESH_MS, declared further down
    try { mkdirSync(stateDir, { recursive: true }); writeFileSync(mark, '') } catch { /* beats again next call */ }
    const boards = boardsHere()
    await declareBoards(boards) // even with no boards: it is also the persona home's heartbeat (ADR-047)
  }
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
  await declareBoards([], 2000, { closing: true })
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

// Re-bind reminder (once per session): this repo has handled boards before, but a session-scoped
// binding dies with its window, so a fresh session owns nothing until you say so. Rather than leave
// you to remember which boards and their numbers, list them by name and hand over the one-liners.
if (sessionId && !alreadyReminded(sessionId)) {
  const mineNow = new Set(boardsHere())
  const forgotten = historyForRepo().filter(([id]) => !mineNow.has(id))
  if (forgotten.length > 0) {
    markReminded(sessionId)
    const msg = [
      `RANY: this repo has handled these boards before, but none are bound to THIS session:`,
      ...forgotten.map(([id, h]) => `  • ${boardLabel(id, h)}`),
      ``,
      `A binding belongs to one session and does not carry over. To handle them here, run:`,
      ...forgotten.map(([id]) => `  /rany-bind ${id}`),
    ].join('\n')
    process.stdout.write(msg + '\n')
    process.exit(WAKE)
  }
  markReminded(sessionId) // nothing to remind, but don't recompute every turn
}

if (!claimLock()) process.exit(QUIET)
markActive() // this window just started or finished a turn — it is the one to wake for un-routable events

const OP = { Dispatch: 0, Hello: 1, Identify: 2, Heartbeat: 3, Resume: 6, InvalidSession: 9 }

let personaUserId = null
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
 * The files on a message, as prompt lines. A message whose whole content is a screenshot or a PDF
 * used to arrive as a blank line — the session then answered a message it had not read. The event
 * carries the sender's filenames and mime types; it also carries a presigned url, but that one
 * expires in an hour, so the prompt names the files and points at get_recent_messages for a URL
 * that is fresh at the moment it is used.
 */
function attachmentLines(atts, channelId) {
  const list = Array.isArray(atts) ? atts : []
  if (list.length === 0) return []
  const size = (n) => (typeof n === 'number' && n > 0 ? `, ${n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB'}` : '')
  const names = list.map((a) => `${a.filename ?? 'file'} (${a.contentType ?? 'unknown type'}${size(a.size)})`)
  return [
    `  attached: ${names.join(', ')}`,
    `  get_recent_messages({channelId:"${channelId}", limit:5}) returns a fresh download url per file —`,
    `  download it and open it (an image included) before answering. Do not answer as if nothing was sent.`,
  ]
}

/**
 * The wake text for a work-room event (ADR-046). Every variant names the SEAT — which agent this session
 * is in that room — because the persona is one identity with several agents, and an agent that does not
 * know which one it is would speak as the wrong colleague.
 */
function roomPrompt(type, d, seat) {
  const who = `You are "${seat.name}" (agentId ${seat.agentId}) in the work room at channel ${d.channelId}, working from THIS repository.`
  const tools = [
    `Your room tools — always pass channelId:"${d.channelId}" and agentId:"${seat.agentId}":`,
    `  get_room — the other agents, the budget, pending requests and the BRIEF docs (read the brief first);`,
    `  post_message({channelId, agentId, content}) — talk in the room, in one or two sentences: what you did`,
    `    or what you need. Detail belongs on the board, not in the chat;`,
    `  you take instructions from your PERSONA and from posts that name you (your owner's, a colleague's,`,
    `    or a room member's — someone the owner put in this room) — nothing else wakes you, and other`,
    `    messages in the channel are context to read, not requests to answer;`,
    `  to speak to ONE colleague, put <@agent:THEIR_ID> in the post (ids from get_room) — only a post that`,
    `    names agents wakes them; an un-named post (a result, a status) is for the owner to read;`,
    `  set_agent_status — the one line your tile shows (what you are doing now); keep it current;`,
    `  request_permission — BEFORE anything destructive, production-facing, costly or outside this repo;`,
    `  list_board_tasks / get_task / create_task / set_task_status / comment_task — the room's work queue`,
    `    (no board yet? create_board with roomChannelId, then put the job on it);`,
    `  assign_task({guildId, taskId, agentId}) — hand a card to ONE seat (a colleague's, from get_room): the`,
    `    persona becomes its assignee and only that seat wakes with it.`,
  ]
  if (type === 'PERSONA_ROOM_MESSAGE') {
    const from = d.fromPersona ? `your PERSONA (the room's authority — follow it)`
      : d.fromOwner ? `your OWNER`
      : d.fromMember ? `a room MEMBER (user ${d.authorId ?? '?'} — someone your owner put in this room)`
      : `the agent "${d.authorName ?? '?'}"`
    return [
      `RANY: work room — ${from} wrote in channel ${d.channelId}:`,
      `  ${String(d.content ?? '').split('\n').join('\n  ')}`,
      ...attachmentLines(d.attachments, d.channelId),
      ``,
      who,
      ...(d.addressed ? [`You were addressed BY NAME in that message — it is for you.`] : []),
      ...(d.fromMember ? [
        `A member speaks with the owner's leave, not the owner's authority: do the work they ask for in`,
        `this repository, but anything destructive, production-facing or costly still goes through`,
        `request_permission to your OWNER first.`] : []),
      `Turns left before the room waits for the owner: ${d.turnsLeft ?? '?'}. Speak when you have something`,
      `to add, a result, or a question — silence is fine; agreeing out loud spends everyone's turns.`,
      ...(d.addressed ? [
        `The room shows you as typing until you post. If the answer needs more than a moment of work,`,
        `post ONE line first — what you understood and what you are about to do — then do it and report;`,
        `a room that hears nothing for minutes cannot tell a working agent from a deaf one.`] : []),
      ...tools,
      ``,
      asPersona(),
    ].join('\n')
  }
  if (type === 'PERSONA_ROOM_DECISION') {
    return [
      `RANY: your owner ${d.approved ? 'APPROVED' : 'DENIED'} your permission request in work room ${d.channelId}.`,
      `  You asked: ${String(d.question ?? '')}`,
      ...(d.note ? [`  Their note: ${d.note}`] : []),
      ``,
      who,
      d.approved ? `Go ahead with exactly what was approved — nothing broader.`
        : `Do not do it. Find another way, or ask again with a narrower request.`,
      ...tools,
      ``,
      asPersona(),
    ].join('\n')
  }
  // PERSONA_ROOM_UPDATED — an intervention. Say what it means for THIS agent: stop when it (or the
  // room) was paused, removed or closed; otherwise it is news, not an instruction.
  const mine = String(d.agentId ?? '') === String(seat.agentId)
  const stop = d.change === 'room_paused' || d.change === 'closed'
    || (mine && (d.change === 'agent_paused' || d.change === 'agent_removed'))
  const what = {
    agent_joined: mine ? 'you were invited into this room' : 'a new agent joined the room',
    agent_renamed: mine ? `your seat is now called "${seat.name}"` : 'an agent was renamed',
    agent_paused: mine ? 'the owner PAUSED your seat' : 'the owner paused an agent',
    agent_resumed: mine ? 'the owner resumed your seat' : 'the owner resumed an agent',
    agent_removed: mine ? 'the owner REMOVED you from the room' : 'the owner removed an agent',
    room_paused: 'the owner PAUSED the whole room',
    room_resumed: 'the owner resumed the room (fresh turn budget)',
    budget: 'the owner changed the turn budget',
    board: "the room's board changed",
    budget_exhausted: 'the room used up its turn budget and is waiting for the owner',
    closed: 'the owner CLOSED the room',
    task_assigned: mine ? `card #${d.taskNumber ?? '?'} "${d.taskTitle ?? ''}" was handed to YOU` : 'a card was handed to an agent',
  }[d.change] ?? `the room changed (${d.change})`
  const next = stop
    ? [`STOP working on this room's job now and do not post there until you are resumed. Leave what you`,
       `were doing in a safe state${d.change === 'agent_removed' || d.change === 'closed' ? '.' : ' and say so in your status line.'}`]
    : d.change === 'budget_exhausted' ? [`Do not post in the room until the owner writes there again.`]
    : d.change === 'agent_joined' && mine ? [`Read the brief (get_room), then tell the room in one line which part you take.`]
    : d.change === 'task_assigned' && mine ? [
        `It is yours now (the persona is its assignee and the card is recorded as your seat's). Read it with`,
        `get_task({guildId:"${d.taskGuildId}", taskId:"${d.taskId}"}), do it in this repository, report on the card`,
        `with comment_task, move it with set_task_status, and say in one room line that you took it.`]
    : [`Nothing to do unless it changes your part of the job.`]
  return [`RANY: work room ${d.channelId} — ${what}.`, ``, who, ...next, ...tools, ``, asPersona()].join('\n')
}

/**
 * What this event means for the persona, or null to keep waiting. The gateway already decides what
 * a persona may hear (owner-resolved visibility, guild opt-out, persona_depth), so this only sorts
 * what arrives into "worth waking you" and "not".
 */
async function classify(type, d) {
  if (type === 'TASK_UPDATED') {
    const added = Array.isArray(d.addedAssigneeIds) ? d.addedAssigneeIds : []
    if (!config.wake.tasks || !added.includes(personaUserId)) return null
    // A private board's payload drops guildId so the gateway cannot fan it guild-wide, and carries
    // the same value as taskGuildId for addressing (db/0242).
    const guildId = String(d.guildId ?? d.taskGuildId ?? '')

    // Handed to a work-room seat (assign_task): the handoff already woke THAT seat's session, so the
    // board's session must not wake for the same card.
    const handedTo = taskSeatOf(d.id)
    if (handedTo) {
      logRoute('TASK_UPDATED', { taskId: d.id, agentId: handedTo }, 'skip (handed to a room seat)')
      return null
    }

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

  // A COMMENT on a task this persona is ASSIGNED to (the gateway only delivers those, and never the
  // persona's own comment — db/0312). Routed by board like the assignment, so it wakes the session
  // that bound the board and no other. This is the follow-up channel: an answer to a question the
  // persona asked, or "also do X" on a task it already owns.
  if (type === 'TASK_COMMENT_CREATED') {
    if (!config.wake.comments) return null
    const guildId = String(d.guildId ?? d.taskGuildId ?? '')
    const boardId = String(d.boardId ?? '')
    // A card handed to a room seat (assign_task) talks to that seat, not to the board's session.
    const seatId = taskSeatOf(d.taskId)
    const boundTo = seatId ? claimedBy(seatId) : claimedBy(boardId)
    if (!ownedHere(boundTo)) {
      const why = !boundTo ? 'skip (unbound)'
        : entrySession(boundTo) ? `skip (bound to session ${entrySession(boundTo)})`
        : `skip (owned by ${entryDir(boundTo)})`
      logRoute('TASK_COMMENT_CREATED', { boardId, guildId }, why)
      return null
    }
    logRoute('TASK_COMMENT_CREATED', { boardId, guildId }, 'wake')
    const c = d.comment ?? {}
    return [
      `RANY: a new comment on a task assigned to your persona.`,
      `  task ${d.taskId} in guild ${guildId} — comment by user ${c.authorId ?? '?'}:`,
      `  ${c.content ?? ''}`,
      ``,
      `Re-read the task with get_task({guildId:"${guildId}", taskId:"${d.taskId}"}) — the full comment`,
      `thread and current state — then do what the comment asks in this project, reply with`,
      `comment_task, and move the card with set_task_status if the state changed.`,
      ``,
      asPersona(),
    ].join('\n')
  }

  // A guild WORKFLOW handed this persona a step (ADR-040): the prompt is the work, and the answer
  // goes back through complete_workflow_step — never into a channel by itself, the workflow decides
  // where the output lands. Routed like a guild message: a claimed guild wakes its session, an
  // unclaimed one wakes the window you are sitting in.
  if (type === 'PERSONA_WORKFLOW') {
    if (!config.wake.workflows) return null
    const guildId = String(d.guildId ?? '')
    const owner = claimedBy(guildId)
    if (owner && !ownedHere(owner)) {
      const why = entrySession(owner) ? `skip (bound to session ${entrySession(owner)})` : `skip (owned by ${entryDir(owner)})`
      logRoute('PERSONA_WORKFLOW', { guildId, stepId: d.stepId }, why)
      return null
    }
    if (!owner && !(await homeIsHere())) {
      logRoute('PERSONA_WORKFLOW', { guildId, stepId: d.stepId }, 'skip (guild unclaimed, not the persona home)')
      return null
    }
    logRoute('PERSONA_WORKFLOW', { guildId, stepId: d.stepId }, 'wake')
    const msgs = Array.isArray(d.messages) ? d.messages : []
    const context = msgs.length
      ? ['', 'Recent messages of the channel this step is about:',
         ...msgs.map((m) => `  [${m.createdAt ?? ''}] user ${m.authorId ?? '?'}: ${m.content ?? ''}`)]
      : []
    return [
      `RANY: the workflow "${d.workflowName ?? d.workflowId}" in guild ${guildId} is running a step through your persona.`,
      `  step ${d.stepId} (run ${d.runId}) — answer within ${d.timeoutMinutes ?? 30} minutes or the run fails.`,
      `  Prompt:`,
      `  ${String(d.prompt ?? '').split('\n').join('\n  ')}`,
      ...context,
      ``,
      `Do what the prompt asks (in this project when it concerns the code), then send ONLY the requested`,
      `content with complete_workflow_step({stepId:"${d.stepId}", output:"…"}). The output may be posted to a`,
      `channel, written into a task or fed to later steps by the workflow — no preamble, no sign-off.`,
      `Do not post_message on your own for this step unless the prompt explicitly asks you to.`,
      ``,
      asPersona(),
    ].join('\n')
  }

  // The persona's own CHAT BRAIN is asking this session a question (ADR-045). Conversations are
  // answered on the server — it has the chat, the history and the channel's documents — but not the
  // repository, so anything that needs the code comes here instead. What you send back is posted to
  // the person who asked, under the persona's name: answer THEM, not the brain.
  //
  // Routed by BOARD first, exactly like a task: the server picks the board bound in the guild the
  // question came from, so a question asked in a project's own server reaches that project's window.
  // A board this session did not bind is somebody else's to answer, even in this repository.
  if (type === 'PERSONA_ASK') {
    if (!config.wake.asks) return null
    const boardId = String(d.boardId ?? '')
    const guildId = String(d.guildId ?? '')
    const owner = claimedBy(boardId) || claimedBy(guildId)
    if (owner ? !ownedHere(owner) : !(boardId === '' && await homeIsHere())) {
      const why = !owner ? 'skip (board unbound here)'
        : entrySession(owner) ? `skip (bound to session ${entrySession(owner)})`
        : `skip (owned by ${entryDir(owner)})`
      logRoute('PERSONA_ASK', { askId: d.askId, boardId, guildId }, why)
      return null
    }
    logRoute('PERSONA_ASK', { askId: d.askId, boardId, guildId }, 'wake')
    const msgs = Array.isArray(d.messages) ? d.messages : []
    const context = msgs.length
      ? ['', 'How the conversation got here (you cannot see the channel yourself):',
         ...msgs.map((m) => `  [${m.createdAt ?? ''}] user ${m.authorId ?? '?'}: ${m.content ?? ''}`)]
      : []
    return [
      `RANY: your persona is asking THIS project a question — it is in a conversation it cannot`,
      `answer without the code.`,
      `  ask ${d.askId} — answer within ${d.timeoutMinutes ?? 10} minutes or it gives up and says so.`,
      `  Question:`,
      `  ${String(d.question ?? '').split('\n').join('\n  ')}`,
      ...context,
      ``,
      `Work it out in this repository, then send ONLY the answer with`,
      `answer_persona_ask({askId:"${d.askId}", answer:"…"}).`,
      `It is POSTED STRAIGHT INTO THE CHAT as the persona, so write to the person who asked: their`,
      `language, short, no preamble, no sign-off, and no local paths or machine details they cannot`,
      `use. If the repository does not answer it, say that plainly instead of guessing.`,
      `Do not post_message for this — the answer goes back through the ask.`,
      ``,
      asPersona(),
    ].join('\n')
  }

  // Work rooms (ADR-046). A room seats the owner's agents by BOARD, so each event names the boards it is
  // for and the session that bound one of them wakes — the same claimedBy/ownedHere routing as a task,
  // which is how the Cortex agent hears a thread that lives in the Cocktail server.
  if (type === 'PERSONA_ROOM_MESSAGE' || type === 'PERSONA_ROOM_UPDATED' || type === 'PERSONA_ROOM_DECISION') {
    if (config.wake.rooms === false) return null
    // Record a handoff whoever it is for: the card's assignment event, which follows, must not wake
    // this session's board either (see taskSeatsFile).
    if (type === 'PERSONA_ROOM_UPDATED' && d.change === 'task_assigned') noteTaskSeat(d.taskId, d.agentId)
    const seats = type === 'PERSONA_ROOM_MESSAGE' ? (Array.isArray(d.targets) ? d.targets : [])
      : type === 'PERSONA_ROOM_UPDATED' ? (Array.isArray(d.agents) ? d.agents : [])
      : [{ agentId: d.agentId, boardId: d.boardId, name: d.agentName }]
    // Prefer the seat the event is ABOUT (a pause, a decision), else any seat bound here.
    // A seat joined by invite link is bound under its OWN id; a board-seated one under its board.
    const bound = seats.filter((s) => s && (ownedHere(claimedBy(String(s.agentId)))
      || (s.boardId && ownedHere(claimedBy(String(s.boardId))))))
    const seat = bound.find((s) => String(s.agentId) === String(d.agentId ?? '')) ?? bound[0]
    if (!seat) {
      logRoute(type, { channelId: d.channelId }, 'skip (no seat bound here)')
      return null
    }
    logRoute(type, { channelId: d.channelId, agentId: seat.agentId, boardId: seat.boardId }, 'wake')
    return roomPrompt(type, d, seat)
  }

  if (type === 'PERSONA_FORWARD') {
    if (!config.wake.forwards) return null
    // A forward is the owner handing the persona a conversation: its HOME takes it (ADR-047).
    if (!(await homeIsHere())) {
      logRoute('PERSONA_FORWARD', { channelId: d.channelId }, 'skip (not the persona home)')
      return null
    }
    logRoute('PERSONA_FORWARD', { channelId: d.channelId }, 'wake (persona home)')
    const msgs = Array.isArray(d.messages) ? d.messages : []
    const target = msgs.find((m) => m.target) ?? msgs[msgs.length - 1]
    return [
      `RANY: your owner forwarded a conversation to your persona.`,
      `  channel ${d.channelId}${d.channelName ? ` (#${d.channelName})` : ''}`,
      `  >>> ${target?.content ?? ''}`,
      ...attachmentLines(target?.attachments, d.channelId),
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

  // A conversation in a guild — the persona addressed by name, or its owner overheard — belongs to the
  // persona's HOME and nowhere else (ADR-047). The owner decides where the persona lives by typing
  // /rany-home there; guild claims and "the window you typed in last" no longer pick a session for a
  // conversation, because they are how a work-room question got answered from an unrelated repository.
  // While the home is closed, the server's hosted brain answers instead (when a key is stored).
  if (isGuild) {
    if (!(await homeIsHere())) {
      logRoute('MESSAGE_CREATED', { guildId: d.guildId, channelId: d.channelId }, 'skip (not the persona home)')
      return null
    }
    logRoute('MESSAGE_CREATED', { guildId: d.guildId, channelId: d.channelId }, 'wake (persona home)')
  }

  // A conversation outside a guild — the persona's own session, a chat someone opened with it, the
  // owner's DMs — is NEVER this session's to answer (ADR-044). It carries no board and no guild, so
  // there was nothing to route it by, and "the window the owner last typed in" turned out to mean
  // "whatever unrelated repository happened to be open": a DM got answered from another project's
  // context, under the persona's name. Those conversations are answered by the hosted persona on
  // the server (a stored model key), or by nobody. The gateway no longer delivers them to a runtime
  // socket at all; this branch is the belt to that brace, for a server older than the plugin.
  if (!isGuild) {
    logRoute('MESSAGE_CREATED', { channelId: d.channelId, recipients }, 'skip (chat is hosted-only, ADR-044)')
    return null
  }

  // Someone wrote <@persona> in a guild channel — they are talking to your AI, not to you.
  if (isGuild && mentions.includes(personaUserId)) {
    if (!config.wake.addressed) return null
    return [
      `RANY: someone addressed your persona directly in channel ${d.channelId}.`,
      `  user ${d.authorId}: ${d.content ?? ''}`,
      ...attachmentLines(d.attachments, d.channelId),
      ``,
      `They are asking YOUR AI, not you. Answer them with`,
      `post_message({channelId:"${d.channelId}", content:"…", replyToId:"${d.messageId}"}).`,
      `get_recent_messages on that channel for what was said before.`,
      ``,
      asPersona(),
    ].join('\n')
  }

  // Overhearing a mention of the owner (the listen_mentions flag). Off by default: in a busy guild
  // this is a firehose, and it is not addressed to the persona. (Overheard DMs are hosted-only now.)
  if (config.wake.ownerMentions) {
    return [
      `RANY: you were mentioned in channel ${d.channelId}.`,
      `  user ${d.authorId}: ${d.content ?? ''}`,
      ...attachmentLines(d.attachments, d.channelId),
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

  socket.addEventListener('message', async (ev) => {
    let frame
    try { frame = JSON.parse(String(ev.data)) } catch { return }

    if (frame.op === OP.Hello) {
      const interval = frame.d?.heartbeatInterval ?? 30000
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = setInterval(() => {
        try { socket.send(JSON.stringify({ op: OP.Heartbeat })) } catch { /* close handler follows */ }
      }, interval)
      // `features: ['home']`: this listener routes conversations by the persona's home (ADR-047), so the
      // gateway may hand it conversations at all — older plugins, which woke the last-used window, get none.
      socket.send(JSON.stringify({ op: OP.Identify, d: { token: config.token, features: ['home'] } }))
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

    const summary = await classify(frame.t, frame.d ?? {})
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
