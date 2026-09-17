#!/usr/bin/env node
// RANY -> Gemini CLI bridge (ADR-054).
//
// Same job as the Codex and Kimi bridges, a fourth door.
//
// Gemini CLI (>= 0.60) has no inbound API and no asynchronous hook: every hook is awaited, and nothing but
// the user's own typing starts a turn in an idle session — with one exception. A shell command the MODEL
// started in the background (`run_shell_command` with `is_background: true`) is, when it finishes, fed back
// as a steering prompt and runs a turn by itself, provided the user enabled `experimental.modelSteering` and
// `tools.shell.backgroundCompletionBehavior: "inject"` (scripts/setup.mjs does).
//
// So, like Codex and Kimi, ONE daemon per machine holds the RANY socket and decides which session an event
// belongs to; it delivers by writing the wake text into that session's INBOX (~/.rany-plugin/gemini-inbox/
// <sessionId>/). A tiny LISTENER (`--listen <sessionId>`), which the model starts in the background as the
// SessionStart context asks, waits for the inbox and exits with one line when something lands. Gemini then
// runs a turn; the BeforeAgent hook (`--ping`) hands the model the full, formatted message as context — the
// steering prompt itself is whitespace-squashed and capped — and reminds it to restart the listener. A
// closed session gets its inbox as SessionStart context when resumed. Nothing here is a private file
// format: inbox and listener are ours; Gemini only sees a background shell command ending.
//
// Zero dependencies. Node 22's global WebSocket is all this needs.

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Shared with the Claude Code and Codex plugins ON PURPOSE: a board belongs to a repository, not to
 *  whichever agent you happen to be running. Each plugin reads only its own entries. */
const HOME = join(homedir(), '.rany-plugin')
const bindFile = join(HOME, 'bindings.json')
const unroutedFile = join(HOME, 'unrouted.json')
/** One file per open Gemini session, refreshed by every hook it fires. */
const sessionsDir = join(HOME, 'gemini-sessions')
const pidFile = join(HOME, 'gemini-bridge.pid')
const stateFile = join(HOME, 'gemini-bridge.json')
const taskSeatsFile = join(HOME, 'task-seats.json')
/** Per-session inbox the daemon writes and the listener / hooks read. */
const INBOX = join(HOME, 'gemini-inbox')
/** Listener pid files, one per session: how a hook tells whether the session's listener is still waiting. */
const LISTENERS = join(HOME, 'gemini-listeners')
/** Where the scripts are copied at every SessionStart, so the listener command the model runs — and the
 *  policy that lets it run without a prompt — name a path that does not move with the extension. */
const STABLE = join(HOME, 'gemini')

/** A session no hook has heard from in this long stops counting as live (claims, home). Gemini fires no
 *  hook while idle, so an open but untouched session lapses — like Codex and Kimi; the wake does not
 *  depend on it (the inbox waits). */
const SESSION_STALE_MS = 20 * 60_000
const CLAIM_REFRESH_MS = 5 * 60_000
const AGENT = 'gemini'

/** The payload Gemini pipes to a hook: `{hook_event_name, session_id, cwd, …}`. Read with a deadline, so a
 *  hand-run command from a terminal whose stdin never closes does not hang. */
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
const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const VERSION = (() => {
  for (const p of [join(here, 'version.json'), join(here, '..', 'version.json')]) {
    try { return JSON.parse(readFileSync(p, 'utf8')).version ?? '?' } catch { /* next */ }
  }
  return '?'
})()

/** Gemini names the project in the payload (`cwd`) and in GEMINI_PROJECT_DIR; a hand-run command runs in the repo. */
const workDir = (hook) => (typeof hook?.cwd === 'string' && hook.cwd) || process.env.GEMINI_PROJECT_DIR || process.cwd()
const sessionOf = (hook) => (typeof hook?.session_id === 'string' && hook.session_id ? hook.session_id : null)

function loadBindings() {
  try { return JSON.parse(readFileSync(bindFile, 'utf8')).boards ?? {} } catch { return {} }
}
function saveBindings(boards) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(bindFile, JSON.stringify({ boards }, null, 2))
}
const claimedBy = (id) => (id ? loadBindings()[String(id)] : undefined)

/** A binding this plugin owns: `{ dir, agent:'gemini', geminiSessionId, ts }`. Claude (`sessionId`), Codex
 *  (`threadId`) and legacy directory strings belong to the other plugins and are never ours. */
function ownerOf(entry) {
  if (!entry || typeof entry !== 'object' || entry.agent !== AGENT || !entry.geminiSessionId) return null
  return { dir: entry.dir, sessionId: String(entry.geminiSessionId) }
}

function checkoutMates(seats, mySeatId, dir) {
  const dirOf = (e) => (typeof e === 'string' ? e : e?.dir)
  return seats.filter((s) => s && String(s.agentId) !== String(mySeatId)
    && dirOf(claimedBy(String(s.agentId))) && samePath(dirOf(claimedBy(String(s.agentId))), dir))
}

function dropSessionBindings(sessionId) {
  if (!sessionId) return
  const boards = loadBindings()
  let changed = false
  for (const [id, e] of Object.entries(boards))
    if (ownerOf(e)?.sessionId === String(sessionId)) { delete boards[id]; changed = true }
  if (changed) try { saveBindings(boards) } catch { /* best effort */ }
}

// ---- durable per-repository history (shared files with the other plugins) ----------------------

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
  catch { /* best effort */ }
}
const historyForRepo = (dir) => Object.entries(loadHistory()[norm(dir)] ?? {})
function boardLabel(boardId, h) {
  if (h?.boardName && h?.guildName) return `${h.boardName} (${h.guildName}) — board ${boardId}`
  if (h?.boardName) return `${h.boardName} — board ${boardId}`
  return `board ${boardId}`
}

const seatHistoryFile = join(HOME, 'seat-history.json')
function loadSeatHistory() {
  try { return JSON.parse(readFileSync(seatHistoryFile, 'utf8')).repos ?? {} } catch { return {} }
}
function saveSeatHistory(repos) {
  try { mkdirSync(HOME, { recursive: true }); writeFileSync(seatHistoryFile, JSON.stringify({ repos }, null, 2)) }
  catch { /* best effort */ }
}
function recordSeat(dir, agentId, seat) {
  const repos = loadSeatHistory()
  const seats = repos[norm(dir)] ?? {}
  seats[String(agentId)] = {
    channelId: String(seat.channelId), guildId: seat.guildId ? String(seat.guildId) : null,
    name: seat.name ?? null, agent: AGENT, dir, lastJoined: new Date().toISOString(),
  }
  repos[norm(dir)] = seats
  saveSeatHistory(repos)
}
function forgetSeat(dir, agentId) {
  const repos = loadSeatHistory()
  const seats = repos[norm(dir)]
  if (!seats || !seats[String(agentId)]) return
  delete seats[String(agentId)]
  saveSeatHistory(repos)
}
const seatsForRepo = (dir) => Object.entries(loadSeatHistory()[norm(dir)] ?? {}).filter(([, s]) => s?.agent === AGENT)

/** One terminal line for an AfterTool payload (db/0366): the tool and what identifies the call, never the
 *  content. Gemini's tools: run_shell_command{command}, read_file/write_file/replace{file_path|absolute_path},
 *  glob/grep_search{pattern}, web_fetch{prompt}, google_web_search{query}; MCP tools under their names. */
function toolLine(hook) {
  const name = typeof hook?.tool_name === 'string' ? hook.tool_name : ''
  if (!name) return null
  const input = hook.tool_input && typeof hook.tool_input === 'object' ? hook.tool_input : {}
  const cwd = workDir(hook)
  const rel = (p) => typeof p === 'string' ? p.replace(/[\\/]+/g, '/').replace(new RegExp('^' + norm(cwd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', 'i'), '') : ''
  const one = (s, max = 220) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  let detail
  switch (name) {
    case 'run_shell_command':
      // The RANY listener is plumbing, not work — it does not belong on the seat's terminal.
      if (/--listen\b/.test(String(input.command ?? '')) && /bridge\.mjs/.test(String(input.command ?? ''))) return null
      detail = one(input.description || input.command); break
    case 'read_file': case 'write_file': case 'replace': case 'read_many_files': case 'list_directory':
      detail = rel(input.file_path ?? input.absolute_path ?? input.path ?? (Array.isArray(input.paths) ? input.paths.join(', ') : '')); break
    case 'glob': case 'grep_search': case 'search_file_content': detail = `"${one(input.pattern, 80)}"`; break
    case 'web_fetch': detail = one(input.prompt, 160); break
    case 'google_web_search': detail = `"${one(input.query, 120)}"`; break
    case 'write_todos': case 'save_memory': case 'activate_skill': case 'update_topic': return null
    default: {
      const where = ['channelId', 'taskId', 'guildId', 'boardId'].filter((k) => input[k]).map((k) => `${k}=${input[k]}`).join(' ')
      return one(`${name}${where ? ' ' + where : ''}`, 260)
    }
  }
  return one(detail ? `${name} ${detail}` : name, 260)
}

// ---- config and HTTP --------------------------------------------------------------------------

/** The Gemini token: its own env var, then ~/.rany-plugin/gemini.json (what setup.mjs writes with --token),
 *  then the generic RANY_PERSONA_TOKEN. Tokens are per agent (ADR-035). Hooks of an extension get the
 *  user's environment only for variables the manifest declares, so the file is the dependable source. */
function loadConfig() {
  let file = {}
  try { file = JSON.parse(readFileSync(join(HOME, 'gemini.json'), 'utf8')) } catch { /* env only */ }
  const apiUrl = (process.env.RANY_API_URL || file.apiUrl || 'https://www.rany.work/api').replace(/\/+$/, '')
  const token = process.env.RANY_GEMINI_TOKEN || file.token || process.env.RANY_PERSONA_TOKEN || ''
  const gatewayUrl = process.env.RANY_GATEWAY_URL || file.gatewayUrl
    || apiUrl.replace(/^http/, 'ws').replace(/\/api$/, '/gateway')
  return {
    apiUrl, token, gatewayUrl,
    wake: { tasks: true, comments: true, addressed: true, forwards: true, asks: true, ownerMentions: false, ...(file.wake ?? {}) },
  }
}
const config = loadConfig()

function httpJson(method, path, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!config.token) return resolve(null)
    let url
    try { url = new URL(`${config.apiUrl}${path}`) } catch { return resolve(null) }
    const body = payload === undefined ? null : JSON.stringify(payload)
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    const headers = { authorization: `Bearer ${config.token}`, accept: 'application/json' }
    if (body !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body) }
    const req = send(url, { method, agent: false, timeout: timeoutMs, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { text += d })
      res.on('end', () => {
        let parsed = null
        try { parsed = text ? JSON.parse(text) : null } catch { /* not JSON */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed })
      })
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end(body ?? undefined)
  })
}
const postJson = (path, payload, timeoutMs) => httpJson('POST', path, payload, timeoutMs)
const getJson = async (path, timeoutMs) => { const r = await httpJson('GET', path, undefined, timeoutMs); return r?.ok ? r.body : null }

function logRoute(type, ids, decision) {
  try {
    appendFileSync(join(HOME, 'routing.log'), `${new Date().toISOString()} gemini-v${VERSION} ${type} ${JSON.stringify(ids)} -> ${decision}\n`)
  } catch { /* diagnostics are not worth an interruption */ }
}

// ---- open Gemini sessions -------------------------------------------------------------------------

const sessionFile = (sessionId) => join(sessionsDir, `${sessionId}.json`)

function noteSession(dir, sessionId) {
  if (!sessionId) return
  try {
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(sessionFile(sessionId), JSON.stringify({ dir, sessionId, ts: Date.now() }))
  } catch { /* unwritable state dir */ }
}
function forgetSession(sessionId) {
  if (sessionId) try { rmSync(sessionFile(sessionId), { force: true }) } catch { /* gone */ }
}
function liveSessions() {
  const out = []
  let names = []
  try { names = readdirSync(sessionsDir) } catch { return out }
  for (const n of names) {
    try {
      const row = JSON.parse(readFileSync(join(sessionsDir, n), 'utf8'))
      if (row?.dir && row.sessionId && Date.now() - (row.ts ?? 0) < SESSION_STALE_MS) out.push(row)
      else rmSync(join(sessionsDir, n), { force: true })
    } catch { /* unreadable: ignore it */ }
  }
  return out
}
/** The session most recently heard from in this directory — what a skill-run command (no hook stdin)
 *  binds to: the prompt that ran the skill refreshed it a moment ago. */
function lastPromptedSession(dir) {
  let best = null
  for (const row of liveSessions())
    if (samePath(row.dir, dir) && (!best || (row.ts ?? 0) > (best.ts ?? 0))) best = row
  return best?.sessionId ?? null
}

function taskSeatOf(taskId) {
  try { return JSON.parse(readFileSync(taskSeatsFile, 'utf8'))[String(taskId)] ?? null } catch { return null }
}
function noteTaskSeat(taskId, agentId) {
  if (!taskId || !agentId) return
  let map = {}
  try { map = JSON.parse(readFileSync(taskSeatsFile, 'utf8')) } catch { /* first handoff */ }
  delete map[String(taskId)]
  map[String(taskId)] = String(agentId)
  const keys = Object.keys(map)
  for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete map[k]
  try { mkdirSync(HOME, { recursive: true }); writeFileSync(taskSeatsFile, JSON.stringify(map)) } catch { /* best effort */ }
}

// ---- delivery: the session inbox, the listener, and the hooks that read it ----------------------------

const safeId = (sessionId) => String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')
const inboxDir = (sessionId) => join(INBOX, safeId(sessionId))

/** Deliver `text` to a Gemini session: one JSON file in its inbox, written atomically (tmp + rename) so a
 *  listener or hook never reads half of it. The listener wakes an idle open session; a hook hands it over. */
function dropIntoSession(sessionId, title, text) {
  if (!safeId(sessionId)) return { ok: false, why: 'no session id' }
  const dir = inboxDir(sessionId)
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${id}.tmp`)
    writeFileSync(tmp, JSON.stringify({ title, text, at: new Date().toISOString() }))
    renameSync(tmp, join(dir, `${id}.json`))
    return { ok: true, why: id }
  } catch (e) {
    return { ok: false, why: `write failed: ${e?.message ?? e}` }
  }
}

const pendingIn = (sessionId) => {
  try { return readdirSync(inboxDir(sessionId)).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
}

/** Take every pending message (oldest first) and remove it from the inbox — called by the hooks that put the
 *  messages in front of the model, so each is handed over exactly once. */
function takeInbox(sessionId) {
  const out = []
  for (const n of pendingIn(sessionId)) {
    const p = join(inboxDir(sessionId), n)
    try { out.push(JSON.parse(readFileSync(p, 'utf8'))) } catch { /* unreadable: drop it rather than loop on it */ }
    try { rmSync(p, { force: true }) } catch { /* taken */ }
  }
  return out
}

const listenerPidFile = (sessionId) => join(LISTENERS, `${safeId(sessionId)}.pid`)
function listenerAlive(sessionId) {
  try {
    const pid = Number(readFileSync(listenerPidFile(sessionId), 'utf8').trim())
    return Boolean(pid) && alive(pid)
  } catch { return false }
}

const fwd = (p) => p.replace(/\\/g, '/')
/** The exact command the model runs in the background; setup.mjs writes a policy that allows this prefix. */
const listenCommand = (sessionId) => `node "${fwd(join(STABLE, 'bridge.mjs'))}" --listen ${safeId(sessionId)}`

/** What the model is told when the session's listener is not running. */
function listenerInstruction(sessionId) {
  return [
    `RANY: this Gemini session is not listening for RANY work right now. Before anything else, start the listener`,
    `in the BACKGROUND with run_shell_command — exactly this command, is_background: true, description "RANY listener":`,
    `  ${listenCommand(sessionId)}`,
    `It waits silently and ends with one line when RANY sends this session work; when that happens, RANY's`,
    `message is in your context — handle it, then start the listener again the same way.`,
  ].join('\n')
}

/** Copy the scripts to ~/.rany-plugin/gemini so the listener command stays stable across extension updates. */
function syncStable() {
  try {
    mkdirSync(STABLE, { recursive: true })
    for (const f of ['bridge.mjs', 'mcp-proxy.mjs']) {
      const src = join(here, f)
      if (!existsSync(src) || samePath(src, join(STABLE, f))) continue
      const next = readFileSync(src)
      let cur = null
      try { cur = readFileSync(join(STABLE, f)) } catch { /* first time */ }
      if (!cur || !cur.equals(next)) writeFileSync(join(STABLE, f), next)
    }
    const v = join(here, '..', 'version.json')
    if (existsSync(v)) writeFileSync(join(STABLE, 'version.json'), readFileSync(v))
  } catch { /* the listener command still works from the extension path the next time */ }
}

/** A hook's JSON answer (Gemini parses stdout as JSON on exit 0; plain text there is a protocol error). */
function hookReply(eventName, context, systemMessage) {
  const body = {}
  if (context) body.hookSpecificOutput = { hookEventName: eventName, additionalContext: context }
  if (systemMessage) body.systemMessage = systemMessage
  process.stdout.write(JSON.stringify(body) + '\n')
}

const formatMessages = (msgs) => msgs.map((m) => m.text).join('\n\n---\n\n')

// ---- unrouted boards ----------------------------------------------------------------------------

function noteUnrouted(boardId, guildId, d) {
  if (!boardId) return
  let seen = {}
  try { seen = JSON.parse(readFileSync(unroutedFile, 'utf8')).boards ?? {} } catch { /* first one */ }
  seen[boardId] = { guildId, lastTaskId: String(d.id ?? ''), lastTitle: String(d.title ?? ''), lastSeen: new Date().toISOString() }
  try { mkdirSync(dirname(unroutedFile), { recursive: true }); writeFileSync(unroutedFile, JSON.stringify({ boards: seen }, null, 2)) }
  catch { /* the silence is not lost */ }
}
function listUnrouted() {
  let seen = {}
  try { seen = JSON.parse(readFileSync(unroutedFile, 'utf8')).boards ?? {} } catch { /* none */ }
  const bound = loadBindings()
  const rows = Object.entries(seen).filter(([id]) => !bound[id])
  if (rows.length === 0) return 'RANY: no unrouted boards seen. Copy a board id from RANY (board header → ID) to bind one.'
  return ['RANY: boards seen on an assignment but bound to no repository:',
    ...rows.map(([id, v]) => `  ${id}  — last: "${v.lastTitle}" (${v.lastSeen.slice(0, 16).replace('T', ' ')})`),
    '', 'Run /rany:rany-bind <boardId> in the repository that owns that board.'].join('\n')
}

// ---- board claims -----------------------------------------------------------------------------

function declareBoards(projectKey, boardIds, timeoutMs = 5000, extra = {}) {
  return postJson('/personas/@self/boards', { projectKey, boardIds, ...extra }, timeoutMs)
}
const claimKey = (s) => projectKeyOf(`${s.dir}|gemini|${s.sessionId}`)
function boardsForSession(bindings, s) {
  return Object.entries(bindings).filter(([, e]) => ownerOf(e)?.sessionId === String(s.sessionId)).map(([id]) => id)
}
async function refreshClaims() {
  const bindings = loadBindings()
  const known = new Set()
  for (const s of liveSessions()) {
    const key = claimKey(s)
    known.add(key)
    await declareBoards(key, boardsForSession(bindings, s), 5000, { ref: s.sessionId })
  }
  let previous = []
  try { previous = JSON.parse(readFileSync(stateFile, 'utf8')).projects ?? [] } catch { /* first run */ }
  for (const key of previous) if (!known.has(key)) await declareBoards(key, [])
  try { writeFileSync(stateFile, JSON.stringify({ projects: [...known] })) } catch { /* best effort */ }
}

// ---- home, bind, join, rejoin ----------------------------------------------------------------------

async function homeTarget() {
  const h = (await getJson('/personas/@self/home'))?.home
  return h && h.agent === AGENT && h.live && h.ref ? { dir: h.label || process.cwd(), sessionId: h.ref } : null
}

async function setHome({ dir, sessionId }) {
  if (!sessionId) return 'RANY: could not tell which Gemini session this is — type a prompt in it first, then /rany:rany-home again.'
  const r = await postJson('/personas/@self/home', { agent: AGENT, ref: sessionId, label: dir })
  if (!r) return 'RANY: could not reach RANY to set the home — check the Gemini token (scripts/setup.mjs --token) and RANY_API_URL.'
  if (!r.ok) return `RANY: the home was refused (${r.body?.error ?? r.status}).`
  noteSession(dir, sessionId)
  return [
    `RANY: this Gemini session is now your persona's home (${dir}).`,
    `Being addressed in a channel, forwards and workflow steps are delivered to THIS session and no other.`,
    `While it is closed, RANY's hosted AI answers them if a model key is stored — otherwise they wait here.`,
  ].join('\n')
}

async function fetchBoardInfo(boardId) { return getJson(`/personas/@self/boards/${boardId}`) }

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

function bindingFor(dir, sessionId, extra = {}) {
  return { dir, agent: AGENT, geminiSessionId: sessionId, ts: Date.now(), ...extra }
}

/** Seat THIS Gemini session in a work room from an invite code (ADR-046). Returns
 *  `{ ok, short, brief }`: `short` is what the prompt hook shows the owner, `brief` what the model gets. */
async function joinSeat({ code, dir, sessionId }) {
  if (!sessionId) return { ok: false, short: 'RANY: could not tell which Gemini session this is — send one prompt first, then paste the link again.' }
  const boards = loadBindings()
  const held = Object.entries(boards).find(([, e]) => ownerOf(e) && e.room?.invite === code)
  if (held && ownerOf(held[1]).sessionId === sessionId)
    return { ok: false, short: `RANY: this session already sits in that work room as "${held[1].room.name}" (agentId ${held[0]}).` }
  const res = await postJson('/personas/@self/rooms/join', { code, name: `${basename(dir)} · Gemini`.slice(0, 40), agent: AGENT }, 6000)
  if (!res?.ok)
    return { ok: false, short: `RANY: could not join the work room — ${JOIN_REFUSALS[res?.body?.error] ?? `the server refused (${res?.status ?? 'offline'})`}.` }
  const seat = res.body
  boards[seat.agentId] = bindingFor(dir, sessionId, { room: { channelId: seat.channelId, guildId: seat.guildId, name: seat.name, invite: code } })
  try { saveBindings(boards) } catch (e) {
    return { ok: false, short: `RANY: joined the work room, but could not save the seat binding (${e?.message ?? e}).` }
  }
  recordSeat(dir, seat.agentId, seat)
  noteSession(dir, sessionId)
  const s = { dir, sessionId }
  await declareBoards(claimKey(s), boardsForSession(loadBindings(), s), 5000, { ref: sessionId })
  return {
    ok: true,
    short: `RANY: this Gemini session joined the work room at channel ${seat.channelId} as "${seat.name}" (agentId ${seat.agentId}).`,
    brief: [
      `RANY: THIS Gemini session joined the work room at channel ${seat.channelId} as "${seat.name}" (agentId ${seat.agentId}).`,
      `From now on room messages for that seat are delivered to this session, until it closes.`,
      `Next: get_room({channelId:"${seat.channelId}"}) and read the brief documents it lists; then tell the room in ONE`,
      `line which part of the job you take — post_message({channelId:"${seat.channelId}", agentId:"${seat.agentId}", content:"…"}).`,
    ].join('\n'),
  }
}

const REATTACH_REFUSALS = {
  no_agent: 'the seat no longer exists (removed, or the room was closed)',
  no_room: 'the room is gone',
  persona_not_active: 'the persona is paused',
}

function heldByAnotherLiveSession(id, sessionId) {
  const o = ownerOf(claimedBy(id))
  if (!o || o.sessionId === String(sessionId)) return false
  return liveSessions().some((row) => row.sessionId === o.sessionId)
}

async function reattachSeat({ agentId, h, dir, sessionId }) {
  const res = await postJson(`/personas/@self/rooms/${agentId}/reattach`, { agent: AGENT }, 6000)
  if (!res?.ok) {
    if (res?.body?.error === 'no_agent' || res?.body?.error === 'no_room') forgetSeat(dir, agentId)
    return `RANY: could not take back seat "${h?.name ?? agentId}" in work room ${h?.channelId ?? '?'} — `
      + `${REATTACH_REFUSALS[res?.body?.error] ?? `the server refused (${res?.status ?? 'offline'})`}.`
  }
  const seat = res.body
  const boards = loadBindings()
  boards[seat.agentId] = bindingFor(dir, sessionId, { room: { channelId: seat.channelId, guildId: seat.guildId, name: seat.name, invite: null } })
  try { saveBindings(boards) } catch (e) { return `RANY: took back the seat, but could not save the binding (${e?.message ?? e}).` }
  recordSeat(dir, seat.agentId, seat)
  noteSession(dir, sessionId)
  const s = { dir, sessionId }
  await declareBoards(claimKey(s), boardsForSession(loadBindings(), s), 5000, { ref: sessionId })
  return [
    `RANY: THIS Gemini session holds its seat "${seat.name}" in work room ${seat.channelId} again (agentId ${seat.agentId})`
      + `${seat.state === 'paused' ? ' — the owner has it PAUSED, so wait to be resumed' : ''}.`,
    `When the room speaks to you, get_room({channelId:"${seat.channelId}"}) catches you up and post_message({channelId:"${seat.channelId}", agentId:"${seat.agentId}", …}) answers.`,
  ].join('\n')
}

async function reattachRememberedSeats({ dir, sessionId }) {
  const lines = []
  const mine = new Set(boardsForSession(loadBindings(), { dir, sessionId }))
  for (const [id, h] of seatsForRepo(dir)) {
    if (mine.has(id)) continue
    if (heldByAnotherLiveSession(id, sessionId)) {
      lines.push(`RANY: seat "${h?.name ?? id}" in work room ${h?.channelId ?? '?'} is held by another open Gemini session of this repo; /rany:rany-rejoin ${id} moves it here.`)
      continue
    }
    lines.push(await reattachSeat({ agentId: id, h, dir, sessionId }))
  }
  return lines
}

// ---- commands -----------------------------------------------------------------------------------

const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? undefined : (process.argv[i + 1] ?? '') }
const has = (name) => process.argv.includes(name)
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n')

if (has('--bind')) {
  const boardId = arg('--bind')
  if (!boardId) { out(listUnrouted()); process.exit(0) }
  if (!/^[0-9]+$/.test(boardId)) { out('RANY: --bind needs a board id (RANY → board header → ID), or no argument to list unrouted boards'); process.exit(0) }
  const dir = process.cwd()
  const sessionId = lastPromptedSession(dir)
  if (!sessionId) { out('RANY: no Gemini session is known in this directory yet — send a prompt in it, then bind again.'); process.exit(0) }
  const info = await fetchBoardInfo(boardId)
  const label = info?.name ? (info.guildName ? `${info.name} (${info.guildName})` : info.name) : `board ${boardId}`
  const boards = loadBindings()
  boards[boardId] = bindingFor(dir, sessionId, { boardName: info?.name ?? null, guildName: info?.guildName ?? null })
  try { saveBindings(boards); recordHistory(dir, boardId, info) } catch (e) { out(`RANY: could not save the binding (${e?.message ?? e})`); process.exit(0) }
  noteSession(dir, sessionId)
  const s = { dir, sessionId }
  await declareBoards(claimKey(s), boardsForSession(loadBindings(), s), 5000, { ref: sessionId })
  out(`RANY: ${label} is now handled in THIS Gemini session (${dir}). It stops when this session closes; bind again in another to move it.`)
  process.exit(0)
}

if (has('--join')) {
  const raw = String(arg('--join') ?? '').trim()
  const code = inviteCodeIn(raw) ?? (/^[A-Za-z0-9]{8,64}$/.test(raw) ? raw : null)
  if (!code) { out('RANY: --join needs the work-room invite link (RANY → the room → Invite agent)'); process.exit(0) }
  const dir = process.cwd()
  const r = await joinSeat({ code, dir, sessionId: lastPromptedSession(dir) })
  out(r.brief ?? r.short)
  process.exit(0)
}

if (has('--rejoin')) {
  const raw = String(arg('--rejoin') ?? '').trim()
  const dir = process.cwd()
  const sessionId = lastPromptedSession(dir)
  if (!sessionId) { out('RANY: no Gemini session is known in this directory yet — send a prompt in it first.'); process.exit(0) }
  if (raw && !/^[0-9]+$/.test(raw)) { out('RANY: --rejoin takes a seat id, or no argument for every seat this repo held'); process.exit(0) }
  if (raw) {
    const h = seatsForRepo(dir).find(([id]) => id === raw)?.[1]
    out(await reattachSeat({ agentId: raw, h, dir, sessionId }))
  } else {
    const lines = await reattachRememberedSeats({ dir, sessionId })
    out(lines.length ? lines.join('\n') : 'RANY: this repo holds no remembered work-room seat. Paste an invite link to join a room.')
  }
  process.exit(0)
}

if (has('--home')) {
  const dir = process.cwd()
  out(await setHome({ dir, sessionId: lastPromptedSession(dir) }))
  process.exit(0)
}

function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
function daemonRunning() {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    return Boolean(pid) && alive(pid)
  } catch { return false }
}

/** Start the machine's daemon from a hook, detached from the hook's pipes (Gemini waits for a hook's output
 *  pipes to CLOSE, so anything left attached would hang the CLI). On Windows through WMI, so it belongs to no caller's job object — see the Codex bridge. */
function spawnDaemon() {
  const script = join(here, 'bridge.mjs')
  if (process.platform === 'win32') {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`
    const cmdLine = `${q(process.execPath)} ${q(script)} --daemon`
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}' }; exit ([int]$r.ReturnValue)`
    try {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true, timeout: 8000 })
      if (r.status === 0) return
    } catch { /* fall through */ }
  }
  try {
    const child = spawn(process.execPath, [script, '--daemon'], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch { /* the next hook tries again */ }
}

/** `--notify <sessionId> <text>`: deliver a wake by hand — the diagnostic for "does this session wake at all". */
if (has('--notify')) {
  const i = process.argv.indexOf('--notify')
  const sid = process.argv[i + 1]
  const text = process.argv.slice(i + 2).join(' ') || 'RANY: test notification — reply with the single word RECEIVED.'
  if (!sid) { out('RANY: --notify <geminiSessionId> [text]'); process.exit(0) }
  const r = dropIntoSession(sid, 'RANY: test notification', text)
  out(r.ok ? `RANY: put ${r.why} in the inbox of Gemini session ${sid} (listener ${listenerAlive(sid) ? 'running' : 'NOT running'})` : `RANY: not delivered — ${r.why}`)
  process.exit(0)
}

/**
 * `--listen <sessionId>`: the listener the model starts with run_shell_command (is_background: true). It waits
 * without printing — a background shell's output is only injected when it ENDS — and exits with one short line
 * as soon as the session's inbox has something. The full message is not printed: Gemini squashes the whitespace
 * of an injected output and caps it, so the BeforeAgent hook of the turn this starts hands the model the
 * formatted text instead. One listener per session (a second one exits at once); gives up after a day.
 */
if (has('--listen')) {
  const sid = safeId(arg('--listen') ?? '')
  if (!sid) { out('RANY: --listen <geminiSessionId>'); process.exit(0) }
  if (listenerAlive(sid)) { out('RANY: a listener for this session is already running.'); process.exit(0) }
  try { mkdirSync(LISTENERS, { recursive: true }); writeFileSync(listenerPidFile(sid), String(process.pid)) } catch { /* still listen */ }
  const release = () => { try { if (Number(readFileSync(listenerPidFile(sid), 'utf8').trim()) === process.pid) rmSync(listenerPidFile(sid), { force: true }) } catch { /* gone */ } }
  process.on('exit', release)
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
  const started = Date.now()
  await new Promise((resolve) => {
    const tick = () => {
      if (pendingIn(sid).length > 0) return resolve()
      if (Date.now() - started > 24 * 3600_000) return resolve()
      setTimeout(tick, 1000)
    }
    tick()
  })
  const n = pendingIn(sid).length
  out(n > 0
    ? `RANY: ${n} new ${n === 1 ? 'message' : 'messages'} for this session. The full text is in your context under "RANY"; handle it, then restart the listener.`
    : 'RANY: the listener timed out after a day; start it again.')
  process.exit(0)
}

if (has('--status')) {
  const s = liveSessions()
  out([
    `RANY Gemini bridge ${VERSION}`,
    `  token:   ${config.token ? 'set' : 'MISSING (scripts/setup.mjs --token rany_persona_…)'}`,
    `  api:     ${config.apiUrl}`,
    `  daemon:  ${daemonRunning() ? 'running' : 'not running'}`,
    `  node:    ${process.version}${typeof WebSocket === 'undefined' ? ' — TOO OLD, the daemon needs Node 22+' : ''}`,
    `  sessions heard from: ${s.length ? s.map((r) => `${r.sessionId.slice(0, 8)} @ ${r.dir} (listener ${listenerAlive(r.sessionId) ? 'running' : 'not running'}, inbox ${pendingIn(r.sessionId).length})`).join(', ') : 'none'}`,
  ].join('\n'))
  process.exit(0)
}

/** Hooks (hooks/hooks.json): SessionStart = --ensure, BeforeAgent = --ping, AfterTool = --beat, SessionEnd = --bye.
 *  Gemini parses a hook's stdout as JSON, so every path prints exactly one JSON object (or nothing). */
if (has('--ensure') || has('--ping') || has('--beat')) {
  const hook = await hookInput()
  const dir = workDir(hook)
  const sessionId = sessionOf(hook) ?? (process.env.GEMINI_SESSION_ID || null)
  noteSession(dir, sessionId)
  if (!daemonRunning() && config.token && typeof WebSocket !== 'undefined') spawnDaemon()

  if (has('--beat')) {
    if (config.token && sessionId && typeof hook.tool_name === 'string') {
      const seats = Object.entries(loadBindings()).filter(([, e]) => ownerOf(e)?.sessionId === sessionId && e.room).map(([id]) => id)
      const line = seats.length ? toolLine(hook) : null
      if (line) await Promise.all(seats.map((id) => postJson(`/personas/@self/rooms/${id}/activity`, { lines: [{ kind: 'tool', text: line }] }, 4000)))
    }
    process.exit(0)
  }

  const context = []
  if (has('--ensure')) {
    syncStable()
    if (!config.token) {
      hookReply('SessionStart', null, 'RANY: installed but no Gemini token, so nothing will wake this session. '
        + 'Issue one in RANY → persona settings → Gemini CLI, then run setup.mjs --token.')
      process.exit(0)
    }
    if (sessionId) {
      context.push(...await reattachRememberedSeats({ dir, sessionId }))
      const boundHere = (id) => ownerOf(loadBindings()[String(id)])?.sessionId === sessionId
      const forgotten = historyForRepo(dir).filter(([id]) => !boundHere(id))
      if (forgotten.length > 0) {
        context.push('RANY: this repo has handled these boards before, but none are bound to THIS Gemini session:',
          ...forgotten.map(([id, h]) => '  • ' + boardLabel(id, h)), '',
          'A binding belongs to one session. To handle them here: /rany:rany-bind <boardId>')
      }
    }
  }

  // BeforeAgent: a pasted work-room invite link joins the room (ADR-046); unlike Kimi, Gemini lets the hook
  // hand the model the brief directly, so the turn simply goes on with the seat in context.
  const code = has('--ping') && config.token ? inviteCodeIn(hook.prompt) : null
  if (code) {
    const r = await joinSeat({ code, dir, sessionId })
    context.push(r.brief ?? r.short)
  }

  if (sessionId && config.token) {
    // Work that arrived for this session: the formatted text, handed over once.
    const msgs = takeInbox(sessionId)
    if (msgs.length) context.push(formatMessages(msgs))
    // Every turn checks the listener, so the one that a wake started — the listener just exited — restarts it.
    if (!listenerAlive(sessionId)) context.push(listenerInstruction(sessionId))
  }

  if (context.length) hookReply(has('--ensure') ? 'SessionStart' : 'BeforeAgent', context.join('\n\n'))
  process.exit(0)
}

if (has('--bye')) {
  const hook = await hookInput()
  const sessionId = sessionOf(hook)
  forgetSession(sessionId)
  if (sessionId) await declareBoards(claimKey({ dir: workDir(hook), sessionId }), [], 2000, { ref: sessionId, closing: true })
  dropSessionBindings(sessionId)
  process.exit(0)
}

if (has('--stop')) {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (pid && alive(pid)) process.kill(pid)
    unlinkSync(pidFile)
  } catch { /* already gone */ }
  process.exit(0)
}

if (!has('--daemon')) {
  out('RANY Gemini bridge. Usage: --status | --bind [boardId] | --join <link> | --rejoin [agentId] | --home | --ensure | --ping | --beat | --bye | --daemon | --stop')
  process.exit(0)
}

// ---- the daemon -----------------------------------------------------------------------------------

if (typeof WebSocket === 'undefined') process.exit(0)
if (!config.token) process.exit(0)

try {
  mkdirSync(HOME, { recursive: true })
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (pid && pid !== process.pid && alive(pid)) process.exit(0)
  }
  writeFileSync(pidFile, String(process.pid))
} catch { /* better a possible duplicate than a bridge that never runs */ }

logRoute('DAEMON', { pid: process.pid }, `started (node ${process.version})`)
process.on('exit', (code) => logRoute('DAEMON', { pid: process.pid }, `exit ${code}`))

const OP = { Dispatch: 0, Hello: 1, Identify: 2, Heartbeat: 3, InvalidSession: 9 }
let personaUserId = null
let personaName = null
let heartbeat = null
let socket = null

const shutdown = () => {
  if (heartbeat) clearInterval(heartbeat)
  try { socket?.close() } catch { /* closing anyway */ }
  try { if (Number(readFileSync(pidFile, 'utf8').trim()) === process.pid) unlinkSync(pidFile) } catch { /* nothing to do */ }
  process.exit(0)
}
process.on('SIGTERM', () => { logRoute('DAEMON', { pid: process.pid }, 'SIGTERM'); shutdown() })
process.on('SIGINT', () => { logRoute('DAEMON', { pid: process.pid }, 'SIGINT'); shutdown() })
process.on('uncaughtException', (e) => logRoute('CRASH', {}, `uncaughtException: ${e?.stack ?? e?.message ?? e}`))
process.on('unhandledRejection', (e) => logRoute('CRASH', {}, `unhandledRejection: ${e?.message ?? e}`))

void refreshClaims()
setInterval(() => void refreshClaims(), CLAIM_REFRESH_MS).unref?.()

function asPersona() {
  const who = personaName ? `the persona "${personaName}"` : 'your persona'
  return [
    `You act as ${who}. RANY attributes posts and comments to that name by itself: do not sign`,
    `them, and never name the model underneath ("Gemini", "— AI"). A commit made for RANY work is`,
    `${who}'s as well — author or Co-Authored-By ${personaName ?? 'the persona'} <noreply@rany.work>.`,
  ].join('\n')
}

/** Where an event belongs and what that session is told → `{ dir, sessionId, title, text }`, or null.
 *  The same decisions as the Codex bridge, keyed to Gemini sessions. */
async function route(type, d) {
  if (type === 'TASK_UPDATED') {
    const added = Array.isArray(d.addedAssigneeIds) ? d.addedAssigneeIds : []
    if (!config.wake.tasks || !added.includes(personaUserId)) return null
    const guildId = String(d.guildId ?? d.taskGuildId ?? '')
    if (taskSeatOf(d.id)) { logRoute('TASK_UPDATED', { taskId: d.id }, 'skip (handed to a room seat)'); return null }
    const boardId = String(d.boardId ?? '')
    const owner = ownerOf(claimedBy(boardId))
    if (!owner) {
      if (!claimedBy(boardId)) noteUnrouted(boardId, guildId, d)
      logRoute('TASK_UPDATED', { boardId, guildId }, claimedBy(boardId) ? 'skip (another agent\'s bind)' : 'skip (unbound)')
      return null
    }
    return {
      ...owner, title: `RANY: task "${d.title ?? ''}"`,
      text: [
        `RANY: a task was assigned to your persona.`,
        `  task ${d.id} in guild ${guildId} — "${d.title ?? '(untitled)'}"`,
        ``,
        `Read it with the rany MCP tool get_task({guildId:"${guildId}", taskId:"${d.id}"}), do the work`,
        `in this project, report what you did with comment_task, and move the card with`,
        `set_task_status (get_task lists the board's statuses). If it is not about this project, say so`,
        `in the comment instead of guessing.`,
        ``,
        asPersona(),
      ].join('\n'),
    }
  }

  if (type === 'TASK_COMMENT_CREATED') {
    if (!config.wake.comments) return null
    const guildId = String(d.guildId ?? d.taskGuildId ?? '')
    const boardId = String(d.boardId ?? '')
    const seatId = taskSeatOf(d.taskId)
    const owner = ownerOf(claimedBy(seatId ?? boardId))
    if (!owner) { logRoute('TASK_COMMENT_CREATED', { boardId, guildId }, 'skip (not bound to a Gemini session)'); return null }
    const c = d.comment ?? {}
    return {
      ...owner, title: 'RANY: new task comment',
      text: [
        `RANY: a new comment on a task assigned to your persona.`,
        `  task ${d.taskId} in guild ${guildId} — comment by user ${c.authorId ?? '?'}:`,
        `  ${c.content ?? ''}`,
        ``,
        `Re-read the task with get_task({guildId:"${guildId}", taskId:"${d.taskId}"}), do what the comment`,
        `asks in this project, reply with comment_task, and move the card with set_task_status if needed.`,
        ``,
        asPersona(),
      ].join('\n'),
    }
  }

  if (type === 'PERSONA_WORKFLOW') {
    if (config.wake.workflows === false) return null
    const owner = ownerOf(claimedBy(d.guildId)) ?? await homeTarget()
    if (!owner) { logRoute('PERSONA_WORKFLOW', { guildId: d.guildId, stepId: d.stepId }, 'skip (guild unclaimed, no live Gemini home)'); return null }
    const msgs = Array.isArray(d.messages) ? d.messages : []
    return {
      ...owner, title: `RANY: workflow step`,
      text: [
        `RANY: the workflow "${d.workflowName ?? d.workflowId}" in guild ${d.guildId} is running a step through your persona.`,
        `  step ${d.stepId} (run ${d.runId}) — answer within ${d.timeoutMinutes ?? 30} minutes or the run fails.`,
        `  Prompt:`,
        `  ${String(d.prompt ?? '').split('\n').join('\n  ')}`,
        ...(msgs.length ? ['', 'Recent messages of the channel this step is about:',
          ...msgs.map((m) => `  [${m.createdAt ?? ''}] user ${m.authorId ?? '?'}: ${m.content ?? ''}`)] : []),
        ``,
        `Do what the prompt asks, then send ONLY the requested content with`,
        `complete_workflow_step({stepId:"${d.stepId}", output:"…"}). No preamble, no sign-off.`,
        ``,
        asPersona(),
      ].join('\n'),
    }
  }

  if (type === 'PERSONA_ROOM_MESSAGE' || type === 'PERSONA_ROOM_UPDATED' || type === 'PERSONA_ROOM_DECISION') {
    if (config.wake.rooms === false) return null
    if (type === 'PERSONA_ROOM_UPDATED' && d.change === 'task_assigned') noteTaskSeat(d.taskId, d.agentId)
    const seats = type === 'PERSONA_ROOM_MESSAGE' ? (Array.isArray(d.targets) ? d.targets : [])
      : type === 'PERSONA_ROOM_UPDATED' ? (Array.isArray(d.agents) ? d.agents : [])
      : [{ agentId: d.agentId, boardId: d.boardId, name: d.agentName }]
    const bound = seats
      .map((s) => ({ s, owner: s ? (ownerOf(claimedBy(String(s.agentId))) ?? (s.boardId ? ownerOf(claimedBy(String(s.boardId))) : null)) : null }))
      .filter((x) => x.owner)
    const pick = bound.find((x) => String(x.s.agentId) === String(d.agentId ?? '')) ?? bound[0]
    if (!pick) { logRoute(type, { channelId: d.channelId }, 'skip (no seat bound here)'); return null }
    if (type === 'PERSONA_ROOM_MESSAGE') {
      const mates = checkoutMates(seats, pick.s.agentId, pick.owner.dir)
      if (mates.length > 0) {
        const lead = [pick.s, ...mates].sort((a, b) => (BigInt(a.agentId) < BigInt(b.agentId) ? -1 : 1))[0]
        if (!d.named && String(lead.agentId) !== String(pick.s.agentId)) {
          logRoute(type, { channelId: d.channelId, agentId: pick.s.agentId }, `skip (same checkout: ${lead.name ?? lead.agentId} takes it)`)
          return null
        }
        d.checkoutMates = mates
        d.checkoutLead = !d.named
      }
    }
    const title = type === 'PERSONA_ROOM_MESSAGE' ? 'RANY: work room message'
      : type === 'PERSONA_ROOM_DECISION' ? `RANY: permission ${d.approved ? 'approved' : 'denied'}` : 'RANY: work room update'
    return { ...pick.owner, title, text: roomPrompt(type, d, pick.s) }
  }

  if (type === 'PERSONA_ASK') {
    if (config.wake.asks === false) return null
    const owner = ownerOf(claimedBy(d.boardId)) ?? ownerOf(claimedBy(d.guildId)) ?? (d.boardId ? null : await homeTarget())
    if (!owner) { logRoute('PERSONA_ASK', { askId: d.askId, boardId: d.boardId }, 'skip (board unbound here)'); return null }
    const msgs = Array.isArray(d.messages) ? d.messages : []
    return {
      ...owner, title: 'RANY: your persona asks this project',
      text: [
        `RANY: your persona is asking THIS project a question — it is in a conversation it cannot`,
        `answer without the code.`,
        `  ask ${d.askId} — answer within ${d.timeoutMinutes ?? 10} minutes or it gives up and says so.`,
        `  Question:`,
        `  ${String(d.question ?? '').split('\n').join('\n  ')}`,
        ...(msgs.length ? ['', 'How the conversation got here:', ...msgs.map((m) => `  [${m.createdAt ?? ''}] user ${m.authorId ?? '?'}: ${m.content ?? ''}`)] : []),
        ``,
        `Work it out in this repository, then send ONLY the answer with answer_persona_ask({askId:"${d.askId}", answer:"…"}).`,
        `It is posted straight into the chat as the persona: their language, short, no preamble, no local paths.`,
        ``,
        asPersona(),
      ].join('\n'),
    }
  }

  if (type === 'PERSONA_FORWARD') {
    if (!config.wake.forwards) return null
    const owner = await homeTarget()
    if (!owner) { logRoute('PERSONA_FORWARD', { guildId: d.guildId }, 'skip (not the persona home)'); return null }
    const msgs = Array.isArray(d.messages) ? d.messages : []
    const target = msgs.find((m) => m.target) ?? msgs[msgs.length - 1]
    return {
      ...owner, title: 'RANY: forwarded conversation',
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
  if (typeof d.guildId === 'string' && d.guildId.length > 0) {
    const owner = await homeTarget()
    if (!owner) { logRoute('MESSAGE_CREATED', { guildId: d.guildId }, 'skip (not the persona home)'); return null }
    const mentions = Array.isArray(d.mentions) ? d.mentions : []
    if (mentions.includes(personaUserId) && config.wake.addressed) {
      return {
        ...owner, title: 'RANY: your persona was addressed',
        text: [
          `RANY: someone addressed your persona directly in channel ${d.channelId}.`,
          `  user ${d.authorId}: ${d.content ?? ''}`,
          ``,
          `They are asking YOUR AI, not you. Answer with post_message({channelId:"${d.channelId}", content:"…", replyToId:"${d.messageId}"}).`,
          ``,
          asPersona(),
        ].join('\n'),
      }
    }
    return null
  }
  logRoute('MESSAGE_CREATED', { channelId: d.channelId }, 'skip (chat is hosted-only, ADR-044)')
  return null
}

function crowdLines(d, seat) {
  const lines = []
  const names = (list) => list.map((s) => `"${s.name ?? s.agentId}"`).join(', ')
  const mates = Array.isArray(d.checkoutMates) ? d.checkoutMates : []
  if (mates.length > 0) {
    lines.push(d.checkoutLead
      ? `${names(mates)} — in THIS SAME CHECKOUT — ${mates.length === 1 ? 'was' : 'were'} NOT woken for this: you alone own the working tree and git here.`
      : `${names(mates)} — in THIS SAME CHECKOUT — heard this too. Agree in ONE line who touches files and git; the other only reads.`)
  }
  const others = (Array.isArray(d.targets) ? d.targets : []).filter((t) => t
    && String(t.agentId) !== String(seat.agentId) && !mates.some((m) => String(m.agentId) === String(t.agentId)))
  if (!d.named && others.length > 0) {
    lines.push(`${others.length} colleague${others.length === 1 ? '' : 's'} (${names(others)}) heard this too, each in another repository.`
      + ` Say in one line which part is yours before you start; never commit or push what you did not change.`)
  }
  return lines
}

/** The room rules — the Claude and Codex plugins' text, plus one rule learned from Codex (2026-09-16):
 *  an agent asked its owner through its own question tool, which only its terminal shows, and the room
 *  never saw the question. In a room, questions go to the room. */
function roomPrompt(type, d, seat) {
  const who = `You are "${seat.name}" (agentId ${seat.agentId}) in the work room at channel ${d.channelId}, working from THIS repository.`
  const tools = [
    `Your room tools — always pass channelId:"${d.channelId}" and agentId:"${seat.agentId}":`,
    `  get_room — the other agents, the budget, pending requests and the BRIEF docs (read the brief first);`,
    `  post_message({channelId, agentId, content}) — talk in the room in one or two sentences;`,
    `  you take instructions from your PERSONA and from posts that name you; other messages are context;`,
    `  to speak to ONE colleague, put <@agent:THEIR_ID> in the post (ids from get_room);`,
    `  to SHARE A FILE: create_upload({channelId, filename, contentType, size}) → PUT the bytes to its uploadUrl →`,
    `    post_message with attachments:[{key, filename, contentType, size}];`,
    `  set_agent_status — the one line your tile shows; keep it current;`,
    `  request_permission — BEFORE anything destructive, production-facing, costly or outside this repo;`,
    `  list_board_tasks / get_task / create_task / set_task_status / comment_task / assign_task — the work queue.`,
    `NEVER ask your owner through ask_user (or any question tool of your own) while you sit in a room: only this terminal shows it and the room`,
    `never sees it. A decision goes through request_permission (a card in the chat); a question through post_message.`,
    `FORMAT posts in markdown: **bold** the state, \`code\` for paths/commands/ids, "- " lists, full https:// links.`,
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
      ...files, ``, who,
      ...(d.addressed ? [`You were addressed BY NAME in that message — it is for you.`] : []),
      ...(d.fromMember ? [`A member speaks with the owner's leave, not the owner's authority: anything destructive,`,
        `production-facing or costly still goes through request_permission to your OWNER first.`] : []),
      ...crowdLines(d, seat),
      `Turns left before the room waits for the owner: ${d.turnsLeft ?? '?'}. Speak when you have something to add.`,
      ...(d.addressed ? [`If the answer needs more than a moment of work, post ONE line first — what you understood and`,
        `what you are about to do — then do it and report.`] : []),
      ...tools, ``, asPersona(),
    ].join('\n')
  }
  if (type === 'PERSONA_ROOM_DECISION') {
    return [
      `RANY: your owner ${d.approved ? 'APPROVED' : 'DENIED'} your permission request in work room ${d.channelId}.`,
      `  You asked: ${String(d.question ?? '')}`,
      ...(d.note ? [`  Their note: ${d.note}`] : []),
      ``, who,
      d.approved ? `Go ahead with exactly what was approved — nothing broader.` : `Do not do it. Find another way, or ask again with a narrower request.`,
      ...tools, ``, asPersona(),
    ].join('\n')
  }
  const mine = String(d.agentId ?? '') === String(seat.agentId)
  const stop = d.change === 'room_paused' || d.change === 'closed' || (mine && (d.change === 'agent_paused' || d.change === 'agent_removed'))
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
  // Most room updates are about someone else: they are not worth a Gemini turn. Wake only for what changes
  // this seat's work.
  const worthATurn = stop || d.change === 'budget_exhausted' || (mine && (d.change === 'agent_joined' || d.change === 'task_assigned' || d.change === 'agent_resumed'))
  if (!worthATurn) return null
  const next = stop
    ? [`STOP working on this room's job now and do not post there until you are resumed. Leave what you were doing in a safe state.`]
    : d.change === 'budget_exhausted' ? [`Do not post in the room until the owner writes there again.`]
    : d.change === 'agent_joined' ? [`Read the brief (get_room), then tell the room in one line which part you take.`]
    : d.change === 'task_assigned' ? [
        `It is yours now. Read it with get_task({guildId:"${d.taskGuildId}", taskId:"${d.taskId}"}), do it in this repository,`,
        `report on the card with comment_task, move it with set_task_status, and say in one room line that you took it.`]
    : [`Carry on with your part of the job.`]
  return [`RANY: work room ${d.channelId} — ${what}.`, ``, who, ...next, ...tools, ``, asPersona()].join('\n')
}

function deliver(type, ids, target) {
  if (!target?.text) { logRoute(type, ids, 'skip (nothing worth a turn)'); return }
  const r = dropIntoSession(target.sessionId, target.title ?? 'RANY', target.text)
  logRoute(type, ids, r.ok ? `dropped -> ${target.sessionId} (${r.why}) @ ${target.dir}` : `drop FAILED -> ${target.sessionId}: ${r.why}`)
}

function connect() {
  try { socket = new WebSocket(config.gatewayUrl) } catch { return void setTimeout(connect, 15000) }
  socket.addEventListener('message', async (ev) => {
    let frame
    try { frame = JSON.parse(String(ev.data)) } catch { return }
    if (frame.op === OP.Hello) {
      const interval = frame.d?.heartbeatInterval ?? 30000
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = setInterval(() => { try { socket.send(JSON.stringify({ op: OP.Heartbeat })) } catch { /* close follows */ } }, interval)
      socket.send(JSON.stringify({ op: OP.Identify, d: { token: config.token, features: ['home'] } }))
      return
    }
    if (frame.op === OP.InvalidSession) { logRoute('AUTH', {}, 'gateway refused the persona token — daemon exiting'); shutdown(); return }
    if (frame.op !== OP.Dispatch) return
    if (frame.t === 'READY') {
      personaUserId = String(frame.d?.userId ?? '') || null
      personaName = String(frame.d?.persona?.displayName ?? '').trim() || null
      return
    }
    if (!personaUserId) return
    const d = frame.d ?? {}
    const target = await route(frame.t, d)
    if (target) deliver(frame.t, { boardId: d.boardId, guildId: d.guildId, channelId: d.channelId }, target)
  })
  socket.addEventListener('close', () => { if (heartbeat) clearInterval(heartbeat); setTimeout(connect, 3000) })
  socket.addEventListener('error', () => { /* 'close' follows and owns the retry */ })
}

connect()
