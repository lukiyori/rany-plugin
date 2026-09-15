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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

/** The seat this directory holds for this KIND of agent (claude / codex — both plugins write the same
 *  seat history), newest first. Nothing for the kind ⇒ any seat of the directory. */
function rememberedSeat(dir, kind) {
  try {
    const repos = JSON.parse(readFileSync(join(homedir(), '.rany-plugin', 'seat-history.json'), 'utf8')).repos ?? {}
    const all = Object.entries(repos[norm(dir)] ?? {})
    const mine = all.filter(([, s]) => (s?.agent ?? 'claude') === kind)
    const seats = (mine.length ? mine : all)
      .sort((a, b) => String(b[1]?.lastJoined ?? '').localeCompare(String(a[1]?.lastJoined ?? '')))
    return seats[0] ? { id: seats[0][0], ...seats[0][1] } : null
  } catch { return null }
}

// ---- args -------------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
let seatArg = null
const seatAt = argv.indexOf('--seat')
if (seatAt !== -1) { seatArg = argv[seatAt + 1] ?? null; argv.splice(seatAt, 2) }

// ---- shims: make it the DEFAULT --------------------------------------------------------------------
// `rany-term --install` writes `claude` and `codex` shims into ~/.rany-plugin/bin and puts that directory
// first on the user's PATH, so typing `claude` or `codex` anywhere IS this launcher: in a directory that
// holds a seat the screen is mirrored, elsewhere the agent simply runs. The shim calls this file with the
// agent's name; `resolveReal` then finds the actual program by walking PATH and skipping the shim
// directory, so the shim never calls itself.
const shimDir = join(homedir(), '.rany-plugin', 'bin')
const AGENTS = ['claude', 'codex']

function installShims() {
  mkdirSync(shimDir, { recursive: true })
  // The shim points at a STABLE copy in ~/.rany-plugin/term, not at this file: this file lives in a
  // plugin-cache directory named after the version, which every plugin update leaves behind. Re-running
  // --install after an update refreshes the copy; node-pty installs next to it, once.
  const stable = join(homedir(), '.rany-plugin', 'term')
  mkdirSync(stable, { recursive: true })
  for (const f of ['rany-term.mjs', 'package.json']) writeFileSync(join(stable, f), readFileSync(join(here, f)))
  const self = join(stable, 'rany-term.mjs')
  // `rany-term` itself becomes a command too (`rany-term --install`, `--uninstall`, `--seat …`).
  for (const a of [...AGENTS, 'rany-term']) {
    const lead = a === 'rany-term' ? '' : `${a} `
    if (process.platform === 'win32') {
      writeFileSync(join(shimDir, `${a}.cmd`), `@echo off\r\nnode "${self}" ${lead}%*\r\n`)
    } else {
      const p = join(shimDir, a)
      writeFileSync(p, `#!/bin/sh\nexec node "${self}" ${lead}"$@"\n`)
      chmodSync(p, 0o755)
    }
  }
  let onPath = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').some((p) => norm(p) === norm(shimDir))
  if (process.platform === 'win32' && !onPath) {
    // This process's PATH predates a previous --install; ask the registry-backed USER Path before adding,
    // so running --install twice (after a plugin update, say) does not stack entries.
    const q = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetEnvironmentVariable('Path', 'User')"], { encoding: 'utf8' })
    onPath = String(q.stdout ?? '').split(';').some((p) => norm(p.trim()) === norm(shimDir))
  }
  if (process.platform === 'win32' && !onPath) {
    // The USER PATH, through .NET — `setx` truncates at 1024 characters and would eat the rest of it.
    const ps = `[Environment]::SetEnvironmentVariable('Path', '${shimDir.replace(/'/g, "''")};' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' })
    process.stdout.write(r.status === 0
      ? `rany-term: shims in ${shimDir}, added to the front of your user PATH. Open a NEW terminal; from then on plain \`claude\` and \`codex\` mirror their screen wherever the directory holds a seat.\n`
      : `rany-term: shims written to ${shimDir}, but PATH could not be changed — add that directory to the FRONT of your PATH by hand.\n`)
  } else {
    process.stdout.write(onPath
      ? `rany-term: shims refreshed in ${shimDir} (already on PATH). Plain \`claude\` and \`codex\` mirror their screen wherever the directory holds a seat.\n`
      : `rany-term: shims in ${shimDir}. Put it FIRST on your PATH (e.g. \`export PATH="${shimDir}:$PATH"\` in your shell profile); from then on plain \`claude\` and \`codex\` mirror their screen wherever the directory holds a seat.\n`)
  }
}

function uninstallShims() {
  for (const a of [...AGENTS, 'rany-term']) for (const f of [a, `${a}.cmd`]) { try { rmSync(join(shimDir, f), { force: true }) } catch { /* gone */ } }
  process.stdout.write(`rany-term: shims removed from ${shimDir} (the PATH entry is harmless and left alone).\n`)
}

/** The real program behind a name: the first match on PATH outside the shim directory (Windows: with
 *  a PATHEXT extension). Null when nothing is found, in which case the name is passed through as-is. */
function resolveReal(name) {
  if (/[\\/]/.test(name)) return name
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
    .filter((p) => norm(p) !== norm(shimDir))
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()).concat([''])
    : ['']
  for (const d of dirs) for (const e of exts) {
    const p = join(d, name + e)
    try { if (statSync(p).isFile()) return p } catch { /* next */ }
  }
  return null
}

if (argv[0] === '--install') { installShims(); process.exit(0) }
if (argv[0] === '--uninstall') { uninstallShims(); process.exit(0) }

const command = argv.length ? argv : ['claude']
const agentKind = /codex/i.test(basename(command[0])) ? 'codex' : 'claude'
// Through a shim, `claude` must reach the real claude.cmd and not the shim again.
command[0] = resolveReal(command[0]) ?? command[0]

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
const seat = seatArg ? { id: seatArg } : rememberedSeat(cwd, agentKind)
const mirror = new Mirror(seat?.id ?? null)

const cols = process.stdout.columns || 120
const rows = process.stdout.rows || 30
// Windows: `claude` and `codex` are .cmd files on PATH; ConPTY runs those through cmd.exe. The arguments
// stay an ARRAY — node-pty quotes each for the Windows command line; a hand-joined string with quotes
// inside is what made cmd drop the command and sit at a prompt. A real .exe runs directly.
const [file, args] = process.platform === 'win32' && !/\.exe$/i.test(command[0])
  ? ['cmd.exe', ['/d', '/c', ...command]]
  : [command[0], command.slice(1)]
if (process.env.RANY_TERM_DEBUG) process.stderr.write(`rany-term: spawn ${file} ${JSON.stringify(args)} in ${cwd}\r\n`)
const child = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, RANY_TERM: '1' } })

// Through the shims this runs on EVERY `claude`/`codex`, most of them in directories with no seat —
// those must look exactly like the plain program, so the no-seat case says nothing unless asked.
if (seat?.id)
  process.stderr.write(`\x1b[2mrany-term: mirroring this terminal to work-room seat ${seat.name ? `"${seat.name}" ` : ''}(${seat.id}) — owner-only view in RANY.\x1b[0m\r\n`)
else if (process.env.RANY_TERM_DEBUG || seatArg === null && argv.length === 0)
  process.stderr.write(`\x1b[33mrany-term: no work-room seat remembered for ${cwd}; running without a mirror (join a room first, or pass --seat <agentId>).\x1b[0m\r\n`)

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
