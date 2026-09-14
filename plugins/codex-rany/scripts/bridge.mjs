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
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
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
/** Cards handed to a work-room seat (MCP assign_task, ADR-046): taskId → seat id — the same file the
 *  Claude listener keeps. Every agent is the same persona, so the assignment event alone would wake the
 *  thread that bound the card's BOARD; the handoff names the seat and always arrives first. */
const taskSeatsFile = join(HOME, 'task-seats.json')

/** A session whose last turn is older than this is treated as gone: its heartbeat stops counting
 *  toward "a runtime is handling this board" (ADR-033) and it is no longer a wake target. Wide
 *  enough that a long turn — or a coffee — does not drop a session that is plainly still open. */
const SESSION_STALE_MS = 20 * 60_000
const CLAIM_REFRESH_MS = 5 * 60_000

/** The payload Codex pipes to a hook on stdin (`session_id`, `cwd`, `hook_event_name`, …). Read
 *  with a deadline rather than to EOF, so a hand-run `--ping` from a shell whose stdin never closes
 *  does not hang; run from a terminal there is nothing to read at all. */
function hookInput(ms = 700) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({})
    let raw = ''
    const parse = () => { try { return raw.trim() ? JSON.parse(raw) : {} } catch { return {} } }
    const timer = setTimeout(() => resolve(parse()), ms)
    const done = () => { clearTimeout(timer); resolve(parse()) }
    try {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (d) => { raw += d })
      process.stdin.on('end', done)
      process.stdin.on('error', done)
    } catch { done() }
  })
}

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

/**
 * Who owns a binding, for routing (ADR-038). A binding is one of:
 *   · a Codex object `{ dir, agent:'codex', threadId, ts }` — owned by ONE thread; that thread, and
 *     only it, is woken, even with another Codex thread open in the same repo.
 *   · a Claude object (has `sessionId`, no `threadId`) — another agent's; never ours.
 *   · a legacy directory string — pre-ADR-038, routed by directory to the most recent thread there.
 * Returns `{ dir, threadId|null, legacy }`, or null when the id is unbound or another agent's.
 */
function ownerOf(entry) {
  if (!entry) return null
  if (typeof entry === 'string') return { dir: entry, threadId: null, legacy: true }
  if (entry.threadId) return { dir: entry.dir, threadId: String(entry.threadId), legacy: false }
  return null
}

/** Drop every binding a thread owns — SessionEnd, so a closed Codex thread stops being a wake target
 *  and RANY stops offering the persona for its boards. Legacy strings and other threads' entries are
 *  left untouched. */
function dropThreadBindings(threadId) {
  if (!threadId) return
  const boards = loadBindings()
  let changed = false
  for (const [id, e] of Object.entries(boards))
    if (typeof e === 'object' && String(e?.threadId) === String(threadId)) { delete boards[id]; changed = true }
  if (changed) try { writeFileSync(bindFile, JSON.stringify({ boards }, null, 2)) } catch { /* best effort */ }
}

/** A durable, per-repository record of every board ever bound here, WITH its human names. Unlike a
 *  binding (session-scoped, dies with the thread), this survives — so a fresh Codex session can open
 *  and be told "this repo has handled General (Rany) before — re-bind it?" instead of leaving you to
 *  remember the number. Keyed by normalized repo dir. */
const historyFile = join(HOME, 'board-history.json')

function loadHistory() {
  try { return JSON.parse(readFileSync(historyFile, 'utf8')).repos ?? {} } catch { return {} }
}
function recordHistory(dir, boardId, info) {
  const repos = loadHistory()
  const key = norm(dir)
  const boards = repos[key] ?? {}
  boards[String(boardId)] = {
    boardName: info?.name ?? null, guildName: info?.guildName ?? null,
    guildId: info?.guildId ?? null, dir, lastBound: new Date().toISOString(),
  }
  repos[key] = boards
  try { mkdirSync(HOME, { recursive: true }); writeFileSync(historyFile, JSON.stringify({ repos }, null, 2)) }
  catch { /* best effort — the binding itself still saved */ }
}
const historyForRepo = (dir) => Object.entries(loadHistory()[norm(dir)] ?? {})
function boardLabel(boardId, h) {
  if (h?.boardName && h?.guildName) return `${h.boardName} (${h.guildName}) — board ${boardId}`
  if (h?.boardName) return `${h.boardName} — board ${boardId}`
  return `board ${boardId}`
}

/** POST JSON with the persona token → `{ ok, status, body }`, or null when offline / unconfigured. */
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
 * The persona's HOME (ADR-047) when it is a live Codex thread → `{ dir, threadId }`, else null. The
 * owner chose it (`$rany-home` in that thread); conversations — being addressed in a channel, forwards,
 * workflow steps and questions no board claims — go there and nowhere else, and while it is closed the
 * server's hosted brain answers them (when a key is stored). Asked on each such event, so a home moved
 * or cleared from the web takes effect at once.
 */
async function homeTarget() {
  const h = (await getJson('/personas/@self/home'))?.home
  return h && h.agent === 'codex' && h.live && h.ref ? { dir: h.label || process.cwd(), threadId: h.ref } : null
}

/** Make this thread the persona's home. */
async function setHome({ dir, threadId }) {
  if (!threadId) return 'RANY: could not tell which Codex thread this is — type a prompt in it first, then $rany-home again.'
  const r = await postJson('/personas/@self/home', { agent: 'codex', ref: threadId, label: dir })
  if (!r) return 'RANY: could not reach RANY to set the home — check RANY_API_URL / RANY_PERSONA_TOKEN.'
  if (!r.ok) return `RANY: the home was refused (${r.body?.error ?? r.status}).`
  noteSession(dir, threadId)
  return [
    `RANY: this thread is now your persona's home (${dir}).`,
    `Being addressed in a channel, forwards and workflow steps are queued into THIS thread and no other.`,
    `While it is closed, RANY's hosted AI answers them if a model key is stored — otherwise they go`,
    `unanswered. Move it with $rany-home in another thread, or clear it in RANY → persona settings.`,
  ].join('\n')
}

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

/** Resolve a board id to its name + space via the persona token (GET /personas/@self/boards/{id}).
 *  Best-effort: an older server, offline, or no access yields null and the binding is stored by id
 *  alone. node:http, like declareBoards, so `--bind` can exit cleanly right after. */
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
//
// The file also records WHICH thread the prompt was typed into (the hook's `session_id` is the
// thread id `codex queue --thread` takes). Two sessions open in one repository is ordinary — a long
// autonomous one and the one you are actually typing in — and `thread/list` recency cannot tell
// them apart: the autonomous one updates itself every turn, and a queued message counts as use, so
// once it wins it keeps winning. The thread you last prompted is the one that should be woken.

/** Session file name: one per thread when the hook told us which, else one per directory (an older
 *  Codex, or a hand-run `--ping`) — the shape the daemon already understood. */
const sessionFile = (cwd, threadId) =>
  join(sessionsDir, `${projectKeyOf(cwd)}${threadId ? `-${threadId}` : ''}.json`)

function noteSession(cwd, threadId) {
  try {
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(sessionFile(cwd, threadId),
      JSON.stringify({ dir: cwd, ts: Date.now(), ...(threadId ? { threadId } : {}) }))
  } catch { /* unwritable state dir: the daemon falls back to thread recency */ }
}

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
  try { mkdirSync(HOME, { recursive: true }); writeFileSync(taskSeatsFile, JSON.stringify(map)) }
  catch { /* unwritable: the card routes by board, as before */ }
}

function forgetSession(cwd, threadId) {
  try { rmSync(sessionFile(cwd, threadId), { force: true }) } catch { /* gone */ }
}

/** Every session file that is still fresh; stale ones are deleted on the way (their boards must stop
 *  being claimed, and a closed thread must stop being a wake target). */
function liveSessions() {
  const out = []
  let names = []
  try { names = readdirSync(sessionsDir) } catch { return out }
  for (const n of names) {
    try {
      const row = JSON.parse(readFileSync(join(sessionsDir, n), 'utf8'))
      if (row?.dir && Date.now() - (row.ts ?? 0) < SESSION_STALE_MS) out.push(row)
      else rmSync(join(sessionsDir, n), { force: true })
    } catch { /* unreadable: ignore it rather than drop every other session */ }
  }
  return out
}

/** The thread most recently prompted in this directory, when a hook recorded one. */
function lastPromptedThread(dir) {
  let best = null
  for (const row of liveSessions())
    if (row.threadId && samePath(row.dir, dir) && (!best || (row.ts ?? 0) > (best.ts ?? 0))) best = row
  return best?.threadId ?? null
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

/** The thread to write into for a repository: the one you last typed a prompt into there, else the
 *  most recently touched one opened in that exact directory. `thread/list` filters by cwd
 *  server-side, so neither can drift into a sibling checkout. Returns `{ id, why }` or null. */
async function threadForDir(dir) {
  const prompted = lastPromptedThread(dir)
  const res = await appServer('thread/list', { cwd: dir, limit: 50 })
  const rows = (res?.data ?? []).filter((t) => t?.id && t?.cwd && samePath(t.cwd, dir))
  // The prompted thread is trusted when the app-server confirms it — or cannot be asked at all.
  if (prompted && (res === null || rows.some((t) => t.id === prompted))) return { id: prompted, why: 'last prompted' }
  if (rows.length === 0) return null
  rows.sort((a, b) => (b.updatedAt ?? b.recencyAt ?? 0) - (a.updatedAt ?? a.recencyAt ?? 0))
  return { id: rows[0].id, why: 'most recent' }
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
    // No `sessions` / `ownerDms` switch: the persona's chats are answered on the server (ADR-044) and
    // reach a session only as an `ask` — a question its chat brain could not answer without the code
    // (ADR-045). Those keys left in the file are accepted and ignored.
    wake: {
      tasks: true, comments: true, addressed: true, forwards: true, asks: true,
      ownerMentions: false,
      ...(file.wake ?? {}),
    },
  }
}

const config = loadConfig()

/** Tell RANY which boards are being handled right now (ADR-033, db/0285), so a persona is offered as
 *  a task assignee only where something is listening. Declared PER PROJECT, because one daemon covers
 *  every checkout on the machine and a project's claims must not delete another's. */
function declareBoards(projectKey, boardIds, timeoutMs = 5000, extra = {}) {
  return new Promise((resolve) => {
    if (!config.token) return resolve()
    let url
    try { url = new URL(`${config.apiUrl}/personas/@self/boards`) } catch { return resolve() }
    // `extra.ref` names the thread, so the same heartbeat keeps the persona's home live when it is that
    // thread (ADR-047); `extra.closing` makes it stop being live at once.
    const body = JSON.stringify({ projectKey, boardIds, ...extra })
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
const claimKey = (s) => (s.threadId ? projectKeyOf(s.dir + '|' + s.threadId) : projectKeyOf(s.dir))

/** The boards a live session claims: its own session-scoped entries (threadId match), plus any legacy
 *  directory string pointing at its repo. */
function boardsForSession(bindings, s) {
  return Object.entries(bindings).filter(([, e]) => {
    if (typeof e === 'string') return samePath(e, s.dir)
    if (e.threadId) return s.threadId && String(e.threadId) === s.threadId
    return false // another agent's (Claude) entry
  }).map(([id]) => id)
}

/** Declare each live thread's boards under a per-thread key (ADR-038), so closing one thread withdraws
 *  only its own claims; threads that went quiet declare nothing and expire server-side. */
async function refreshClaims() {
  const bindings = loadBindings()
  const known = new Set()
  for (const s of liveSessions()) {
    const key = claimKey(s)
    known.add(key)
    await declareBoards(key, boardsForSession(bindings, s), 5000, { ref: s.threadId })
  }
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
  // Resolve the human names first, so the binding, the confirmation, and the next session's reminder
  // read "General (Rany)" and not a bare number.
  const info = await fetchBoardInfo(boardId)
  const label = info?.name ? (info.guildName ? `${info.name} (${info.guildName})` : info.name) : `board ${boardId}`
  const boards = loadBindings()
  // Bind to the CURRENT thread, resolved from the heartbeat the UserPromptSubmit hook just wrote for
  // this cwd (a skill-run command gets no hook stdin, so the thread id comes from there). Falls back
  // to a legacy directory string only when no live thread can be identified.
  const threadId = lastPromptedThread(process.cwd())
  boards[boardId] = threadId
    ? { dir: process.cwd(), agent: 'codex', threadId, ts: Date.now(),
        boardName: info?.name ?? null, guildName: info?.guildName ?? null }
    : process.cwd()
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(bindFile, JSON.stringify({ boards }, null, 2))
    recordHistory(process.cwd(), boardId, info)
    process.stdout.write(threadId
      ? `RANY: ${label} is now handled in THIS Codex thread (${process.cwd()}). It stops when this thread closes; re-run /rany-bind in another to move it.\n`
      : `RANY: ${label} is now handled in ${process.cwd()} (no active thread detected; routes to the most recent one there)\n`)
  } catch (e) {
    process.stdout.write(`RANY: could not save the binding (${e?.message ?? e})\n`)
    process.exit(0)
  }
  noteSession(process.cwd(), threadId ?? undefined)
  const s = { dir: process.cwd(), threadId: threadId ?? undefined }
  await declareBoards(claimKey(s), boardsForSession(loadBindings(), s))
  process.exit(0)
}

/** A work-room invite link — or its bare `/join-room/<code>` path — anywhere in some text → its code. */
function inviteCodeIn(text) {
  const m = /\/join-room\/([A-Za-z0-9]{8,64})\b/.exec(String(text ?? ''))
  return m ? m[1] : null
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
 * Seat a Codex thread in a work room (ADR-046) from an invite code. The seat is bound to the thread like
 * a board, so room events for it are queued there and nowhere else — no board involved. Shared by
 * `--join` (typed) and the UserPromptSubmit hook (the link simply pasted into the chat).
 */
async function joinSeat({ code, dir, threadId }) {
  const boards = loadBindings()
  const held = Object.entries(boards).find(([, e]) => e && typeof e === 'object' && e.room?.invite === code)
  if (held && threadId && String(held[1].threadId) === String(threadId))
    return `RANY: this thread already sits in that work room (channel ${held[1].room.channelId}) as "${held[1].room.name}" — agentId ${held[0]}.`
  const res = await postJson('/personas/@self/rooms/join',
    { code, name: `${basename(dir)} · Codex`.slice(0, 40), agent: 'codex' }, 6000)
  if (!res?.ok)
    return `RANY: could not join the work room — ${JOIN_REFUSALS[res?.body?.error] ?? `the server refused (${res?.status ?? 'offline'})`}.`
  const seat = res.body
  boards[seat.agentId] = threadId
    ? { dir, agent: 'codex', threadId, ts: Date.now(),
        room: { channelId: seat.channelId, guildId: seat.guildId, name: seat.name, invite: code } }
    : dir
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(bindFile, JSON.stringify({ boards }, null, 2))
  } catch (e) {
    return `RANY: joined the work room, but could not save the seat binding (${e?.message ?? e}).`
  }
  noteSession(dir, threadId ?? undefined)
  const s = { dir, threadId: threadId ?? undefined }
  await declareBoards(claimKey(s), boardsForSession(loadBindings(), s))
  return [
    `RANY: THIS Codex thread joined the work room at channel ${seat.channelId} as "${seat.name}" (agentId ${seat.agentId}).`,
    `From now on room messages for that seat are queued into this thread, until it closes.`,
    `Next: get_room({channelId:"${seat.channelId}"}) and read the brief documents it lists; then tell the room in ONE`,
    `line which part of the job you take — post_message({channelId:"${seat.channelId}", agentId:"${seat.agentId}", content:"…"}).`,
  ].join('\n')
}

/** `--home`: make this thread the persona's home (ADR-047) — the rany-home skill's fallback when the
 *  prompt hook did not already do it. */
if (has('--home')) {
  const dir = process.cwd()
  process.stdout.write((await setHome({ dir, threadId: lastPromptedThread(dir) })) + '\n')
  process.exit(0)
}

/** `--join <link|code>`: the same, typed by hand (the rany-join skill). */
if (has('--join')) {
  const raw = String(arg('--join') ?? '').trim()
  const code = inviteCodeIn(raw) ?? (/^[A-Za-z0-9]{8,64}$/.test(raw) ? raw : null)
  if (!code) {
    process.stdout.write('RANY: --join needs the work-room invite link (RANY → the room → Invite agent)\n')
    process.exit(0)
  }
  const dir = process.cwd()
  process.stdout.write((await joinSeat({ code, dir, threadId: lastPromptedThread(dir) })) + '\n')
  process.exit(0)
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

/** Start the machine's daemon from a hook. On Windows a hook runs inside the host's job object, and a
 *  job kills every descendant when it closes — `detached` does not break out of it (libuv only tries
 *  when the job allows it). So the daemon spawned by a hook lived exactly as long as the hook's job:
 *  2026-09-14 it was found dead ten minutes after it had delivered a wake, with no CRASH line, and an
 *  idle Codex fires no hook to notice. Windows therefore asks WMI to create the process — WMI is a
 *  service, its children belong to no caller's job. Anything else (or WMI failing) falls back to the
 *  detached spawn, which is fine everywhere jobs are not in play. */
function spawnDaemon() {
  const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const script = join(here, 'bridge.mjs')
  if (process.platform === 'win32') {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`
    const cmdLine = `${q(process.execPath)} ${q(script)} --daemon`
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}' }; exit ([int]$r.ReturnValue)`
    try {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { stdio: 'ignore', windowsHide: true, timeout: 8000 })
      if (r.status === 0) return
    } catch { /* fall through */ }
  }
  try {
    const child = spawn(process.execPath, [script, '--daemon'], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch { /* nothing woke; the next hook tries again */ }
}

/** SessionStart: record this session and make sure the machine's one daemon is running. `--beat`
 *  (PostToolUse) does the same mid-turn: a queued room message starts a turn without a typed prompt, so
 *  a long one aged the session file past SESSION_STALE_MS and dropped its claims while it worked — and a
 *  daemon that died stayed dead until someone typed again. */
if (has('--ensure') || has('--ping') || has('--beat')) {
  const hook = await hookInput()
  noteSession(typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd(),
    typeof hook.session_id === 'string' && hook.session_id ? hook.session_id : undefined)
  // A work-room invite link PASTED into the chat joins the room by itself (ADR-046). The link is a web
  // address nothing in a coding session understands on its own, so the hook reads the prompt before the
  // model does, seats THIS thread and hands the model the seat as context. No link = no network.
  // `$rany-home` makes THIS thread the persona's home (ADR-047) — the same move as the invite link: the
  // hook sees the prompt before the model, knows the thread for certain, and hands over the result.
  const wantsHome = has('--ping') && /\$rany-home\b|^\s*\/?rany-home\b/i.test(String(hook.prompt ?? ''))
  if (wantsHome && config.token) {
    const dir = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd()
    const threadId = typeof hook.session_id === 'string' && hook.session_id ? hook.session_id : lastPromptedThread(dir)
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: await setHome({ dir, threadId }) },
    }) + '\n')
  }
  const inviteCode = has('--ping') && !wantsHome ? inviteCodeIn(hook.prompt) : null
  if (inviteCode && config.token) {
    const dir = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd()
    const threadId = typeof hook.session_id === 'string' && hook.session_id ? hook.session_id : lastPromptedThread(dir)
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: await joinSeat({ code: inviteCode, dir, threadId }),
      },
    }) + '\n')
  }
  let running = false
  try {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      running = Boolean(pid) && alive(pid)
    }
  } catch { /* treat as not running */ }
  if (!running && config.token) spawnDaemon()
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
  // Re-bind reminder at SessionStart: a binding is thread-scoped, so a fresh Codex session owns nothing
  // even in a repo it has handled before. Surface those boards by name and hand over the one-liners,
  // rather than leaving the numbers to memory. --ensure only (never --ping, which fires every prompt).
  if (config.token && has('--ensure')) {
    const dir = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd()
    const threadId = typeof hook.session_id === 'string' ? hook.session_id : undefined
    const boards = loadBindings()
    const boundHere = (id) => {
      const e = boards[String(id)]
      return e && typeof e === 'object' && threadId && String(e.threadId) === threadId
    }
    const forgotten = historyForRepo(dir).filter(([id]) => !boundHere(id))
    if (forgotten.length > 0) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: [
            'RANY: this repo has handled these boards before, but none are bound to THIS Codex thread:',
            ...forgotten.map(([id, h]) => '  • ' + boardLabel(id, h)),
            '',
            'A binding belongs to one thread and does not carry over. To handle them here, run:',
            ...forgotten.map(([id]) => '  /rany-bind ' + id),
          ].join('\n'),
        },
      }) + '\n')
    }
  }
  process.exit(0)
}

/** SessionEnd: this thread stops being a wake target straight away (another session open in the
 *  same repository keeps its own file, and the repository stays live). */
if (has('--bye')) {
  const hook = await hookInput()
  const threadId = typeof hook.session_id === 'string' && hook.session_id ? hook.session_id : undefined
  const byeDir = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd()
  forgetSession(byeDir, threadId)
  // A closed thread that was the persona's home stops being live at once (ADR-047) instead of after the
  // heartbeat window — the hosted brain takes its conversations from here.
  if (threadId) await declareBoards(claimKey({ dir: byeDir, threadId }), [], 2000, { ref: threadId, closing: true })
  // ADR-038: closing the thread drops its bindings, so the board stops waking anything until re-bound.
  dropThreadBindings(threadId)
  process.exit(0)
}

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

// The daemon's own births and deaths go in the routing log: a dead bridge looks exactly like a quiet
// one, and "when did it die, and how" was the question nobody could answer.
logRoute('DAEMON', { pid: process.pid }, `started (node ${process.version})`)
process.on('exit', (code) => logRoute('DAEMON', { pid: process.pid }, `exit ${code}`))

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
process.on('SIGTERM', () => { logRoute('DAEMON', { pid: process.pid }, 'SIGTERM'); shutdown() })
process.on('SIGINT', () => { logRoute('DAEMON', { pid: process.pid }, 'SIGINT'); shutdown() })

// Stay up. This daemon's whole job is to be there when a task arrives, and a background process that
// dies silently on one bad event is worse than useless — it looks bound and wakes nobody, which is
// exactly the "assigned a task, nothing happened" report. A single malformed frame or a transient
// network reject must be logged and shrugged off, never fatal. The socket's own close handler owns
// reconnection; these just make sure an unexpected throw somewhere else does not take the process
// with it.
process.on('uncaughtException', (e) => logRoute('CRASH', {}, `uncaughtException: ${e?.stack ?? e?.message ?? e}`))
process.on('unhandledRejection', (e) => logRoute('CRASH', {}, `unhandledRejection: ${e?.message ?? e}`))

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
async function route(type, d) {
  if (type === 'TASK_UPDATED') {
    const added = Array.isArray(d.addedAssigneeIds) ? d.addedAssigneeIds : []
    if (!config.wake.tasks || !added.includes(personaUserId)) return null
    const guildId = String(d.guildId ?? d.taskGuildId ?? '')
    // Handed to a work-room seat (assign_task): the handoff already woke THAT seat's thread.
    const handedTo = taskSeatOf(d.id)
    if (handedTo) {
      logRoute('TASK_UPDATED', { taskId: d.id, agentId: handedTo }, 'skip (handed to a room seat)')
      return null
    }
    // BOARD ONLY, and deliberately no guild fallback: a guild's DEFAULT board carries the guild's own
    // id, so "I bound the board" and "I bound the server" are the same keystrokes — a fallback would
    // make binding the default board silently claim every board added to that server later.
    const boardId = String(d.boardId ?? '')
    const owner = ownerOf(claimedBy(boardId))
    if (!owner) {
      if (!claimedBy(boardId)) noteUnrouted(boardId, guildId, d)
      logRoute('TASK_UPDATED', { boardId, guildId }, claimedBy(boardId) ? 'skip (another agent\'s bind)' : 'skip (unbound)')
      return null
    }
    return {
      dir: owner.dir, threadId: owner.threadId,
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

  // A COMMENT on a task this persona is ASSIGNED to (the gateway delivers only those, never the
  // persona's own — db/0312). Routed by board like the assignment: it goes to the thread that bound
  // the board. The follow-up channel — an answer to a question the persona asked, or "also do X".
  if (type === 'TASK_COMMENT_CREATED') {
    if (!config.wake.comments) return null
    const guildId = String(d.guildId ?? d.taskGuildId ?? '')
    const boardId = String(d.boardId ?? '')
    // A card handed to a room seat (assign_task) talks to that seat, not to the board's thread.
    const seatId = taskSeatOf(d.taskId)
    const owner = ownerOf(claimedBy(seatId ?? boardId))
    if (!owner) {
      logRoute('TASK_COMMENT_CREATED', { boardId, guildId }, claimedBy(boardId) ? 'skip (another agent\'s bind)' : 'skip (unbound)')
      return null
    }
    const c = d.comment ?? {}
    return {
      dir: owner.dir, threadId: owner.threadId,
      text: [
        `RANY: a new comment on a task assigned to your persona.`,
        `  task ${d.taskId} in guild ${guildId} — comment by user ${c.authorId ?? '?'}:`,
        `  ${c.content ?? ''}`,
        ``,
        `Re-read the task with get_task({guildId:"${guildId}", taskId:"${d.taskId}"}) — the full comment`,
        `thread and current state — then do what the comment asks in this project, reply with`,
        `comment_task, and move the card with set_task_status if the state changed.`,
        ``,
        asPersona(),
      ].join('\n'),
    }
  }

  // A guild WORKFLOW handed this persona a step (ADR-040). The answer goes back through
  // complete_workflow_step; the workflow decides where the output lands.
  if (type === 'PERSONA_WORKFLOW') {
    if (config.wake.workflows === false) return null
    const owner = ownerOf(claimedBy(d.guildId)) ?? await homeTarget()
    if (!owner) { logRoute('PERSONA_WORKFLOW', { guildId: d.guildId, stepId: d.stepId }, 'skip (guild unclaimed, no live home)'); return null }
    const msgs = Array.isArray(d.messages) ? d.messages : []
    const context = msgs.length
      ? ['', 'Recent messages of the channel this step is about:',
         ...msgs.map((m) => `  [${m.createdAt ?? ''}] user ${m.authorId ?? '?'}: ${m.content ?? ''}`)]
      : []
    return {
      dir: owner.dir, threadId: owner.threadId,
      text: [
        `RANY: the workflow "${d.workflowName ?? d.workflowId}" in guild ${d.guildId} is running a step through your persona.`,
        `  step ${d.stepId} (run ${d.runId}) — answer within ${d.timeoutMinutes ?? 30} minutes or the run fails.`,
        `  Prompt:`,
        `  ${String(d.prompt ?? '').split('\n').join('\n  ')}`,
        ...context,
        ``,
        `Do what the prompt asks (in this project when it concerns the code), then send ONLY the requested`,
        `content with complete_workflow_step({stepId:"${d.stepId}", output:"…"}). No preamble, no sign-off;`,
        `do not post_message on your own for this step unless the prompt explicitly asks you to.`,
        ``,
        asPersona(),
      ].join('\n'),
    }
  }

  // The persona's chat brain is asking this project a question (ADR-045). Conversations are answered
  // on the server, which has the chat but not the code; what needs the repository comes here, and the
  // answer is posted straight into that conversation under the persona's name. Routed by BOARD first
  // — the server picks the board bound in the guild the question came from — so it lands in the
  // thread that owns that project rather than whichever one was last used.
  // Work rooms (ADR-046): each event names the seats' BOARDS; the thread that bound one of them wakes.
  if (type === 'PERSONA_ROOM_MESSAGE' || type === 'PERSONA_ROOM_UPDATED' || type === 'PERSONA_ROOM_DECISION') {
    if (config.wake.rooms === false) return null
    // Record a handoff whoever it is for: the card's assignment event, which follows, must not wake a
    // board-bound thread either (see taskSeatsFile).
    if (type === 'PERSONA_ROOM_UPDATED' && d.change === 'task_assigned') noteTaskSeat(d.taskId, d.agentId)
    const seats = type === 'PERSONA_ROOM_MESSAGE' ? (Array.isArray(d.targets) ? d.targets : [])
      : type === 'PERSONA_ROOM_UPDATED' ? (Array.isArray(d.agents) ? d.agents : [])
      : [{ agentId: d.agentId, boardId: d.boardId, name: d.agentName }]
    // A seat joined by invite link is bound under its OWN id; a board-seated one under its board.
    const bound = seats
      .map((s) => ({ s, owner: s ? (ownerOf(claimedBy(String(s.agentId)))
        ?? (s.boardId ? ownerOf(claimedBy(String(s.boardId))) : null)) : null }))
      .filter((x) => x.owner)
    const pick = bound.find((x) => String(x.s.agentId) === String(d.agentId ?? '')) ?? bound[0]
    if (!pick) {
      logRoute(type, { channelId: d.channelId }, 'skip (no seat bound here)')
      return null
    }
    return { dir: pick.owner.dir, threadId: pick.owner.threadId, text: roomPrompt(type, d, pick.s) }
  }

  if (type === 'PERSONA_ASK') {
    if (config.wake.asks === false) return null
    const owner = ownerOf(claimedBy(d.boardId)) ?? ownerOf(claimedBy(d.guildId))
      ?? (d.boardId ? null : await homeTarget()) // no board named: the persona's home (ADR-047)
    if (!owner) {
      logRoute('PERSONA_ASK', { askId: d.askId, boardId: d.boardId, guildId: d.guildId }, 'skip (board unbound here)')
      return null
    }
    const msgs = Array.isArray(d.messages) ? d.messages : []
    const context = msgs.length
      ? ['', 'How the conversation got here (you cannot see the channel yourself):',
         ...msgs.map((m) => `  [${m.createdAt ?? ''}] user ${m.authorId ?? '?'}: ${m.content ?? ''}`)]
      : []
    return {
      dir: owner.dir, threadId: owner.threadId,
      text: [
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
      ].join('\n'),
    }
  }

  if (type === 'PERSONA_FORWARD') {
    if (!config.wake.forwards) return null
    const owner = await homeTarget() // a forward is a conversation: the persona's home takes it (ADR-047)
    if (!owner) { logRoute('PERSONA_FORWARD', { guildId: d.guildId }, 'skip (not the persona home)'); return null }
    const msgs = Array.isArray(d.messages) ? d.messages : []
    const target = msgs.find((m) => m.target) ?? msgs[msgs.length - 1]
    return {
      dir: owner.dir, threadId: owner.threadId,
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

  // A conversation in a guild belongs to the persona's HOME and nowhere else (ADR-047): the owner
  // decides where the persona lives, and guild claims no longer pick a thread for a conversation.
  // While the home is closed (or is a Claude session) this daemon stays quiet.
  if (isGuild) {
    const owner = await homeTarget()
    if (!owner) { logRoute('MESSAGE_CREATED', { guildId: d.guildId }, 'skip (not the persona home)'); return null }
    if (mentions.includes(personaUserId) && config.wake.addressed) {
      return {
        dir: owner.dir, threadId: owner.threadId,
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
      return { dir: owner.dir, threadId: owner.threadId, text: `RANY: you were mentioned in channel ${d.channelId}.\n  user ${d.authorId}: ${d.content ?? ''}` }
    }
    return null
  }

  // A conversation outside a guild — the persona's own session, a chat someone opened with it, the
  // owner's DMs — is never a coding session's to answer (ADR-044). It carries no board and no guild,
  // so "the session the owner most recently worked in" meant "whatever repository happened to be
  // open", and a DM got answered from another project's context under the persona's name. Those are
  // answered by the hosted persona on the server (a stored model key), or by nobody. The gateway no
  // longer delivers them to a runtime socket; this is the belt to that brace for an older server.
  logRoute('MESSAGE_CREATED', { channelId: d.channelId, recipients }, 'skip (chat is hosted-only, ADR-044)')
  return null
}

/**
 * The wake text for a work-room event (ADR-046) — kept identical to the Claude plugin's, so the two
 * agents sitting in one room are told the same rules. Every variant names the SEAT, because the persona
 * is one identity with several agents and an agent that does not know which one it is speaks as the
 * wrong colleague.
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
  const files = Array.isArray(d.attachments) && d.attachments.length
    ? [`  attached: ${d.attachments.map((a) => `${a.filename ?? 'file'} (${a.contentType ?? 'unknown type'})`).join(', ')}`,
       `  get_recent_messages({channelId:"${d.channelId}", limit:5}) gives a fresh download url per file.`]
    : []
  if (type === 'PERSONA_ROOM_MESSAGE') {
    const from = d.fromPersona ? `your PERSONA (the room's authority — follow it)`
      : d.fromOwner ? `your OWNER`
      : d.fromMember ? `a room MEMBER (user ${d.authorId ?? '?'} — someone your owner put in this room)`
      : `the agent "${d.authorName ?? '?'}"`
    return [
      `RANY: work room — ${from} wrote in channel ${d.channelId}:`,
      `  ${String(d.content ?? '').split('\n').join('\n  ')}`,
      ...files,
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

async function deliver(type, ids, { dir, threadId, text }) {
  // Session-scoped: a binding names the exact thread, so queue straight to it — `codex queue` holds
  // the message for a thread that is momentarily closed, which is the point (the task waits). Legacy
  // directory bindings still resolve a thread by recency.
  if (threadId) {
    const ok = await queueMessage(threadId, text)
    logRoute(type, ids, ok ? `queued -> ${threadId} (bound) @ ${dir}` : `queue FAILED -> ${threadId} @ ${dir}`)
    return
  }
  const thread = await threadForDir(dir)
  if (!thread) { logRoute(type, ids, `no thread in ${dir}`); return }
  const ok = await queueMessage(thread.id, text)
  logRoute(type, ids, ok ? `queued -> ${thread.id} (${thread.why}) @ ${dir}` : `queue FAILED -> ${thread.id} @ ${dir}`)
}

function connect() {
  try { socket = new WebSocket(config.gatewayUrl) } catch { return void setTimeout(connect, 15000) }

  socket.addEventListener('message', async (ev) => {
    let frame
    try { frame = JSON.parse(String(ev.data)) } catch { return }

    if (frame.op === OP.Hello) {
      const interval = frame.d?.heartbeatInterval ?? 30000
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = setInterval(() => {
        try { socket.send(JSON.stringify({ op: OP.Heartbeat })) } catch { /* close handler follows */ }
      }, interval)
      // `features: ['home']`: this bridge routes conversations by the persona's home (ADR-047), so the
      // gateway may hand it conversations at all — older plugins, which guessed a thread, get none.
      socket.send(JSON.stringify({ op: OP.Identify, d: { token: config.token, features: ['home'] } }))
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
    const target = await route(frame.t, d)
    if (target) void deliver(frame.t, { boardId: d.boardId, guildId: d.guildId, channelId: d.channelId }, target)
  })

  socket.addEventListener('close', () => {
    if (heartbeat) clearInterval(heartbeat)
    setTimeout(connect, 3000)
  })
  socket.addEventListener('error', () => { /* 'close' follows and owns the retry */ })
}

connect()
