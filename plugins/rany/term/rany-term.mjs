#!/usr/bin/env node
// rany-term — run a coding agent inside a pty and mirror its terminal to its RANY work-room seat.
//
// ADR-050 (task #86): the owner wants to see, on the meet screen, exactly what they see in the terminal
// where their agent runs — not a log of tool names, the screen itself. Claude Code's hooks cannot see
// the screen (a hook is a child process with the call on stdin, nothing more), so the only place the
// bytes can be caught is AROUND the process: this launcher owns a pty, runs the agent in it, shows you
// the output as any terminal would, and ships the same bytes to RANY in small batches.
//
//   rany-term                       # runs `claude` in this directory
//   rany-term claude --resume       # any command + args
//   rany-term --seat 9300860727…    # name the seat explicitly (default: this repo's remembered seat)
//
// What is mirrored: every byte the agent writes to the screen, resizes, and start/end marks. That
// includes what YOU type into it (echoed by the program), so RANY shows this stream to the room's OWNER
// only. No input ever comes back from RANY — the seat hears its owner through the room.
//
// One native dependency (node-pty — there is no ConPTY without it on Windows), installed on first run
// into this directory. Everything else is Node 22.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const require = createRequire(import.meta.url)

// ---- the one dependency, fetched on first run -----------------------------------------------------
function loadPty() {
  try { return require('node-pty') } catch { /* not installed yet */ }
  process.stderr.write('rany-term: first run — installing node-pty (once)…\n')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const r = spawnSync(npm, ['install', '--omit=dev', '--no-fund', '--no-audit', '--loglevel=error'],
    { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    process.stderr.write('rany-term: npm install failed; run it by hand in ' + here + '\n')
    process.exit(1)
  }
  return require('node-pty')
}

// ---- config: the same places the plugin reads ------------------------------------------------------
const stateDir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'rany-plugin')
function loadConfig() {
  let file = {}
  try { const p = join(stateDir, 'rany.json'); if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf8')) } catch { /* env only */ }
  const apiUrl = (process.env.RANY_API_URL || file.apiUrl || 'https://www.rany.work/api').replace(/\/+$/, '')
  const token = process.env.RANY_PERSONA_TOKEN || file.token || ''
  return { apiUrl, token }
}
const config = loadConfig()
if (!config.token) {
  process.stderr.write('rany-term: RANY_PERSONA_TOKEN is not set (RANY → persona settings → token). Running without a mirror.\n')
}

const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

/** The seat this directory holds, from the plugin's seat history (written on join / re-attach). */
function rememberedSeat(dir) {
  try {
    const repos = JSON.parse(readFileSync(join(homedir(), '.rany-plugin', 'seat-history.json'), 'utf8')).repos ?? {}
    const seats = Object.entries(repos[norm(dir)] ?? {}).filter(([, s]) => (s?.agent ?? 'claude') === 'claude')
    seats.sort((a, b) => String(b[1]?.lastJoined ?? '').localeCompare(String(a[1]?.lastJoined ?? '')))
    return seats[0] ? { id: seats[0][0], ...seats[0][1] } : null
  } catch { return null }
}

// ---- args -------------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
let seatArg = null
const seatAt = argv.indexOf('--seat')
if (seatAt !== -1) { seatArg = argv[seatAt + 1] ?? null; argv.splice(seatAt, 2) }
const command = argv.length ? argv : ['claude']

// ---- the mirror -------------------------------------------------------------------------------------
function postJson(path, payload, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!config.token) return resolve(null)
    let url
    try { url = new URL(`${config.apiUrl}${path}`) } catch { return resolve(null) }
    const body = JSON.stringify(payload)
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    const req = send(url, {
      method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${config.token}` },
    }, (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (d) => { text += d }); res.on('end', () => { let b = null; try { b = JSON.parse(text) } catch { /* not JSON */ } resolve({ ok: res.statusCode === 200, status: res.statusCode, body: b }) }); res.on('error', () => resolve(null)) })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end(body)
  })
}

const FLUSH_MS = 120           // a frame or two of TUI redraw per request
const MAX_BATCH_BYTES = 64 * 1024
const KEEPALIVE_MS = 5000      // an idle screen still says "I am here" (the meet screen's live dot)

class Mirror {
  constructor(seatId) {
    this.seatId = seatId
    this.queue = []      // [{ t, d }]
    this.bytes = 0
    this.timer = null
    this.inflight = null
    this.lastFlush = 0
    this.failures = 0
    this.warned = false
  }
  push(t, d) {
    if (!this.seatId) return
    // Coalesce consecutive output chunks so a busy redraw is one entry, not fifty.
    const last = this.queue[this.queue.length - 1]
    if (t === 'o' && last && last.t === 'o' && last.buf.length + d.length <= MAX_BATCH_BYTES) {
      last.buf = Buffer.concat([last.buf, d])
    } else {
      this.queue.push(t === 'o' ? { t, buf: d } : { t, d })
    }
    this.bytes += t === 'o' ? d.length : 0
    if (this.bytes >= MAX_BATCH_BYTES) void this.flush()
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_MS)
  }
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.inflight) { await this.inflight; if (this.queue.length === 0) return }
    if (this.queue.length === 0) return
    const chunks = this.queue.splice(0, 200).map((c) => c.t === 'o' ? { t: 'o', d: c.buf.toString('base64') } : { t: c.t, d: c.d })
    this.bytes = 0
    this.lastFlush = Date.now()
    this.inflight = postJson(`/personas/@self/rooms/${this.seatId}/term`, { chunks }).then((res) => {
      this.inflight = null
      if (res?.ok) { this.failures = 0; return }
      if (++this.failures === 3 && !this.warned) {
        this.warned = true
        const why = res?.body?.error === 'no_agent' ? 'the seat is gone (removed, or another persona\'s)'
          : res?.body?.error === 'no_stream' ? 'the server has no Redis for terminal streams'
          : res ? `HTTP ${res.status}` : 'offline'
        process.stderr.write(`\r\n\x1b[33mrany-term: mirror paused — ${why}. The agent keeps running.\x1b[0m\r\n`)
      }
    })
    if (this.queue.length > 0) this.timer = setTimeout(() => void this.flush(), FLUSH_MS)
  }
  keepalive() {
    if (Date.now() - this.lastFlush >= KEEPALIVE_MS && this.queue.length === 0) this.push('s', 'alive')
  }
}

// ---- run --------------------------------------------------------------------------------------------
const pty = loadPty()
const cwd = process.cwd()
const seat = seatArg ? { id: seatArg } : rememberedSeat(cwd)
const mirror = new Mirror(seat?.id ?? null)

const cols = process.stdout.columns || 120
const rows = process.stdout.rows || 30
// Windows: `claude` is claude.cmd on PATH; ConPTY runs it through cmd.exe. Elsewhere the shell resolves it.
const [file, args] = process.platform === 'win32'
  ? ['cmd.exe', ['/d', '/s', '/c', command.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')]]
  : [command[0], command.slice(1)]
const child = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, RANY_TERM: '1' } })

process.stderr.write(seat?.id
  ? `\x1b[2mrany-term: mirroring this terminal to work-room seat ${seat.name ? `"${seat.name}" ` : ''}(${seat.id}) — owner-only view in RANY.\x1b[0m\r\n`
  : `\x1b[33mrany-term: no work-room seat remembered for ${cwd}; running without a mirror (join a room first, or pass --seat <agentId>).\x1b[0m\r\n`)

mirror.push('s', `${cols},${rows}`)
mirror.push('r', `${cols},${rows}`)

child.onData((data) => {
  process.stdout.write(data)
  mirror.push('o', Buffer.from(data, 'utf8'))
})

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', (d) => child.write(d.toString('utf8')))

const onResize = () => {
  const c = process.stdout.columns || cols, r = process.stdout.rows || rows
  try { child.resize(c, r) } catch { /* exited */ }
  mirror.push('r', `${c},${r}`)
}
process.stdout.on('resize', onResize)
const beat = setInterval(() => mirror.keepalive(), KEEPALIVE_MS)

child.onExit(async ({ exitCode }) => {
  clearInterval(beat)
  mirror.push('e', String(exitCode ?? 0))
  await mirror.flush()
  if (mirror.inflight) await mirror.inflight
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.exit(exitCode ?? 0)
})
