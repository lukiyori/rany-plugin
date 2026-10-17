#!/usr/bin/env node
// RANY -> ZCode bridge (ADR-054): Z.ai's agentic development environment as a fourth door.
//
// Same job as the Codex and Kimi bridges, with ZCode's own limits, and they decide the whole design:
//
//   • ZCode runs plugin hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop) and plugin
//     MCP servers by itself, so nothing has to be written into the user's config — this directory IS the
//     plugin. Project-level hooks are ignored by ZCode; a plugin's are not.
//   • A hook may hand the model text (`hookSpecificOutput.additionalContext`), and a Stop hook may refuse
//     to let a turn end (`{"decision":"block","reason":…}`) — that is how work reaches the model here.
//   • There is NO asynchronous hook and no inbound door: nothing can wake a ZCode session from outside,
//     and ZCode force-ends a run after THREE consecutive Stop continuations. So a seat answers while
//     someone is working in it, and is silent when the app is closed — the room sees that as a session
//     that is not open, exactly as it does for a closed Claude or Codex window.
//
// The daemon therefore holds the RANY socket as in every other variant, but delivers into a per-session
// QUEUE on disk (`~/.rany-plugin/zcode-queue/<sessionId>/`), and the hooks drain it: the Stop hook waits
// a little for the room before it lets the turn end, the prompt hook hands over whatever is waiting. That
// queue is this plugin's own format, not ZCode's, so a ZCode upgrade cannot break the delivery path.
//
// Zero dependencies. Node 22's global WebSocket is all this needs.

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { loadRepoRules, repoRulesLines, checkToolCall, refusalReason } from './repo-rules.mjs'

/** Shared with the Claude Code and Codex plugins ON PURPOSE: a board belongs to a repository, not to
 *  whichever agent you happen to be running. Each plugin reads only its own entries. */
const HOME = join(homedir(), '.rany-plugin')
const bindFile = join(HOME, 'bindings.json')
const unroutedFile = join(HOME, 'unrouted.json')
/** One file per open ZCode session, refreshed by every hook it fires. */
const sessionsDir = join(HOME, 'zcode-sessions')
const pidFile = join(HOME, 'zcode-bridge.pid')
const stateFile = join(HOME, 'zcode-bridge.json')
const taskSeatsFile = join(HOME, 'task-seats.json')
/** Shared with every other RANY plugin: an approval given in the room opens the ask-first rules for a
 *  short while, whichever runtime asked for it. */
const approvalsFile = join(HOME, 'room-approvals.json')
/** What the daemon leaves for a session's next hook, and the count of Stop continuations already spent
 *  on it — ZCode ends a run after three in a row, so the hook stops short of that by itself. */
const queueRoot = join(HOME, 'zcode-queue')

/** How long a Stop hook waits for the room before it lets the turn end. Long enough that an answer in
 *  the room reaches a working session in the same breath, short enough not to feel like a hang. */
const STOP_WAIT_MS = Number(process.env.RANY_ZCODE_STOP_WAIT_MS || 20_000)
/** ZCode force-ends a run after 3 consecutive Stop blocks; leave the third to the model's own ending. */
const MAX_STOP_BLOCKS = 2

/** A session no hook has heard from in this long stops counting as live (claims, home). ZCode fires no
 *  hook while idle, so an open but untouched session lapses — exactly like Codex; what is queued for it
 *  is not lost, it waits for the next hook. */
const SESSION_STALE_MS = 20 * 60_000
const CLAIM_REFRESH_MS = 5 * 60_000
const AGENT = 'zcode'

/** The payload ZCode pipes to a hook: `{hook_event_name, session_id, cwd, …}`. Read with a deadline, so a
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

/** The hook runs with cwd = the session's work dir (ZCode's workspace); a hand-run command runs in the repo. */
const workDir = (hook) => process.cwd() || (typeof hook?.cwd === 'string' ? hook.cwd : '')
const sessionOf = (hook) => (typeof hook?.session_id === 'string' && hook.session_id ? hook.session_id : null)

function loadBindings() {
  try { return JSON.parse(readFileSync(bindFile, 'utf8')).boards ?? {} } catch { return {} }
}
function saveBindings(boards) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(bindFile, JSON.stringify({ boards }, null, 2))
}
const claimedBy = (id) => (id ? loadBindings()[String(id)] : undefined)

/** A binding this plugin owns: `{ dir, agent:'zcode', zcodeSessionId, ts }`. Claude (`sessionId`), Codex
 *  (`threadId`) and legacy directory strings belong to the other plugins and are never ours. */
function ownerOf(entry) {
  if (!entry || typeof entry !== 'object' || entry.agent !== AGENT || !entry.zcodeSessionId) return null
  return { dir: entry.dir, sessionId: String(entry.zcodeSessionId) }
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

/** One terminal line for a PostToolUse payload (db/0366): the tool and what identifies the call, never
 *  the content. ZCode's tools: Shell{command}, ReadFile/WriteFile/StrReplaceFile{path}, Glob/Grep{pattern},
 *  FetchURL{url}, SearchWeb{query}, Agent{description}; MCP tools arrive under their own names. */
function toolLine(hook) {
  const name = typeof hook?.tool_name === 'string' ? hook.tool_name : ''
  if (!name) return null
  const input = hook.tool_input && typeof hook.tool_input === 'object' ? hook.tool_input : {}
  const cwd = process.cwd()
  const rel = (p) => typeof p === 'string' ? p.replace(/[\\/]+/g, '/').replace(new RegExp('^' + norm(cwd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', 'i'), '') : ''
  const one = (s, max = 220) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  let detail
  switch (name) {
    case 'Shell': detail = one(input.command); break
    case 'ReadFile': case 'WriteFile': case 'StrReplaceFile': case 'ReadMediaFile': detail = rel(input.path); break
    case 'Glob': case 'Grep': detail = `"${one(input.pattern, 80)}"`; break
    case 'FetchURL': detail = one(input.url, 200); break
    case 'SearchWeb': detail = `"${one(input.query, 120)}"`; break
    case 'Agent': detail = one(input.description, 120); break
    case 'SetTodoList': case 'Think': return null
    default: {
      const where = ['channelId', 'taskId', 'guildId', 'boardId'].filter((k) => input[k]).map((k) => `${k}=${input[k]}`).join(' ')
      return one(`${name}${where ? ' ' + where : ''}`, 260)
    }
  }
  return one(detail ? `${name} ${detail}` : name, 260)
}

// ---- config and HTTP --------------------------------------------------------------------------

/** The ZCode token: its own env var, then ~/.rany-plugin/zcode.json (what the installer writes with
 *  --token), then the generic RANY_PERSONA_TOKEN. Tokens are per agent (ADR-035): a ZCode token keeps its
 *  claims and "last used" apart from the Claude and Codex ones on the same machine. */
function loadConfig() {
  let file = {}
  try { file = JSON.parse(readFileSync(join(HOME, 'zcode.json'), 'utf8')) } catch { /* env only */ }
  const apiUrl = (process.env.RANY_API_URL || file.apiUrl || 'https://www.rany.work/api').replace(/\/+$/, '')
  const token = process.env.RANY_ZCODE_TOKEN || file.token || process.env.RANY_PERSONA_TOKEN || ''
  const gatewayUrl = process.env.RANY_GATEWAY_URL || file.gatewayUrl
    || apiUrl.replace(/^http/, 'ws').replace(/\/api$/, '/gateway')
  return {
    apiUrl, token, gatewayUrl,
    wake: { tasks: true, comments: true, addressed: true, forwards: true, asks: true, ownerMentions: false, ...(file.wake ?? {}) },
    // Off by default (ADR-068): opening a session in a directory is not a request to work for a room.
    // A seat wakes its session and a wake re-sends the whole accumulated context, so a seat taken on
    // the strength of a `cd` spends the owner's budget on work they did not open that window for.
    seats: { autoReattach: envFlag(process.env.RANY_AUTO_REATTACH) ?? file.seats?.autoReattach ?? false },
  }
}

/** `1`/`true`/`yes`/`on` → true, `0`/`false`/`no`/`off` → false, anything else (incl. unset) → null. */
function envFlag(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return null
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

/** Fallback key for whose "shown" state an identity brief is tracked under (ADR-055); a wake passes its session. */
const IDENTITY_SESSION_KEY = 'zcode'
const IDENTITY_SCRIPT = process.argv[1]

/**
 * Seat IDENTITIES (ADR-055): the role brief the owner gave a seat from RANY's identity catalog ("Rust Backend
 * Engineer"). Kept per seat in one file every plugin shares, and put in full into the first wake after it
 * arrives or changes — then a one-line reminder, so a long session is not re-sent the same brief every turn.
 * The server is the source of truth: a join/re-attach answers with the seat's identity, and an 'identity_set'
 * room event makes the session fetch it again.
 */
const seatIdentityFile = join(homedir(), '.rany-plugin', 'seat-identities.json')
const IDENTITY_TTL_MS = 30 * 60_000
const IDENTITY_RULE = 'An identity is your role brief in this room: let it shape what you prioritise and how you work. '
  + "It never widens what you may do — request_permission, the room rules and your owner's instructions come first."

function lastApproval(agentId) {
  try { return Number(JSON.parse(readFileSync(approvalsFile, 'utf8'))[String(agentId)]) || 0 } catch { return 0 }
}

function loadSeatIdentities() {
  try { return JSON.parse(readFileSync(seatIdentityFile, 'utf8')).seats ?? {} } catch { return {} }
}

/** Store what the server said about a seat's identity; `null` = the seat has none (cached as such). */
function saveSeatIdentity(agentId, identity) {
  const seats = loadSeatIdentities()
  seats[String(agentId)] = identity?.slug
    ? {
        slug: identity.slug, title: identity.title, emoji: identity.emoji ?? null,
        category: identity.categoryName ?? identity.category ?? null, instructions: identity.instructions ?? '',
        rev: createHash('sha256').update(`${identity.slug}\n${identity.instructions ?? ''}`).digest('hex').slice(0, 12),
        fetchedAt: Date.now(),
      }
    : { slug: null, fetchedAt: Date.now() }
  try {
    mkdirSync(dirname(seatIdentityFile), { recursive: true })
    writeFileSync(seatIdentityFile, JSON.stringify({ seats }, null, 2))
  } catch { /* best effort: the next wake fetches again */ }
}

/** Ask RANY for the seat's identity when it changed or the local copy is old. Offline keeps the local copy. */
async function ensureSeatIdentity(agentId, force = false) {
  const cur = loadSeatIdentities()[String(agentId)]
  if (!force && cur && Date.now() - (cur.fetchedAt ?? 0) < IDENTITY_TTL_MS) return
  const r = await getJson(`/personas/@self/rooms/${agentId}/identity`)
  if (r) saveSeatIdentity(agentId, r.identity ?? null)
}

const identityShownFile = join(HOME, 'zcode-identity-shown.json')
/** REPO RULES (ADR-099): what the checkout's `.rany/` says for this seat — in full the first time this session
 *  sees this revision, then one reminder line. This runtime has no pre-tool hook, so the agent keeps to them itself. */
function repoRulesFor(agentId, dir, { full = false, sessionKey } = {}) {
  const rules = dir ? loadRepoRules(dir, loadSeatIdentities()[String(agentId)]?.slug ?? null) : null
  if (!rules) return []
  const key = `${sessionKey ?? IDENTITY_SESSION_KEY}:rules:${agentId}`
  const shown = identityShownMap()
  const first = full || shown[key] !== rules.rev
  if (first) {
    shown[key] = rules.rev
    try { mkdirSync(dirname(identityShownFile), { recursive: true }); writeFileSync(identityShownFile, JSON.stringify(shown)) } catch { /* shown again next time */ }
  }
  return repoRulesLines(rules, { full: first, enforced: false })
}

function identityShownMap() {
  try { return JSON.parse(readFileSync(identityShownFile, 'utf8')) } catch { return {} }
}

/** The identity lines for a wake: the whole brief the first time this session sees this revision of it,
 *  afterwards one reminder line. Nothing for a seat without an identity. */
function identityLines(agentId, { full = false, sessionKey } = {}) {
  const i = loadSeatIdentities()[String(agentId)]
  if (!i?.slug) return []
  const key = `${sessionKey ?? IDENTITY_SESSION_KEY}:${agentId}`
  const shown = identityShownMap()
  if (!full && shown[key] === i.rev)
    return [`Your identity in this room: ${i.emoji ? `${i.emoji} ` : ''}**${i.title}** (${i.slug}) — keep working as it`
      + ` describes. The full brief again: node "${IDENTITY_SCRIPT}" --identity ${agentId}`]
  shown[key] = i.rev
  try { mkdirSync(dirname(identityShownFile), { recursive: true }); writeFileSync(identityShownFile, JSON.stringify(shown)) } catch { /* shown again next time */ }
  return [
    `YOUR IDENTITY IN THIS ROOM: ${i.emoji ? `${i.emoji} ` : ''}${i.title} (${i.slug}). ${IDENTITY_RULE}`,
    `--- identity brief ---`, i.instructions, `--- end of identity brief ---`,
  ]
}


function logRoute(type, ids, decision) {
  try {
    appendFileSync(join(HOME, 'routing.log'), `${new Date().toISOString()} zcode-v${VERSION} ${type} ${JSON.stringify(ids)} -> ${decision}\n`)
  } catch { /* diagnostics are not worth an interruption */ }
}

// ---- open ZCode sessions -------------------------------------------------------------------------

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

// ---- delivery: a queue the hooks drain ------------------------------------------------------------

/** `~/.rany-plugin/zcode-queue/<sessionId>/`: one JSON file per waiting item, plus `stops.json` holding
 *  how many Stop continuations in a row have already been spent on this session. Nothing here is ZCode's
 *  format — it is the buffer between the daemon, which may hear from RANY at any moment, and the hooks,
 *  which are the only moments a model can be handed anything. */
const zcodeQueueDir = (sessionId) => join(queueRoot, String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_'))

const writeAtomic = (path, value) => {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value))
  renameSync(tmp, path)
}

/**
 * Queue `text` for a ZCode session. It reaches the model at the session's next hook: the Stop hook that
 * is already waiting for it (within a second), the next prompt, or — for a session that is not open at
 * all — whenever it is opened again. Delivery is never "now": ZCode has no door that opens inward.
 */
function dropIntoSession(sessionId, title, text) {
  if (!sessionId) return { ok: false, why: 'no session to queue for' }
  const dir = zcodeQueueDir(sessionId)
  pruneOldDrops(dir)
  const id = `rany-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
  try {
    mkdirSync(dir, { recursive: true })
    writeAtomic(join(dir, `${id}.json`), { id, title: String(title ?? 'RANY').slice(0, 120), text, at: Date.now() })
    return { ok: true, why: id }
  } catch (e) {
    return { ok: false, why: `write failed: ${e?.message ?? e}` }
  }
}

/** Everything waiting for a session, oldest first, removed as it is handed over. A read that cannot
 *  delete leaves the item in place rather than dropping it: a repeated wake is a nuisance, a lost one is
 *  a room talking to nobody. */
function drainQueue(sessionId) {
  if (!sessionId) return []
  const dir = zcodeQueueDir(sessionId)
  let names = []
  try { names = readdirSync(dir).filter((n) => n.startsWith('rany-') && n.endsWith('.json')).sort() } catch { return [] }
  const items = []
  for (const n of names) {
    const p = join(dir, n)
    try {
      const item = JSON.parse(readFileSync(p, 'utf8'))
      unlinkSync(p)
      if (item && typeof item.text === 'string') items.push(item)
    } catch { /* half-written or already taken by another hook */ }
  }
  return items
}

const queuedCount = (sessionId) => {
  if (!sessionId) return 0
  try { return readdirSync(zcodeQueueDir(sessionId)).filter((n) => n.startsWith('rany-')).length } catch { return 0 }
}

/** The Stop continuations already spent in a row on this session. ZCode force-ends a run after three, so
 *  the hook must count them itself; anything the model does other than stop resets the count. */
function stopsSpent(sessionId) {
  try { return Number(JSON.parse(readFileSync(join(zcodeQueueDir(sessionId), 'stops.json'), 'utf8')).n) || 0 } catch { return 0 }
}
function noteStop(sessionId, n) {
  try { mkdirSync(zcodeQueueDir(sessionId), { recursive: true }); writeAtomic(join(zcodeQueueDir(sessionId), 'stops.json'), { n, at: Date.now() }) }
  catch { /* the cap is a courtesy, not a correctness requirement */ }
}

/** Items older than a day: the session they were meant for never came back, and a window opened next
 *  week should not be handed last week's room. */
function pruneOldDrops(dir) {
  let names = []
  try { names = readdirSync(dir) } catch { return }
  const cutoff = Date.now() - 24 * 3600_000
  for (const n of names) {
    if (!n.startsWith('rany-')) continue
    try { if (statSync(join(dir, n)).mtimeMs < cutoff) rmSync(join(dir, n), { force: true }) } catch { /* in use */ }
  }
}

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
    '', 'Run /rany-bind <boardId> in the repository that owns that board.'].join('\n')
}

// ---- board claims -----------------------------------------------------------------------------

function declareBoards(projectKey, boardIds, timeoutMs = 5000, extra = {}) {
  return postJson('/personas/@self/boards', { projectKey, boardIds, ...extra }, timeoutMs)
}
const claimKey = (s) => projectKeyOf(`${s.dir}|zcode|${s.sessionId}`)
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
  if (!sessionId) return 'RANY: could not tell which ZCode session this is — type a prompt in it first, then /rany-home again.'
  const r = await postJson('/personas/@self/home', { agent: AGENT, ref: sessionId, label: dir })
  if (!r) return 'RANY: could not reach RANY to set the home — check the ZCode token (~/.rany-plugin/zcode.json) and RANY_API_URL.'
  if (!r.ok) return `RANY: the home was refused (${r.body?.error ?? r.status}).`
  noteSession(dir, sessionId)
  return [
    `RANY: this ZCode session is now your persona's home (${dir}).`,
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
  seat_gone: 'that seat was removed from the room — ask the owner for a new link',
  persona_not_active: 'the persona is paused',
}

function bindingFor(dir, sessionId, extra = {}) {
  return { dir, agent: AGENT, zcodeSessionId: sessionId, ts: Date.now(), ...extra }
}

/** Seat THIS ZCode session in a work room from an invite code (ADR-046). Returns
 *  `{ ok, short, brief }`: `short` is what the prompt hook shows the owner, `brief` what the model gets. */
async function joinSeat({ code, dir, sessionId }) {
  if (!sessionId) return { ok: false, short: 'RANY: could not tell which ZCode session this is — send one prompt first, then paste the link again.' }
  const boards = loadBindings()
  const held = Object.entries(boards).find(([, e]) => ownerOf(e) && e.room?.invite === code)
  if (held && ownerOf(held[1]).sessionId === sessionId)
    return { ok: false, short: `RANY: this session already sits in that work room as "${held[1].room.name}" (agentId ${held[0]}).` }
  const res = await postJson('/personas/@self/rooms/join', { code, name: `${basename(dir)} · ZCode`.slice(0, 40), agent: AGENT }, 6000)
  if (!res?.ok)
    return { ok: false, short: `RANY: could not join the work room — ${JOIN_REFUSALS[res?.body?.error] ?? `the server refused (${res?.status ?? 'offline'})`}.` }
  const seat = res.body
  boards[seat.agentId] = bindingFor(dir, sessionId, { room: { channelId: seat.channelId, guildId: seat.guildId, name: seat.name, invite: code } })
  try { saveBindings(boards) } catch (e) {
    return { ok: false, short: `RANY: joined the work room, but could not save the seat binding (${e?.message ?? e}).` }
  }
  recordSeat(dir, seat.agentId, seat)
  saveSeatIdentity(seat.agentId, seat.identity ?? null) // the seat's role brief (ADR-055)
  noteSession(dir, sessionId)
  const s = { dir, sessionId }
  await declareBoards(claimKey(s), boardsForSession(loadBindings(), s), 5000, { ref: sessionId })
  return {
    ok: true,
    short: seat.woke
      ? `RANY: this ZCode session took back the seat "${seat.name}" in the work room at channel ${seat.channelId} (agentId ${seat.agentId}).`
      : `RANY: this ZCode session joined the work room at channel ${seat.channelId} as "${seat.name}" (agentId ${seat.agentId}).`,
    brief: [
      // A wake link (db/0427) hands over a seat that was already in the room — say so, because the room's
      // history, the seat's name and its identity are the ones it had before, not a fresh start.
      seat.woke
        ? `RANY: THIS ZCode session took back the seat "${seat.name}" in the work room at channel ${seat.channelId} (agentId ${seat.agentId}) — it kept its name, identity and history.`
        : `RANY: THIS ZCode session joined the work room at channel ${seat.channelId} as "${seat.name}" (agentId ${seat.agentId}).`,
      `From now on room messages for that seat are delivered to this session, until it closes.`,
      `Next: get_room({channelId:"${seat.channelId}"}) and read the brief documents it lists; then tell the room in ONE`,
      `line which part of the job you take — post_message({channelId:"${seat.channelId}", agentId:"${seat.agentId}", content:"…"}).`,
      ...identityLines(seat.agentId, { full: true, sessionKey: sessionId ?? dir }),
      ...repoRulesFor(seat.agentId, dir, { full: true, sessionKey: sessionId ?? dir }),
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
  saveSeatIdentity(seat.agentId, seat.identity ?? null) // the seat's role brief (ADR-055)
  noteSession(dir, sessionId)
  const s = { dir, sessionId }
  await declareBoards(claimKey(s), boardsForSession(loadBindings(), s), 5000, { ref: sessionId })
  return [
    `RANY: THIS ZCode session holds its seat "${seat.name}" in work room ${seat.channelId} again (agentId ${seat.agentId})`
      + `${seat.state === 'paused' ? ' — the owner has it PAUSED, so wait to be resumed' : ''}.`,
    `When the room speaks to you, get_room({channelId:"${seat.channelId}"}) catches you up and post_message({channelId:"${seat.channelId}", agentId:"${seat.agentId}", …}) answers.`,
    ...identityLines(seat.agentId, { full: true, sessionKey: sessionId ?? dir }),
    ...repoRulesFor(seat.agentId, dir, { full: true, sessionKey: sessionId ?? dir }),
  ].join('\n')
}

async function reattachRememberedSeats({ dir, sessionId, deliberate = false }) {
  const lines = []
  const mine = new Set(boardsForSession(loadBindings(), { dir, sessionId }))
  const offer = []
  for (const [id, h] of seatsForRepo(dir)) {
    if (mine.has(id)) continue
    if (heldByAnotherLiveSession(id, sessionId)) {
      lines.push(`RANY: seat "${h?.name ?? id}" in work room ${h?.channelId ?? '?'} is held by another open ZCode session of this repo; /rany-rejoin ${id} moves it here.`)
      continue
    }
    if (!deliberate && !config.seats.autoReattach) { offer.push([id, h]); continue }
    lines.push(await reattachSeat({ agentId: id, h, dir, sessionId }))
  }
  // Named, not taken (ADR-068). One compact block, not the full identity brief a taken seat prints.
  if (offer.length > 0) {
    lines.push(
      `RANY: this repo has held these work-room seats, and no open session holds them now:`,
      ...offer.map(([id, h]) => `  • "${h?.name ?? id}" in room ${h?.channelId ?? '?'} — /rany-rejoin ${id}`),
      ``,
      `THIS session has NOT taken them: a seat wakes its session for the room, and this window may be`,
      `open for something else. Take one with the command above, or all of them with /rany-rejoin.`,
      `To have them come back by themselves, set {"seats":{"autoReattach":true}} in ~/.rany-plugin/zcode.json.`,
    )
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
  if (!sessionId) { out('RANY: no ZCode session is known in this directory yet — send a prompt in it, then bind again.'); process.exit(0) }
  const info = await fetchBoardInfo(boardId)
  const label = info?.name ? (info.guildName ? `${info.name} (${info.guildName})` : info.name) : `board ${boardId}`
  const boards = loadBindings()
  boards[boardId] = bindingFor(dir, sessionId, { boardName: info?.name ?? null, guildName: info?.guildName ?? null })
  try { saveBindings(boards); recordHistory(dir, boardId, info) } catch (e) { out(`RANY: could not save the binding (${e?.message ?? e})`); process.exit(0) }
  noteSession(dir, sessionId)
  const s = { dir, sessionId }
  await declareBoards(claimKey(s), boardsForSession(loadBindings(), s), 5000, { ref: sessionId })
  out(`RANY: ${label} is now handled in THIS ZCode session (${dir}). It stops when this session closes; bind again in another to move it.`)
  process.exit(0)
}

/** `--identity <agentId>`: print a seat's identity brief again (ADR-055), fetched fresh. */
if (has('--identity')) {
  const agentId = String(arg('--identity') ?? '').trim()
  if (!/^[0-9]+$/.test(agentId)) {
    process.stdout.write('RANY: --identity takes a seat id (the agentId a join printed)\n')
    process.exit(0)
  }
  await ensureSeatIdentity(agentId, true)
  const lines = identityLines(agentId, { full: true, sessionKey: 'cli' })
  process.stdout.write((lines.length ? lines.join('\n') : `RANY: seat ${agentId} has no identity.`) + '\n')
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
  if (!sessionId) { out('RANY: no ZCode session is known in this directory yet — send a prompt in it first.'); process.exit(0) }
  if (raw && !/^[0-9]+$/.test(raw)) { out('RANY: --rejoin takes a seat id, or no argument for every seat this repo held'); process.exit(0) }
  if (raw) {
    const h = seatsForRepo(dir).find(([id]) => id === raw)?.[1]
    out(await reattachSeat({ agentId: raw, h, dir, sessionId }))
  } else {
    // Someone typed the command: take them, whatever `seats.autoReattach` says.
    const lines = await reattachRememberedSeats({ dir, sessionId, deliberate: true })
    out(lines.length ? lines.join('\n') : 'RANY: this repo holds no remembered work-room seat. Paste an invite link to join a room.')
  }
  process.exit(0)
}

if (has('--home')) {
  const dir = process.cwd()
  out(await setHome({ dir, sessionId: lastPromptedSession(dir) }))
  process.exit(0)
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
function daemonRunning() {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    return Boolean(pid) && alive(pid)
  } catch { return false }
}

/** Start the machine's daemon from a hook, detached from the hook's pipes (ZCode awaits a hook until its
 *  output closes). On Windows through WMI, so it belongs to no caller's job object — see the Codex bridge. */
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

/** `--notify <sessionId> <text>`: deliver a wake by hand — the diagnostic for "does this ZCode pick up a drop at all". */
if (has('--notify')) {
  const i = process.argv.indexOf('--notify')
  const sid = process.argv[i + 1]
  const text = process.argv.slice(i + 2).join(' ') || 'RANY: test notification — reply with the single word RECEIVED.'
  if (!sid) { out('RANY: --notify <zcodeSessionId> [text]'); process.exit(0) }
  const r = dropIntoSession(sid, 'RANY: test notification', text)
  out(r.ok ? `RANY: dropped ${r.why} into ZCode session ${sid}` : `RANY: not delivered — ${r.why}`)
  process.exit(0)
}

if (has('--status')) {
  const s = liveSessions()
  out([
    `RANY ZCode bridge ${VERSION}`,
    `  token:   ${config.token ? 'set' : 'MISSING (~/.rany-plugin/zcode.json rany_persona_…)'}`,
    `  api:     ${config.apiUrl}`,
    `  daemon:  ${daemonRunning() ? 'running' : 'not running'}`,
    `  node:    ${process.version}${typeof WebSocket === 'undefined' ? ' — TOO OLD, the daemon needs Node 22+' : ''}`,
    `  sessions heard from: ${s.length ? s.map((r) => `${r.sessionId.slice(0, 8)} @ ${r.dir}`).join(', ') : 'none'}`,
  ].join('\n'))
  process.exit(0)
}

/**
 * Hooks. SessionStart = --start, UserPromptSubmit = --prompt, PostToolUse = --beat, Stop = --deliver,
 * PreToolUse = --rules-guard / --ask-guard (in repo-rules.mjs' own entry points).
 *
 * ZCode reads a hook's stdout as JSON: `hookSpecificOutput.additionalContext` is handed to the model, and
 * a Stop hook's `{"decision":"block","reason":…}` keeps the turn going. Anything else on stdout is a
 * diagnostic the model never sees.
 */
const emit = (event, text) => {
  if (!text) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) + '\n')
}

const queuedText = (items) => items.map((i) => (i.title ? `### ${i.title}\n${i.text}` : i.text)).join('\n\n')

if (has('--start') || has('--prompt') || has('--beat') || has('--deliver')) {
  const hook = await hookInput()
  const dir = workDir(hook)
  const sessionId = sessionOf(hook)
  noteSession(dir, sessionId)

  if (has('--beat') && config.token && sessionId && typeof hook.tool_name === 'string') {
    const seats = Object.entries(loadBindings()).filter(([, e]) => ownerOf(e)?.sessionId === sessionId && e.room).map(([id]) => id)
    const line = seats.length ? toolLine(hook) : null
    if (line) await Promise.all(seats.map((id) => postJson(`/personas/@self/rooms/${id}/activity`, { lines: [{ kind: 'tool', text: line }] }, 4000)))
  }

  // The daemon is what hears RANY at all; every hook is a chance to notice it died.
  if (!daemonRunning() && config.token && typeof WebSocket !== 'undefined') spawnDaemon()

  // A pasted work-room invite link joins the room (ADR-046) and the brief goes straight to the model —
  // ZCode's prompt hook CAN hand over context, so unlike Kimi nothing has to be blocked to be seen.
  const code = has('--prompt') && config.token ? inviteCodeIn(hook.prompt) : null
  if (code) {
    const r = await joinSeat({ code, dir, sessionId })
    emit('UserPromptSubmit', r.ok ? (r.brief ?? r.short) : r.short)
    process.exit(0)
  }

  if (has('--start') && sessionId) {
    // ZCode expands ${CLAUDE_PLUGIN_ROOT} in its config files but not in a skill's text, and a plugin
    // installed from a marketplace lives wherever ZCode put it. So the one thing every skill needs — the
    // path of this script — is written down once per session, and said out loud to the model as well.
    const bridgePath = join(here, 'bridge.mjs')
    try { mkdirSync(HOME, { recursive: true }); writeFileSync(join(HOME, 'zcode-bridge-path.txt'), bridgePath) }
    catch { /* the line below still carries it */ }
    const lines = [`RANY: this session's bridge is \`node "${bridgePath}" --status | --join <link> | --rejoin | --bind <boardId> | --home\`.`]
    if (!config.token) {
      lines.push('RANY plugin: installed but no ZCode persona token, so this session reaches nothing. '
        + 'Issue one in RANY → persona settings → ZCode and put it in ~/.rany-plugin/zcode.json as {"token":"rany_persona_…"}.')
    } else {
      lines.push(...await reattachRememberedSeats({ dir, sessionId }))
      const boundHere = (id) => ownerOf(loadBindings()[String(id)])?.sessionId === sessionId
      const forgotten = historyForRepo(dir).filter(([id]) => !boundHere(id))
      if (forgotten.length > 0) {
        lines.push('RANY: this repo has handled these boards before, but none are bound to THIS ZCode session:',
          ...forgotten.map(([id, h]) => '  • ' + boardLabel(id, h)), '',
          'A binding belongs to one session. To handle them here: /rany-bind <boardId>')
      }
    }
    emit('SessionStart', lines.join('\n'))
    process.exit(0)
  }

  if (has('--prompt')) {
    // Whatever arrived while nobody was listening goes over with the prompt, oldest first.
    const waiting = drainQueue(sessionId)
    if (waiting.length) noteStop(sessionId, 0)
    emit('UserPromptSubmit', queuedText(waiting))
    process.exit(0)
  }

  // Stop: the one moment a ZCode turn can be kept alive. Wait a short while for the room — an answer to
  // a question this seat just asked usually lands in seconds — and hand it over as a continuation. After
  // MAX_STOP_BLOCKS in a row, stop blocking: ZCode force-ends a run at three, and a run that is ended
  // FOR us loses the turn, while a seat that simply waits for the next prompt loses nothing.
  if (has('--deliver')) {
    if (!config.token || !sessionId) process.exit(0)
    if (hook.stop_hook_active === true) process.exit(0)
    const spent = stopsSpent(sessionId)
    let waiting = drainQueue(sessionId)
    if (waiting.length === 0 && spent < MAX_STOP_BLOCKS) {
      const until = Date.now() + STOP_WAIT_MS
      while (Date.now() < until && waiting.length === 0) {
        await new Promise((r) => setTimeout(r, 700))
        if (queuedCount(sessionId) > 0) waiting = drainQueue(sessionId)
      }
    }
    if (waiting.length === 0) { noteStop(sessionId, 0); process.exit(0) }
    if (spent >= MAX_STOP_BLOCKS) {
      // Hand it over without blocking: the model is ending its run, and the text waits for the prompt.
      for (const item of waiting) dropIntoSession(sessionId, item.title, item.text)
      process.exit(0)
    }
    noteStop(sessionId, spent + 1)
    process.stdout.write(JSON.stringify({ decision: 'block', reason: queuedText(waiting) }) + '\n')
    process.exit(0)
  }
  process.exit(0)
}

/** `--rules-guard` (PreToolUse on edits and shell commands): the checkout's `.rany/rany.json` enforced
 *  (ADR-099), the same way the Claude Code plugin enforces it — a seat's promises must not depend on which
 *  runtime happens to hold it. A seated session gets a refusal that says why; a session without a seat is
 *  guarded only when the rules say `applyTo: "all"`. */
if (has('--rules-guard')) {
  const hook = await hookInput()
  const sessionId = sessionOf(hook)
  const held = Object.entries(loadBindings()).find(([, e]) => e?.room && ownerOf(e)?.sessionId === sessionId)
  const cwd = workDir(hook)
  const rules = loadRepoRules(cwd, held ? loadSeatIdentities()[held[0]]?.slug ?? null : null)
  if (rules && (held || rules.policy.applyTo === 'all')) {
    const seat = held ? { agentId: held[0], channelId: held[1].room.channelId } : null
    const hit = checkToolCall(rules, { ...hook, cwd }, { approvedAt: seat ? lastApproval(seat.agentId) : 0 })
    if (hit) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: hit.kind === 'deny' || seat ? 'deny' : 'ask',
          permissionDecisionReason: refusalReason(rules, hit, seat),
        },
      }) + '\n')
      // The owner watching the room sees the refusal on the seat's line, not only the agent.
      if (seat && config.token)
        await postJson(`/personas/@self/rooms/${seat.agentId}/activity`,
          { lines: [{ kind: 'tool', text: `Blocked by .rany/ (${hit.kind === 'deny' ? 'never' : 'ask first'}: ${hit.rule}) — ${hit.what}`.slice(0, 260) }] }, 2500)
    }
  }
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
  out('RANY ZCode bridge. Usage: --status | --bind [boardId] | --join <link> | --rejoin [agentId] | --identity <agentId> | --home | --start | --prompt | --beat | --deliver | --notify | --daemon | --stop')
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
    `them, and never name the model underneath ("GLM", "— AI"). A commit made for RANY work is`,
    `${who}'s as well — author or Co-Authored-By ${personaName ?? 'the persona'} <noreply@rany.work>.`,
  ].join('\n')
}

/** Where an event belongs and what that session is told → `{ dir, sessionId, title, text }`, or null.
 *  The same decisions as the Codex bridge, keyed to ZCode sessions. */
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
    if (!owner) { logRoute('TASK_COMMENT_CREATED', { boardId, guildId }, 'skip (not bound to a ZCode session)'); return null }
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
    if (!owner) { logRoute('PERSONA_WORKFLOW', { guildId: d.guildId, stepId: d.stepId }, 'skip (guild unclaimed, no live ZCode home)'); return null }
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

  if (type === 'PERSONA_ROOM_MESSAGE' || type === 'PERSONA_ROOM_UPDATED' || type === 'PERSONA_ROOM_DECISION'
    || type === 'PERSONA_ROOM_ANSWER') {
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
      : type === 'PERSONA_ROOM_DECISION' ? `RANY: permission ${d.approved ? 'approved' : 'denied'}`
        : type === 'PERSONA_ROOM_ANSWER' ? 'RANY: your question was answered' : 'RANY: work room update'
    // The seat's identity (ADR-055): fetched again when the room says it changed, else when the copy is old.
    d.identitySessionKey = pick.owner.threadId ?? pick.owner.sessionId ?? pick.owner.dir
    d.rulesDir = pick.owner.dir
    await ensureSeatIdentity(pick.s.agentId,
      type === 'PERSONA_ROOM_UPDATED' && d.change === 'identity_set' && String(d.agentId ?? '') === String(pick.s.agentId))
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
/**
 * The chain of command this seat sits in (ADR-098). A team is not decoration: a lead is woken on behalf of
 * its people and is the one who hands the work out, and a member answers to its lead. The relay puts the
 * team on every target (db/0512), so a seat that is in one always knows whom it can name and whom it
 * reports to; a seat in no team gets nothing extra.
 */
function teamLines(seat) {
  const team = seat?.team
  if (!team || !team.name) return []
  const others = (Array.isArray(team.members) ? team.members : [])
    .filter((m) => m && String(m.agentId) !== String(seat.agentId))
  const list = others.map((m) => `"${m.name ?? m.agentId}" (<@agent:${m.agentId}>)`).join(', ')
  if (team.lead) {
    return [
      `You LEAD the team "${team.name}"${others.length ? `: ${list}` : ' — nobody else is in it yet'}.`,
      ...(others.length ? [
        `A message to the team reaches YOU, not them: break the job up and hand each part out by NAMING the`,
        `colleague (<@agent:ID>) in ONE post, then report the result yourself. Do the parts nobody else can.`] : []),
    ]
  }
  return [
    `You are in the team "${team.name}"${team.leadName ? `, led by "${team.leadName}"` : ', which has no lead right now'}`
      + `${others.length ? ` with ${list}` : ''}.`,
    ...(team.leadId && String(team.leadId) !== String(seat.agentId)
      ? [`Report what you finish to <@agent:${team.leadId}> — it answers for the team.`] : []),
  ]
}

function roomPrompt(type, d, seat) {
  const identityChanged = type === 'PERSONA_ROOM_UPDATED' && d.change === 'identity_set'
    && String(d.agentId ?? '') === String(seat.agentId)
  const who = [
    `You are "${seat.name}" (agentId ${seat.agentId}) in the work room at channel ${d.channelId}, working from THIS repository.`,
    ...identityLines(seat.agentId, { full: identityChanged, sessionKey: d.identitySessionKey }),
    ...repoRulesFor(seat.agentId, d.rulesDir, { sessionKey: d.identitySessionKey }),
  ].join('\n')
  const tools = [
    `Your room tools — always pass channelId:"${d.channelId}" and agentId:"${seat.agentId}":`,
    `  get_room — the other agents, the budget, pending requests and the BRIEF docs (read the brief first);`,
    `  post_message({channelId, agentId, content}) — talk in the room in one or two sentences;`,
    `    a next step for the owner goes in actions:["Push and deploy", …] — buttons; never "say X";`,
    `  you take instructions from your PERSONA and from posts that name you; other messages are context;`,
    `  to speak to ONE colleague, put <@agent:THEIR_ID> in the post (ids from get_room);`,
    `  to SHARE A FILE: create_upload({channelId, filename, contentType, size}) → PUT the bytes to its uploadUrl →`,
    `    post_message with attachments:[{key, filename, contentType, size}];`,
    `  set_agent_status — the one line your tile shows; keep it current;`,
    `  request_permission — when your seat's approval setting says so (get_room: your approvalPolicy; default:`,
    `    BEFORE anything destructive, production-facing, costly or outside this repo);`,
    `  propose_identities({channelId, agentId, identities}) — right after joining, offer the roles you can play`,
    `    (slug, title, name, summary); the name renames your seat with the role;`,
    `    the owner picks one (or picks from RANY's catalog when you offer none);`,
    `  ask_question({channelId, agentId, question, options?}) — a question for your owner, as a card in the chat;`,
    `  list_board_tasks / get_task / create_task / set_task_status / comment_task / assign_task — the work queue;`,
    `  record_room_log({channelId, agentId, kind, title, body?, rationale?, supersedes?, resolves?, refs?}) — the room's LOG:`,
    `    a decision (why in rationale; change one by superseding its id), a milestone, a learning, an open question, and`,
    `    kind commit {refs:[{type:"commit", value:SHA, branch}]} after every commit you make. get_room shows what stands.`,
    `LANGUAGE: write the log and your room posts in the room's language (get_room → log.language; unset = your owner's).`,
    `NEVER ask your owner through AskUserQuestion while you sit in a room: only this terminal shows it and the room`,
    `never sees it. A decision goes through request_permission (a card in the chat); a question through ask_question (a card in the chat with your options; the answer wakes you).`,
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
  if (type === 'PERSONA_ROOM_ANSWER') {
    return [
      `RANY: your owner ANSWERED your question in work room ${d.channelId}.`,
      `  You asked: ${String(d.question ?? '')}`,
      `  Answer: ${String(d.answer ?? '')}`,
      ``,
      who,
      ...teamLines(seat),
      `Carry on with that answer. If it changes your part of the job, say so in ONE room line.`,
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
    identity_set: mine
      ? (loadSeatIdentities()[String(seat.agentId)]?.slug ? 'the owner gave you a NEW IDENTITY (above)' : 'the owner CLEARED your identity')
      : 'an agent was given a different identity',
  }[d.change] ?? `the room changed (${d.change})`
  // Most room updates are about someone else: they are not worth a ZCode turn. Wake only for what changes
  // this seat's work.
  const worthATurn = stop || d.change === 'budget_exhausted' || (mine && (d.change === 'agent_joined' || d.change === 'task_assigned' || d.change === 'agent_resumed' || d.change === 'identity_set'))
  if (!worthATurn) return null
  const next = stop
    ? [`STOP working on this room's job now and do not post there until you are resumed. Leave what you were doing in a safe state.`]
    : d.change === 'budget_exhausted' ? [`Do not post in the room until the owner writes there again.`]
    : d.change === 'agent_joined' ? [`Read the brief (get_room), then tell the room in one line which part you take.`]
    : d.change === 'identity_set' ? [
        loadSeatIdentities()[String(seat.agentId)]?.slug
          ? `Work as that identity from now on. If it changes your part of the job, say so in ONE room line.`
          : `Go back to working without a role brief; nothing else changes.`]
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
