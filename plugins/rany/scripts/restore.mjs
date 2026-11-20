#!/usr/bin/env node
/**
 * rany-restore — after a reboot, bring the work-room seats back: every seat this machine has held (in every
 * repository, Claude Code and Codex), checked against RANY so only seats still in their rooms are offered,
 * numbered; the ones you pick reopen in their own terminal tabs, in their own directories, CONTINUING their
 * last conversation (`claude --resume …` / `codex resume …`) and taking their seat back by themselves
 * (RANY_REJOIN — no /rany-rejoin to type). The rules live in restore-core.mjs.
 *
 *   rany-restore              list, then ask which to open
 *   rany-restore --all        open every seat that is not already open
 *   rany-restore --pick 1,3   open those
 *   rany-restore --list       list only
 *   rany-restore --print      print the commands instead of opening terminals
 *
 * The plugin keeps this file at ~/.rany-plugin/restore/ and the `rany-restore` command in
 * ~/.rany-plugin/bin (on PATH once `rany-term --install` has run; otherwise call it by that path).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { restoreCandidates, parsePick, launchPlan, planCommandLine, launchScript, wtArgs, startArgs, shortWhen }
  from './restore-core.mjs'

const STATE = join(homedir(), '.rany-plugin')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const arg = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1] ?? null }
const out = (s = '') => process.stdout.write(s + '\n')

if (has('--help') || has('-h')) {
  out('rany-restore [--all | --pick 1,3 | --list] [--print]')
  out('Reopens the work-room seats this machine held, each in its own terminal, continuing its last conversation.')
  process.exit(0)
}

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

/** The same settings the plugins read: env first, then ~/.rany-plugin/rany.json; on Windows a token set
 *  with setx after this shell opened is still in the user environment, so ask for it there too. */
function config() {
  const file = readJson(join(STATE, 'rany.json')) ?? {}
  const apiUrl = (process.env.RANY_API_URL || file.apiUrl || 'https://www.rany.work/api').replace(/\/+$/, '')
  let token = String(process.env.RANY_PERSONA_TOKEN || file.token || '').trim().replace(/^['"]|['"]$/g, '')
  if (!token && process.platform === 'win32') {
    const q = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetEnvironmentVariable('RANY_PERSONA_TOKEN','User')"], { encoding: 'utf8' })
    token = String(q.stdout ?? '').trim().replace(/^['"]|['"]$/g, '')
  }
  return { apiUrl, token }
}

/** Seats RANY still has, by id (list_my_rooms over MCP — the persona token is all it needs). Null when
 *  RANY cannot be asked; the list is then shown unchecked rather than not at all. */
async function liveSeats({ apiUrl, token }) {
  if (!token) return null
  try {
    const res = await fetch(`${apiUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_my_rooms', arguments: {} } }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const body = await res.json()
    const text = body?.result?.content?.[0]?.text
    if (!text || body?.result?.isError) return null
    const map = new Map()
    for (const room of JSON.parse(text)) {
      for (const s of room.seats ?? []) {
        map.set(String(s.agentId), { state: s.state, roomName: room.roomName ?? null })
      }
    }
    return map
  } catch { return null }
}

function hasWindowsTerminal() {
  const r = spawnSync('where', ['wt'], { encoding: 'utf8', windowsHide: true })
  return r.status === 0
}

function open(plan) {
  if (process.platform === 'win32') {
    const dir = join(STATE, 'restore', 'launch')
    mkdirSync(dir, { recursive: true })
    const script = join(dir, `${plan.rejoin}.cmd`)
    writeFileSync(script, launchScript(plan))
    const [cmd, args] = hasWindowsTerminal() ? ['wt', wtArgs(plan, script)] : ['cmd', startArgs(plan, script)]
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    return true
  }
  if (process.platform === 'darwin') {
    const line = planCommandLine(plan, 'sh').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${line}"`], { detached: true, stdio: 'ignore' }).unref()
    return true
  }
  return false // Linux: terminals differ too much to pick one — the command is printed instead
}

const cfg = config()
const repos = readJson(join(STATE, 'seat-history.json'))?.repos ?? {}
const live = await liveSeats(cfg)
const rows = restoreCandidates(repos, live)

if (rows.length === 0) {
  out(Object.keys(repos).length === 0
    ? 'rany-restore: this machine has not held any work-room seat yet.'
    : 'rany-restore: none of the seats this machine held is still in a room.')
  process.exit(0)
}

if (!live) out(cfg.token
  ? 'rany-restore: could not reach RANY, so seats removed since are listed too.'
  : 'rany-restore: no RANY_PERSONA_TOKEN, so the list is not checked against RANY.')

let room = null
rows.forEach((r, i) => {
  const key = r.channelId ?? r.agentId
  if (key !== room) { room = key; out(`\n  ${r.roomName ?? `room ${r.channelId ?? '?'}`}`) }
  const when = r.session ? `last conversation ${shortWhen(r.session.ts)}` : 'no conversation recorded'
  const flags = [r.state === 'paused' ? 'paused' : null, r.openNow ? 'OPEN NOW' : null,
    launchPlan(r) ? null : `open by hand (${r.agent})`].filter(Boolean).join(', ')
  out(`  ${String(i + 1).padStart(2)}) ${r.name} · ${r.agent} · ${r.dir ?? '?'} · ${when}${flags ? ` · ${flags}` : ''}`)
})
out()

if (has('--list')) process.exit(0)

let answer = arg('--pick') ?? (has('--all') ? 'all' : null)
if (answer === null) {
  if (!process.stdin.isTTY) { out('rany-restore: pass --all or --pick 1,3 when not run in a terminal.'); process.exit(1) }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  answer = await rl.question('Which to open? numbers (1 3, 2-4), "all", or Enter to quit: ')
  rl.close()
}
const { picks, bad } = parsePick(answer, rows.length)
if (bad.length) out(`rany-restore: ignored ${bad.join(', ')} (not in the list).`)
// "all" never reopens a conversation a live window is still writing; naming it by number is deliberate.
const isAll = !/\d/.test(String(answer))
const chosen = picks.map((i) => rows[i]).filter((r) => !(isAll && r.openNow))

let opened = 0
for (const r of chosen) {
  const plan = launchPlan(r)
  if (!plan) { out(`  ${r.name}: ${r.agent} is opened by hand — start it in ${r.dir ?? 'its directory'} and run /rany-rejoin ${r.agentId}.`); continue }
  if (!existsSync(plan.cwd)) { out(`  ${r.name}: ${plan.cwd} no longer exists — skipped.`); continue }
  if (has('--print') || !open(plan)) {
    out(`  ${r.name}:  ${planCommandLine(plan, process.platform === 'win32' ? 'powershell' : 'sh')}`)
    continue
  }
  opened++
  out(`  opened ${r.name} (${r.agent}${r.session ? ', continuing its last conversation' : ', new conversation'})`)
}
if (opened) out(`\nEach window takes its seat back by itself. Close this one whenever you like.`)
