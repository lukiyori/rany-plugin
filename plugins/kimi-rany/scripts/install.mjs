#!/usr/bin/env node
// Install (or remove) RANY for Kimi Code CLI (ADR-054).
//
// Kimi's own plugins can add tools and skills, but not hooks or MCP servers — and RANY needs both. So this
// installer does what a plugin manifest would, in the user's Kimi config, and nothing else:
//
//   1. copies the bridge and the MCP proxy to ~/.rany-plugin/kimi/ (a stable path the hooks can name,
//      independent of where this checkout lives);
//   2. registers the `rany` MCP server in ~/.kimi/mcp.json as the stdio proxy (no token in the file);
//   3. adds SessionStart / UserPromptSubmit / PostToolUse / SessionEnd [[hooks]] to ~/.kimi/config.toml,
//      inside a marked block it owns, and raises the background notification tail so a wake text fits;
//   4. writes the /skill:rany-* skills to ~/.kimi/skills/;
//   5. with --token, stores the Kimi persona token in ~/.rany-plugin/kimi.json.
//
// Run it again after updating the checkout: every step replaces its own previous result.
//
//   node plugins/kimi-rany/scripts/install.mjs [--token rany_persona_…] [--api https://…/api]
//   node plugins/kimi-rany/scripts/install.mjs --uninstall

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pluginRoot = join(here, '..')
const RANY_HOME = join(homedir(), '.rany-plugin')
const TARGET = join(RANY_HOME, 'kimi')
const KIMI_HOME = process.env.KIMI_SHARE_DIR || join(homedir(), '.kimi')
const CONFIG = join(KIMI_HOME, 'config.toml')
const MCP = join(KIMI_HOME, 'mcp.json')
const SKILLS = join(KIMI_HOME, 'skills')
const BEGIN = '# >>> rany (managed by the RANY Kimi installer — edits inside this block are replaced) >>>'
const END = '# <<< rany <<<'
const SKILL_NAMES = () => readdirSync(join(pluginRoot, 'skills'))

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const value = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const fwd = (p) => p.replace(/\\/g, '/')
const say = (s) => process.stdout.write(s + '\n')

function readText(p) { try { return readFileSync(p, 'utf8') } catch { return '' } }

function stripBlock(text) {
  const a = text.indexOf(BEGIN)
  if (a < 0) return text
  const b = text.indexOf(END, a)
  const tail = b < 0 ? '' : text.slice(b + END.length)
  return (text.slice(0, a).replace(/\s+$/, '') + '\n' + tail.replace(/^\s*\n/, '')).replace(/\n{3,}$/, '\n')
}

/** Set `key = value` in a TOML [section] when the current value is lower (or absent); returns the text.
 *  Only raises: a user who set a bigger tail keeps it. */
function raiseInSection(text, section, key, min) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === `[${section}]`)
  if (start < 0) return null // no such section: the caller adds it inside the managed block
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^\s*\[/.test(lines[i])) { end = i; break }
  const at = lines.slice(start + 1, end).findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l))
  if (at >= 0) {
    const idx = start + 1 + at
    const current = Number(/=\s*(\d+)/.exec(lines[idx])?.[1] ?? 0)
    if (current < min) lines[idx] = `${key} = ${min}`
  } else {
    lines.splice(start + 1, 0, `${key} = ${min}`)
  }
  return lines.join('\n')
}

function stopDaemon() {
  const bridge = join(TARGET, 'bridge.mjs')
  if (existsSync(bridge)) spawnSync(process.execPath, [bridge, '--stop'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
}

if (flag('--uninstall')) {
  stopDaemon()
  const cfg = readText(CONFIG)
  if (cfg.includes(BEGIN)) {
    const stripped = stripBlock(cfg.replace(/\r\n/g, '\n'))
    writeFileSync(CONFIG, cfg.includes('\r\n') ? stripped.replace(/\n/g, '\r\n') : stripped)
    say(`removed the RANY hooks from ${CONFIG}`)
  }
  try {
    const mcp = JSON.parse(readText(MCP) || '{}')
    if (mcp.mcpServers?.rany) { delete mcp.mcpServers.rany; writeFileSync(MCP, JSON.stringify(mcp, null, 2) + '\n'); say(`removed the rany MCP server from ${MCP}`) }
  } catch { say(`could not read ${MCP}; left it alone`) }
  for (const n of SKILL_NAMES()) rmSync(join(SKILLS, n), { recursive: true, force: true })
  rmSync(TARGET, { recursive: true, force: true })
  say('removed the /skill:rany-* skills and ~/.rany-plugin/kimi. Your token (~/.rany-plugin/kimi.json) and room/board history were kept.')
  say('Restart Kimi for it to take effect.')
  process.exit(0)
}

// Node 22+ is what the daemon needs (global WebSocket). Refuse early with the reason, instead of installing
// hooks that start a daemon which silently exits.
const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  say(`RANY for Kimi needs Node 22 or newer (this is ${process.version}). Install Node 22, then run this again with it.`)
  process.exit(1)
}

// 1. stable copy
mkdirSync(TARGET, { recursive: true })
for (const f of ['bridge.mjs', 'mcp-proxy.mjs']) copyFileSync(join(here, f), join(TARGET, f))
copyFileSync(join(pluginRoot, 'version.json'), join(TARGET, 'version.json'))
const version = JSON.parse(readText(join(pluginRoot, 'version.json'))).version
const node = fwd(process.execPath)
const bridge = fwd(join(TARGET, 'bridge.mjs'))

// 5. token (before the hooks, so the first session already has it)
const token = value('--token')
const api = value('--api')
if (token || api) {
  const path = join(RANY_HOME, 'kimi.json')
  let current = {}
  try { current = JSON.parse(readText(path) || '{}') } catch { /* fresh */ }
  if (token) {
    if (!/^rany_persona_[A-Za-z0-9_-]{16,}$/.test(token)) { say('That does not look like a RANY persona token (rany_persona_…).'); process.exit(1) }
    current.token = token
  }
  if (api) current.apiUrl = api.replace(/\/+$/, '')
  mkdirSync(RANY_HOME, { recursive: true })
  writeFileSync(path, JSON.stringify(current, null, 2) + '\n')
  try { chmodSync(path, 0o600) } catch { /* Windows: the profile directory is already per-user */ }
  say(`saved ${token ? 'the Kimi token' : 'the API URL'} to ${path}`)
}

// 2. MCP server
mkdirSync(KIMI_HOME, { recursive: true })
let mcp = {}
try { mcp = JSON.parse(readText(MCP) || '{}') } catch { say(`${MCP} is not valid JSON — fix or delete it, then run this again.`); process.exit(1) }
mcp.mcpServers = { ...(mcp.mcpServers ?? {}), rany: { command: node, args: [fwd(join(TARGET, 'mcp-proxy.mjs'))] } }
writeFileSync(MCP, JSON.stringify(mcp, null, 2) + '\n')
say(`registered the rany MCP server in ${MCP}`)

// 3. hooks + notification tail. TOML literal strings ('…') need no escaping for the quoted Windows paths.
const original = readText(CONFIG)
// Edit with \n only and restore the file's own line endings on write: in a JS /m regex a lone \r also counts
// as a line start, so on a CRLF file removing a line could swallow the \n and glue two statements together.
const crlf = original.includes('\r\n')
let cfg = stripBlock(original.replace(/\r\n/g, '\n'))
// Kimi writes a top-level `hooks = []` into a fresh config. TOML forbids defining `hooks` both inline and as
// [[hooks]] tables, so an empty inline array is dropped; a non-empty one is the user's own hooks, which we
// must not rewrite — ask them to move those into [[hooks]] tables instead.
const inlineHooks = /^\s*hooks\s*=\s*\[(.*)\]\s*$/m.exec(cfg)
if (inlineHooks) {
  if (inlineHooks[1].trim()) {
    say(`${CONFIG} defines hooks inline (hooks = [ … ]). Move them into [[hooks]] tables, then run this again.`)
    process.exit(1)
  }
  cfg = cfg.replace(/^\s*hooks\s*=\s*\[\s*\]\s*\r?\n?/m, '')
}
const block = [BEGIN]
for (const [key, min] of [['notification_tail_lines', 200], ['notification_tail_chars', 16000]]) {
  const next = raiseInSection(cfg, 'background', key, min)
  if (next !== null) cfg = next
}
if (!/^\s*\[background\]\s*$/m.test(cfg)) block.push('[background]', 'notification_tail_lines = 200', 'notification_tail_chars = 16000', '')
const hook = (event, argName, timeout) => [
  '[[hooks]]', `event = "${event}"`, `command = '"${node}" "${bridge}" ${argName}'`, `timeout = ${timeout}`, '',
]
block.push(...hook('SessionStart', '--ensure', 20), ...hook('UserPromptSubmit', '--ping', 15),
  ...hook('PostToolUse', '--beat', 10), ...hook('SessionEnd', '--bye', 5), END)
if (original) writeFileSync(`${CONFIG}.rany-backup`, original)
const edited = cfg.replace(/\s*$/, '\n\n') + block.join('\n') + '\n'
writeFileSync(CONFIG, crlf ? edited.replace(/\n/g, '\r\n') : edited)
// A config Kimi cannot parse stops Kimi from starting at all. Check it with the TOML parser Kimi itself uses
// (Python's tomllib) and put the original back if it fails.
const verdict = checkToml(CONFIG)
if (verdict === false) {
  if (original) writeFileSync(CONFIG, original)
  say(`The edited ${CONFIG} would not parse, so it was restored unchanged. Nothing else was left half-done except the`)
  say('MCP entry and the copied scripts; run with --uninstall to remove those, and report the config shape.')
  process.exit(1)
}
say(`added the RANY hooks to ${CONFIG}${verdict === null ? ' (no Python found to double-check the TOML)' : ''}`)

/** true = parses, false = does not, null = no Python 3.11+ to ask. */
function checkToml(path) {
  const code = 'import sys,tomllib;tomllib.load(open(sys.argv[1],"rb"))'
  for (const py of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(py, ['-c', code, path], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (r.error || /No module named .?tomllib/.test(r.stderr ?? '')) continue
    return r.status === 0
  }
  return null
}

// 4. skills
for (const n of SKILL_NAMES()) {
  const src = readText(join(pluginRoot, 'skills', n, 'SKILL.md'))
  mkdirSync(join(SKILLS, n), { recursive: true })
  writeFileSync(join(SKILLS, n, 'SKILL.md'), src.replaceAll('{{NODE}}', node).replaceAll('{{BRIDGE}}', bridge))
}
say(`wrote ${SKILL_NAMES().length} skills to ${SKILLS} (/skill:rany-bind, /skill:rany-join, …)`)

stopDaemon() // the next session starts the new version
const status = spawnSync(process.execPath, [join(TARGET, 'bridge.mjs'), '--status'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
say('')
say(`RANY for Kimi ${version} installed.`)
say(status.stdout.trim())
say('')
say('Next: restart Kimi (running sessions keep their old config), send one prompt, and paste a work-room')
say('invite link — or /skill:rany-bind <boardId> in the repository that owns a board.')
