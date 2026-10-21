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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
// Beside this file, and copied beside it into ~/.rany-plugin/term by the plugin's prepareTerm — which
// writes it BEFORE rany-term.mjs, so a launcher is never newer than the module it imports.
import { chooseSeat, handoffSeat } from './seat-choice.mjs'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const require = createRequire(import.meta.url)

// ---- the one dependency, fetched on first run -----------------------------------------------------
function loadPty() {
  try { return fixSpawnHelper(require('node-pty')) } catch { /* not installed yet */ }
  process.stderr.write('rany-term: first run — installing node-pty (once)…\n')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const r = spawnSync(npm, ['install', '--omit=dev', '--no-fund', '--no-audit', '--loglevel=error'],
    { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    process.stderr.write('rany-term: npm install failed; run it by hand in ' + here + '\n')
    process.exit(1)
  }
  return fixSpawnHelper(require('node-pty'))
}

// macOS / Linux: node-pty forks through a small `spawn-helper` binary shipped in its prebuilds, and npm can
// unpack it WITHOUT the execute bit — every spawn then dies with "posix_spawnp failed" and `claude` never
// starts. Restoring the bit is cheap and idempotent, so it runs on every load.
function fixSpawnHelper(pty) {
  if (process.platform === 'win32') return pty
  let root
  try { root = dirname(require.resolve('node-pty/package.json')) } catch { return pty }
  for (const dir of ['prebuilds', join('build', 'Release')]) {
    let entries = []
    try { entries = dir === 'prebuilds' ? readdirSync(join(root, dir)).map((d) => join(root, dir, d)) : [join(root, dir)] } catch { continue }
    for (const d of entries) {
      const helper = join(d, 'spawn-helper')
      try { if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755) } catch { /* absent or not ours to change */ }
    }
  }
  return pty
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

/** Every seat this directory remembers for this KIND of agent (claude / codex — both plugins write the
 *  same seat history), newest first. Nothing for the kind ⇒ any seat of the directory. */
function rememberedSeats(dir, kind) {
  try {
    const repos = JSON.parse(readFileSync(join(homedir(), '.rany-plugin', 'seat-history.json'), 'utf8')).repos ?? {}
    const all = Object.entries(repos[norm(dir)] ?? {})
    const mine = all.filter(([, s]) => (s?.agent ?? 'claude') === kind)
    return (mine.length ? mine : all)
      .sort((a, b) => String(b[1]?.lastJoined ?? '').localeCompare(String(a[1]?.lastJoined ?? '')))
      .map(([id, s]) => ({ id, ...s }))
  } catch { return [] }
}

// Which of those seats this terminal is — `chooseSeat` in ./seat-choice.mjs, where the rule and its reason
// live so a test can hold them without a pty.

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
  if (process.platform === 'win32') powershellProfiles(true)
}

// Windows builds a process's PATH as MACHINE + USER, so "first on the user PATH" still loses to a
// `claude` installed machine-wide (npm -g into C:\Program Files\nodejs is exactly that) — and PowerShell
// would pick that directory's claude.ps1 over any .cmd regardless. The shim was on PATH and never ran;
// the Screen tab stayed empty. A function beats every command on PATH, so the PowerShell profile (all
// hosts: the console, VS Code's terminal, Windows Terminal) gets one, between markers so a re-install
// replaces it and --uninstall takes it out. cmd.exe has no equivalent and still depends on PATH order.
const PROFILE_START = '# >>> rany-term (claude screen mirror) >>>'
const PROFILE_END = '# <<< rany-term <<<'

function powershellProfiles(install) {
  const block = [PROFILE_START,
    `function claude { & '${join(shimDir, 'claude.cmd').replace(/'/g, "''")}' @args }`,
    PROFILE_END].join('\r\n')
  const strip = (s) => s.replace(new RegExp(`\\r?\\n?${PROFILE_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${PROFILE_END}\\r?\\n?`), '\r\n').replace(/^\r\n/, '')
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const q = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserAllHosts'], { encoding: 'utf8' })
    const file = String(q.stdout ?? '').trim()
    if (q.status !== 0 || !file) continue // that PowerShell is not installed
    try {
      const was = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const kept = strip(was).trimEnd()
      if (!install && kept === was.trimEnd()) continue
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, install ? `${kept ? kept + '\r\n\r\n' : ''}${block}\r\n` : (kept ? kept + '\r\n' : ''))
      process.stdout.write(install
        ? `rany-term: \`claude\` routed through the shim in ${file} (a machine-wide claude would otherwise win). Open a NEW terminal.\n`
        : `rany-term: removed the \`claude\` function from ${file}.\n`)
    } catch (e) {
      process.stdout.write(`rany-term: could not update ${file} (${e?.message ?? e}) — add \`function claude { & '${join(shimDir, 'claude.cmd')}' @args }\` to it by hand.\n`)
    }
  }
}

function uninstallShims() {
  for (const a of [...AGENTS, 'rany-term']) for (const f of [a, `${a}.cmd`]) { try { rmSync(join(shimDir, f), { force: true }) } catch { /* gone */ } }
  if (process.platform === 'win32') powershellProfiles(false)
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

// `--new` is this launcher's own flag (a blank conversation, see below) and never reaches the agent.
const wantsNew = argv.includes('--new')
if (wantsNew) argv.splice(argv.indexOf('--new'), 1)

const command = argv.length ? argv : ['claude']
const agentKind = /codex/i.test(basename(command[0])) ? 'codex' : 'claude'

/**
 * Continue the seat's LAST conversation when the agent is started plainly in a directory that holds one.
 *
 * Taking a seat back returns the seat, never the thinking behind the work: the window came up empty and
 * the owner was keeping `claude --resume <guid>` lines in .bat files by hand. The seat history now
 * remembers each seat's last local sessions, so the obvious thing is to use it — typing `claude` where a
 * seat lives means "carry on", not "start again".
 *
 * Only when the agent was given NO arguments of its own: any argument is the owner being explicit, and
 * `--new` is the way to say "a blank one" (it is consumed here, never passed on). `{"seats":{"autoResume":
 * false}}` in ~/.rany-plugin/rany.json (codex.json for Codex) turns it off for good.
 */
function seatSetting(kind, key, fallback) {
  try {
    const file = join(homedir(), '.rany-plugin', kind === 'codex' ? 'codex.json' : 'rany.json')
    const v = JSON.parse(readFileSync(file, 'utf8'))?.seats?.[key]
    return typeof v === 'boolean' ? v : fallback
  } catch { return fallback }
}

/** Does Claude still have that conversation on disk? A transcript the owner cleaned away would otherwise
 *  make every plain `claude` fail with "No conversation found" — one file test avoids that. Codex keeps
 *  its rollouts in dated directories, so its id is taken on trust and `codex resume` says if it is gone. */
function sessionOnDisk(kind, dir, id) {
  if (kind !== 'claude') return true
  const slug = dir.replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-')
  return existsSync(join(homedir(), '.claude', 'projects', slug, `${id}.jsonl`))
}

/** Is that conversation free to open? A window still running stamps `seen` every turn and writes
 *  `closedAt` when it ends, so an open one is left alone (two windows on one transcript is worse than a
 *  blank one) and a crashed one becomes free once the stamp goes stale. */
const OPEN_STALE_MS = 10 * 60 * 1000
function sessionFree(s) {
  if (!s?.seen || s.closedAt) return true
  const seen = Date.parse(s.seen)
  return !Number.isFinite(seen) || Date.now() - seen > OPEN_STALE_MS
}

if (!wantsNew && command.length === 1 && seatSetting(agentKind, 'autoResume', true)) {
  // Only a directory with ONE seat, or an explicit `--seat`, says whose conversation to continue: with
  // several seats, resuming "the newest" opens another agent's thinking in this window — the same guess
  // that crossed the screens, and a worse mistake, because the window then IS the other seat.
  const seat = chooseSeat(rememberedSeats(process.cwd(), agentKind), seatArg).seat
  const last = (Array.isArray(seat?.sessions) ? seat.sessions : [])
    .filter((s) => s?.id && sessionFree(s)).map((s) => s.id)
    .find((id) => sessionOnDisk(agentKind, process.cwd(), id)) ?? null
  if (last) {
    command.push(...(agentKind === 'codex' ? ['resume', last] : ['--resume', last]))
    process.stdout.write(`rany-term: continuing seat "${seat.name ?? seat.id}"'s last conversation`
      + ` (${agentKind === 'codex' ? `resume ${last}` : `--resume ${last}`}).`
      + ` \`${agentKind} --new\` starts a blank one.\n`)
  }
}

// Through a shim, `claude` must reach the real claude.cmd and not the shim again.
command[0] = resolveReal(command[0]) ?? command[0]

// Codex is NOT run in a pty: its TUI redraws many times a second and flickered inside ConPTY, and the
// mirrored frames were unreadable. Its Screen comes from its own transcript instead — the Codex bridge
// daemon tails the thread's rollout file and posts what Codex did as lines (see plugins/codex-rany).
// So the shim is a pass-through: same console, same stdin, exit code forwarded.
if (agentKind === 'codex') {
  const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' && !/\.exe$/i.test(command[0]) })
  process.exit(r.status ?? 1)
}

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

// While no seat is known yet, the screen is kept rather than thrown away — a session takes a second or two
// to bind, and the first frames are the ones that say what this window is. Oldest output goes first once
// the hold is full; the size marks (`s`, `r`) are small and always kept.
const UNBOUND_MAX_BYTES = 512 * 1024

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
  /** The session told us which seat this window is (RANY_TERM_HANDOFF). Everything held so far belongs to
   *  it, so it goes out as the first frames of that seat's screen. */
  bind(seatId, name) {
    if (!seatId || this.seatId === seatId) return false
    const held = this.seatId === null
    this.seatId = String(seatId)
    process.stderr.write(`\x1b[2mrany-term: this terminal is work-room seat ${name ? `"${name}" ` : ''}(${this.seatId})`
      + `${held && this.queue.length ? ' — sending what it has shown so far' : ''}.\x1b[0m\r\n`)
    if (this.queue.length) void this.flush()
    return true
  }
  push(t, d) {
    // Coalesce consecutive output chunks so a busy redraw is one entry, not fifty.
    const last = this.queue[this.queue.length - 1]
    if (t === 'o' && last && last.t === 'o' && last.buf.length + d.length <= MAX_BATCH_BYTES) {
      last.buf = Buffer.concat([last.buf, d])
    } else {
      this.queue.push(t === 'o' ? { t, buf: d } : { t, d })
    }
    this.bytes += t === 'o' ? d.length : 0
    if (!this.seatId) { this.trim(); return }
    if (this.bytes >= MAX_BATCH_BYTES) void this.flush()
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_MS)
  }
  /** Nothing can be sent before a seat is known, so the hold is bounded: drop from the FRONT, which is
   *  the oldest screen, and keep what the owner will actually want to see. */
  trim() {
    while (this.bytes > UNBOUND_MAX_BYTES && this.queue.length > 1) {
      const gone = this.queue.shift()
      this.bytes -= gone.t === 'o' ? gone.buf.length : 0
    }
  }
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.seatId) return

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
    // The keepalive carries the SIZE rather than a bare mark: the viewer opens on the tail of the stream,
    // and a tail without an `r` in it would render at the wrong width and scramble a full-screen TUI.
    if (!this.seatId) return
    if (Date.now() - this.lastFlush >= KEEPALIVE_MS && this.queue.length === 0)
      this.push('r', `${process.stdout.columns || cols},${process.stdout.rows || rows}`)
  }
}

// ---- run --------------------------------------------------------------------------------------------
const pty = loadPty()
const cwd = process.cwd()
const seatsHere = rememberedSeats(cwd, agentKind)
const choice = chooseSeat(seatsHere, seatArg)
const seat = choice.seat
const mirror = new Mirror(seat?.id ?? null)

/**
 * The handoff: a file this launcher owns, whose path the plugin reads out of the environment and whose
 * contents name THIS session's seat (`{agentId, channelId, sessionId}`). The plugin writes it the moment
 * the session binds — a join, a re-attach, or any hook of a session that already holds a seat — and the
 * mirror switches to that seat, sending the screen it held while waiting.
 *
 * It is how a terminal stops guessing: the launcher starts first and cannot know which seat of a
 * directory this window will be, and a wrong guess puts one agent's screen under another's name.
 */
const handoffFile = join(homedir(), '.rany-plugin', 'term', 'handoff', `${process.pid}.json`)
function readHandoff() {
  try { return handoffSeat(readFileSync(handoffFile, 'utf8')) } catch { return null }
}
let handoffTimer = null
function watchHandoff() {
  try { mkdirSync(dirname(handoffFile), { recursive: true }) } catch { /* best effort */ }
  try { rmSync(handoffFile, { force: true }) } catch { /* nothing there */ }
  // A window killed hard leaves its file behind, and pids come round again: sweep anything stale so a new
  // launcher never reads yesterday's seat out of a file it thinks is its own.
  try {
    const dir = dirname(handoffFile)
    for (const name of readdirSync(dir)) {
      const f = join(dir, name)
      if (Date.now() - statSync(f).mtimeMs > 24 * 60 * 60 * 1000) rmSync(f, { force: true })
    }
  } catch { /* nothing to sweep */ }
  // Polled, not watched: fs.watch on a file a foreign process creates is unreliable on Windows, and half a
  // second is invisible next to how long a session takes to come up. Kept running for the window's life, so
  // a room joined an hour in starts mirroring then — and a session that MOVES seat moves the screen with it.
  handoffTimer = setInterval(() => {
    const h = readHandoff()
    if (h) mirror.bind(h.id, h.name)
  }, 500)
  handoffTimer.unref?.()
}
function stopWatchingHandoff() {
  if (handoffTimer) { clearInterval(handoffTimer); handoffTimer = null }
  try { rmSync(handoffFile, { force: true }) } catch { /* gone already */ }
}
// `--seat` is the owner being explicit, and nothing a session says may move the screen off it.
if (!choice.pinned) watchHandoff()

const cols = process.stdout.columns || 120
const rows = process.stdout.rows || 30
// Windows: `claude` and `codex` are .cmd files on PATH; ConPTY runs those through cmd.exe. The arguments
// stay an ARRAY — node-pty quotes each for the Windows command line; a hand-joined string with quotes
// inside is what made cmd drop the command and sit at a prompt. A real .exe runs directly.
const [file, args] = process.platform === 'win32' && !/\.exe$/i.test(command[0])
  ? ['cmd.exe', ['/d', '/c', ...command]]
  : [command[0], command.slice(1)]
if (process.env.RANY_TERM_DEBUG) process.stderr.write(`rany-term: spawn ${file} ${JSON.stringify(args)} in ${cwd}\r\n`)
// Windows: the in-box ConPTY re-renders the screen from its own buffer and flickers on TUIs that redraw
// many times a second (Codex). node-pty ships Windows Terminal's current conpty.dll; prefer it, and fall
// back to the in-box one only if that build refuses to load. `conptyInheritCursor` keeps the first frame
// from jumping to the top-left of the outer terminal.
const ptyOpts = { name: 'xterm-256color', cols, rows, cwd,
  env: { ...process.env, RANY_TERM: '1', ...(choice.pinned ? {} : { RANY_TERM_HANDOFF: handoffFile }) } }
let child
if (process.platform === 'win32') {
  try { child = pty.spawn(file, args, { ...ptyOpts, useConptyDll: true, conptyInheritCursor: true }) }
  catch (e) {
    if (process.env.RANY_TERM_DEBUG) process.stderr.write(`rany-term: bundled conpty unavailable (${e?.message ?? e}); using the in-box one\r\n`)
    child = pty.spawn(file, args, { ...ptyOpts, conptyInheritCursor: true })
  }
} else {
  try { child = pty.spawn(file, args, ptyOpts) }
  catch (e) {
    // The mirror is a nicety; the agent is the point. A pty that cannot start must never cost the user
    // their `claude` — run the real program directly (no Screen mirror) and say why, once.
    process.stderr.write(`[33mrany-term: could not start a terminal mirror (${e?.message ?? e}); running ${basename(file)} without it.[0m
`)
    const r = spawnSync(file, args, { stdio: 'inherit', cwd, env: process.env })
    process.exit(r.status ?? (r.error ? 127 : 1))
  }
}

// Through the shims this runs on EVERY `claude`/`codex`, most of them in directories with no seat —
// those must look exactly like the plain program, so the no-seat case says nothing unless asked.
if (seat?.id)
  process.stderr.write(`\x1b[2mrany-term: mirroring this terminal to work-room seat ${seat.name ? `"${seat.name}" ` : ''}(${seat.id}) — owner-only view in RANY.\x1b[0m\r\n`)
else if (choice.waiting)
  // Several seats live here, so which one this window is, is the session's to say — not this launcher's to
  // guess. Until it does, the screen is held rather than sent to the wrong seat.
  process.stderr.write(`\x1b[2mrany-term: ${seatsHere.length} work-room seats live in ${cwd}`
    + ` (${seatsHere.slice(0, 3).map((s) => s.name ?? s.id).join(', ')}${seatsHere.length > 3 ? ', …' : ''});`
    + ` waiting for this session to say which one it holds. \`--seat <agentId>\` says it now.\x1b[0m\r\n`)
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
  stopWatchingHandoff()
  mirror.push('e', String(exitCode ?? 0))
  await mirror.flush()
  if (mirror.inflight) await mirror.inflight
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.exit(exitCode ?? 0)
})
