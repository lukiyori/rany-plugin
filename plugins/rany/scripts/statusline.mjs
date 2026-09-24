#!/usr/bin/env node
/**
 * RANY status line for Claude Code: "which room is this window sitting in, and as whom".
 *
 * The owner, after coming back to a terminal: "bir odaya girdiğim zaman terminalde o odaya girip
 * girmediğimi, hangi odada olduğumu sonra geri döndüğümde göremiyorum". The join prints one line and
 * scrolls away; a seat then lives on silently. This puts it where it stays visible:
 *
 *     ⬢ #resimler · Reviewer
 *
 * Claude Code runs the configured `statusLine.command` on every render with the session JSON on stdin
 * and takes the first line of stdout. So this script must be FAST and silent on failure — it reads two
 * small local files and never touches the network.
 *
 * There is only ONE status line slot in settings.json, and something else may already own it (a theme,
 * another plugin). `--install` therefore keeps whatever was there, stores it as `statusLine.chain` in
 * ~/.rany-plugin/rany.json, and prints that command's output before RANY's segment. Nothing is taken
 * over silently, and `--uninstall` gives the slot back exactly as it was.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const stateDir = join(homedir(), '.rany-plugin')
const bindFile = join(stateDir, 'bindings.json')
const seatHistoryFile = join(stateDir, 'seat-history.json')
const configFile = join(stateDir, 'rany.json')
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const settingsFile = join(claudeDir, 'settings.json')

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}
const norm = (dir) => resolve(dir ?? '').replace(/[\\/]+$/, '').toLowerCase()

/** The session JSON Claude Code writes to stdin. Never block on it: a person running this by hand has
 *  a terminal on stdin, and a pipe that stays open must not wedge the status bar. */
function readStdin() {
  if (process.stdin.isTTY) return ''
  try { return readFileSync(0, 'utf8') } catch { return '' }
}

/** The seat THIS window holds: the binding written by the join (or the re-attach) whose sessionId is
 *  ours. Falling back to a seat of this directory would name a seat another window is holding, so a
 *  window with no seat of its own says nothing at all. */
function seatFor(sessionId, cwd) {
  const boards = readJson(bindFile)?.boards ?? {}
  const rows = Object.entries(boards)
    .filter(([, e]) => e && typeof e === 'object' && e.room)
    .map(([agentId, e]) => ({ agentId, ...e }))
  // With a session id, the answer is that session's seat or nothing: a window that holds no seat must
  // not wear the seat of the window next to it, which is exactly what the directory would suggest.
  if (sessionId) return rows.find((r) => r.sessionId === sessionId) ?? null
  // No session id at all (an older Claude Code, or a hand run): the one seat bound in this directory, if
  // the directory holds exactly one — with two, naming either would be a guess.
  const here = rows.filter((r) => norm(r.dir) === norm(cwd))
  return here.length === 1 ? here[0] : null
}

/** The room's name as the plugin last heard it; the channel id is the honest fallback. */
function roomLabel(seat) {
  const fromBinding = seat.room?.roomName
  if (fromBinding) return `#${fromBinding}`
  const repos = readJson(seatHistoryFile)?.repos ?? {}
  for (const seats of Object.values(repos)) {
    const row = seats?.[seat.agentId]
    if (row?.roomName) return `#${row.roomName}`
  }
  return `room ${seat.room?.channelId ?? '?'}`
}

/** Whatever owned the status line before RANY, run with the same stdin so it renders as it always did. */
function chained(stdin) {
  const chain = readJson(configFile)?.statusLine?.chain
  if (!chain || typeof chain !== 'string') return ''
  try {
    const out = process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', chain], { input: stdin, encoding: 'utf8', timeout: 2000, windowsHide: true })
      : execFileSync('/bin/sh', ['-c', chain], { input: stdin, encoding: 'utf8', timeout: 2000 })
    return (out || '').split('\n')[0].trim()
  } catch { return '' }
}

// ── --install / --uninstall: wire the slot without stealing it ────────────────────────────────────
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}
const ownCommand = () => {
  const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  return `node "${join(here, 'statusline.mjs')}"`
}
const isOurs = (cmd) => typeof cmd === 'string' && cmd.includes('statusline.mjs')

if (process.argv.includes('--install')) {
  const settings = (existsSync(settingsFile) && readJson(settingsFile)) || {}
  const current = settings.statusLine?.command
  if (isOurs(current)) {
    process.stdout.write('RANY: the status line already shows your work-room seat.\n')
    process.exit(0)
  }
  const config = readJson(configFile) ?? {}
  // Keep what was there. A second --install must not chain RANY to itself, hence the isOurs guard above.
  config.statusLine = { ...(config.statusLine ?? {}), chain: current ?? null }
  writeJson(configFile, config)
  settings.statusLine = { type: 'command', command: ownCommand() }
  writeJson(settingsFile, settings)
  process.stdout.write(current
    ? `RANY: the status line now shows your work-room seat after what was already there (${current}).\n`
    : 'RANY: the status line now shows your work-room seat. Open a new session to see it.\n')
  process.exit(0)
}

if (process.argv.includes('--uninstall')) {
  const settings = (existsSync(settingsFile) && readJson(settingsFile)) || {}
  if (!isOurs(settings.statusLine?.command)) {
    process.stdout.write('RANY: the status line is not RANY\'s; nothing changed.\n')
    process.exit(0)
  }
  const chain = readJson(configFile)?.statusLine?.chain
  if (chain) settings.statusLine = { type: 'command', command: chain }
  else delete settings.statusLine
  writeJson(settingsFile, settings)
  process.stdout.write('RANY: the status line is back to what it was before.\n')
  process.exit(0)
}

// ── the render ────────────────────────────────────────────────────────────────────────────────────
const stdin = readStdin()
let session = null
try { session = JSON.parse(stdin) } catch { /* not JSON: render what we can */ }
const sessionId = typeof session?.session_id === 'string' ? session.session_id : ''
const cwd = session?.workspace?.current_dir || session?.cwd || process.cwd()

const before = chained(stdin)
const seat = seatFor(sessionId, cwd)
const ours = seat ? `\u001b[36m⬢ ${roomLabel(seat)} · ${seat.room?.name ?? 'seat'}\u001b[0m` : ''
const line = [before, ours].filter(Boolean).join('  ')
if (line) process.stdout.write(line + '\n')
