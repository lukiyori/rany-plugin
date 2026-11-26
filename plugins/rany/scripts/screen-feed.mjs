#!/usr/bin/env node
/**
 * The Screen of a seat whose session has no terminal mirror (ADR-050, transcript variant).
 *
 * `rany-term` catches a real terminal's bytes, but only where the session was started through the `claude`
 * shim. Claude Code in the desktop app, in VS Code, or in a terminal opened without the shim has nothing to
 * catch, and its seat's Screen stayed empty while it worked. Each of those sessions still writes its
 * transcript as it goes, so the plugin's hooks register it here (`~/.rany-plugin/screen-feeds/<seat>.json`:
 * the seat and the transcript path) and this one detached process per machine tails every registered
 * transcript and posts what it finds to the seat's `/term` stream — the same stream the real mirror feeds,
 * and the same way the Codex bridge feeds a Codex seat from its rollout.
 *
 *   node screen-feed.mjs --daemon     run (the plugin starts it; one per machine, pid file guarded)
 *   node screen-feed.mjs --once FILE  print what FILE's last screen would show, and exit (a check by hand)
 *
 * It lives at ~/.rany-plugin/screen/ (copied there by the plugin), out of the versioned plugin cache that an
 * update leaves behind. It exits by itself after ten minutes with nothing to follow.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync, rmSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { screenLines, A } from './screen-render.mjs'
import { redactSecrets } from './redact.mjs'

const STATE = join(homedir(), '.rany-plugin')
export const FEEDS = join(STATE, 'screen-feeds')
const PID_FILE = join(STATE, 'screen-feed.pid')
const TICK_MS = 1500
const KEEPALIVE_MS = 5000
const LIVE_WINDOW_MS = 15 * 60_000      // a transcript untouched this long is a session at rest: no keepalive
const STALE_MS = 12 * 60 * 60_000       // untouched this long: stop following it
const IDLE_EXIT_MS = 10 * 60_000        // nothing to follow this long: the daemon exits
const BACKFILL = 48 * 1024              // on attach, roughly the last screen's worth

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

function config() {
  const file = readJson(join(STATE, 'rany.json')) ?? {}
  const apiUrl = (process.env.RANY_API_URL || file.apiUrl || 'https://www.rany.work/api').replace(/\/+$/, '')
  let token = String(process.env.RANY_PERSONA_TOKEN || file.token || '').trim().replace(/^['"]|['"]$/g, '')
  if (!token && process.platform === 'win32') {
    const q = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetEnvironmentVariable('RANY_PERSONA_TOKEN','User')"], { encoding: 'utf8', windowsHide: true })
    token = String(q.stdout ?? '').trim().replace(/^['"]|['"]$/g, '')
  }
  return { apiUrl, token }
}

function log(msg) {
  try { appendFileSync(join(STATE, 'routing.log'), `${new Date().toISOString()} screen-feed ${msg}\n`) } catch { /* best effort */ }
}

let cfg = null
function postJson(path, payload, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let url
    try { url = new URL(`${cfg.apiUrl}${path}`) } catch { return resolve(null) }
    const body = Buffer.from(JSON.stringify(payload))
    const req = (url.protocol === 'http:' ? httpRequest : httpsRequest)(url, {
      method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Authorization: `Bearer ${cfg.token}` },
    }, (res) => { res.resume(); res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode })) })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end(body)
  })
}
const postTerm = (agentId, chunks) => postJson(`/personas/@self/rooms/${agentId}/term`, { chunks })
const textChunk = (s) => ({ t: 'o', d: Buffer.from(s, 'utf8').toString('base64') })

/** Read [from, to) of a file as text. */
function readRange(path, from, to) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    readSync(fd, buf, 0, buf.length, from)
    return buf.toString('utf8')
  } finally { closeSync(fd) }
}

/** Lines appended to a transcript since `t.offset`, rendered. Moves the offset. */
function drain(t) {
  let size
  try { size = statSync(t.path).size } catch { return [] }
  if (size < t.offset) { t.offset = 0; t.partial = '' } // rewritten
  if (size === t.offset) return []
  const to = Math.min(size, t.offset + 4 * 1024 * 1024)
  const text = t.partial + readRange(t.path, t.offset, to)
  t.offset = to
  const lines = text.split('\n')
  t.partial = lines.pop() ?? ''
  const out = []
  for (const l of lines) {
    if (!l.trim()) continue
    let row
    try { row = JSON.parse(l) } catch { continue }
    // Scrub secrets before any frame leaves the terminal for the room's Screen (owner, 2026-11-26, critical):
    // command text, tool output and transcript all pass through here, so this is the Screen's redaction gate.
    const s = redactSecrets(screenLines(row, t.state))
    if (s) out.push(s)
  }
  return out
}

/** Start a little before the end, at a line boundary, so the screen opens with recent context. */
function attachOffset(path) {
  let size = 0
  try { size = statSync(path).size } catch { return 0 }
  const from = Math.max(0, size - BACKFILL)
  if (from === 0) return 0
  const probe = readRange(path, from, Math.min(size, from + 64 * 1024))
  const nl = probe.indexOf('\n')
  return nl >= 0 ? from + Buffer.byteLength(probe.slice(0, nl + 1)) : size
}

const tails = new Map() // agentId -> { path, offset, partial, state, attached, lastPost }

async function tick() {
  let names = []
  try { names = readdirSync(FEEDS).filter((n) => n.endsWith('.json')) } catch { /* none yet */ }
  const wanted = new Map()
  for (const n of names) {
    const f = join(FEEDS, n)
    const feed = readJson(f)
    const path = feed?.transcript
    if (!feed?.agentId || !path) { rmSync(f, { force: true }); continue }
    let mtime = 0
    try { mtime = statSync(path).mtimeMs } catch { /* not written yet */ }
    if (mtime && Date.now() - mtime > STALE_MS) { rmSync(f, { force: true }); continue }
    wanted.set(String(feed.agentId), { path, mtime })
  }
  for (const id of [...tails.keys()]) if (!wanted.has(id) || tails.get(id).path !== wanted.get(id).path) tails.delete(id)

  for (const [id, w] of wanted) {
    if (!w.mtime) continue
    let t = tails.get(id)
    if (!t) {
      t = { path: w.path, offset: attachOffset(w.path), partial: '', state: {}, attached: false, lastPost: 0 }
      tails.set(id, t)
      await postTerm(id, [textChunk(`${A.dim}── rany: following this Claude Code session's transcript (${basename(w.path)}) ──${A.off}\r\n`)])
    }
    try {
      const out = drain(t)
      if (out.length) {
        const chunks = []
        if (!t.attached) { chunks.push({ t: 's', d: 'attach' }); t.attached = true }
        chunks.push(textChunk(out.join('\r\n') + '\r\n'))
        t.lastPost = Date.now()
        const res = await postTerm(id, chunks)
        if (res && !res.ok && (res.status === 404 || res.status === 403)) {
          // The seat is gone or not this persona's: stop following it.
          log(`seat ${id}: HTTP ${res.status}, feed dropped`)
          rmSync(join(FEEDS, `${id}.json`), { force: true })
          tails.delete(id)
          continue
        }
      }
      if (Date.now() - w.mtime < LIVE_WINDOW_MS && Date.now() - t.lastPost >= KEEPALIVE_MS) {
        t.lastPost = Date.now()
        await postTerm(id, [{ t: 's', d: 'alive' }])
      }
    } catch (e) { log(`seat ${id}: ${e?.message ?? e}`) }
  }
  return wanted.size
}

function alive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' } }

async function daemon() {
  cfg = config()
  if (!cfg.token) { log('no persona token; not starting'); return }
  mkdirSync(FEEDS, { recursive: true })
  const other = readJson(PID_FILE)
  if (other?.pid && other.pid !== process.pid && alive(other.pid)) return // one per machine
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  log(`started (pid ${process.pid})`)
  let idleSince = Date.now()
  for (;;) {
    const n = await tick()
    if (n > 0) idleSince = Date.now()
    else if (Date.now() - idleSince > IDLE_EXIT_MS) break
    // Another daemon took over (a newer copy started while this one slept): leave it the work.
    const now = readJson(PID_FILE)
    if (now?.pid && now.pid !== process.pid && alive(now.pid)) { log(`pid ${process.pid} hands over to ${now.pid}`); return }
    await new Promise((r) => setTimeout(r, TICK_MS))
  }
  if (readJson(PID_FILE)?.pid === process.pid) rmSync(PID_FILE, { force: true })
  log(`idle, exiting (pid ${process.pid})`)
}

const argv = process.argv.slice(2)
if (argv[0] === '--daemon') {
  await daemon()
} else if (argv[0] === '--once' && argv[1] && existsSync(argv[1])) {
  const t = { path: argv[1], offset: attachOffset(argv[1]), partial: '', state: {} }
  process.stdout.write(drain(t).join('\r\n') + '\r\n')
}
