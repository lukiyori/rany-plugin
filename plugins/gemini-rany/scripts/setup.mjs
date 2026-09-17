#!/usr/bin/env node
// Set up RANY for Gemini CLI (ADR-054) — the parts a Gemini extension cannot do for itself.
//
// The extension (gemini-extension.json + hooks + skills + MCP proxy) is installed with Gemini's own command:
//   gemini extensions link "$HOME/rany-plugin/plugins/gemini-rany"
// but an extension can neither change user settings nor allow a tool call, and RANY's wake needs both:
//
//   1. ~/.gemini/settings.json: experimental.modelSteering = true and
//      tools.shell.backgroundCompletionBehavior = "inject" — so the RANY listener, a background shell command,
//      starts a turn by itself when it ends;
//   2. ~/.gemini/policies/rany.toml: allow exactly the listener command (node "<~/.rany-plugin/gemini/bridge.mjs>"
//      --listen …) without a confirmation prompt, in the default and auto-edit modes;
//   3. with --token, the Gemini persona token in ~/.rany-plugin/gemini.json (read by the bridge and the MCP proxy;
//      Gemini hides any environment variable named *TOKEN* from extensions, so the file is the dependable source).
//
//   node plugins/gemini-rany/scripts/setup.mjs [--token rany_persona_…] [--api https://…/api]
//   node plugins/gemini-rany/scripts/setup.mjs --undo

import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const RANY_HOME = join(homedir(), '.rany-plugin')
const STABLE = join(RANY_HOME, 'gemini')
const GEMINI_HOME = process.env.GEMINI_CLI_HOME ? join(process.env.GEMINI_CLI_HOME, '.gemini') : join(homedir(), '.gemini')
const SETTINGS = join(GEMINI_HOME, 'settings.json')
const POLICY = join(GEMINI_HOME, 'policies', 'rany.toml')

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const value = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const say = (s) => process.stdout.write(s + '\n')
const fwd = (p) => p.replace(/\\/g, '/')
const readText = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

function loadSettings() {
  const raw = readText(SETTINGS)
  if (!raw.trim()) return {}
  try { return JSON.parse(raw) } catch { return null } // commented JSON: we do not rewrite what we cannot round-trip
}

if (flag('--undo')) {
  rmSync(POLICY, { force: true })
  say(`removed ${POLICY}`)
  say('Left settings.json alone (modelSteering / backgroundCompletionBehavior may be yours too); the token and history stay.')
  say('Remove the extension with: gemini extensions uninstall rany')
  process.exit(0)
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  say(`RANY for Gemini needs Node 22 or newer (this is ${process.version}).`)
  process.exit(1)
}

// The listener's stable path must exist before the policy names it (SessionStart refreshes it on every start).
mkdirSync(STABLE, { recursive: true })
for (const f of ['bridge.mjs', 'mcp-proxy.mjs']) copyFileSync(join(here, f), join(STABLE, f))
if (existsSync(join(here, '..', 'version.json'))) copyFileSync(join(here, '..', 'version.json'), join(STABLE, 'version.json'))

const token = value('--token')
const api = value('--api')
if (token || api) {
  const path = join(RANY_HOME, 'gemini.json')
  let current = {}
  try { current = JSON.parse(readText(path) || '{}') } catch { /* fresh */ }
  if (token) {
    if (!/^rany_persona_[A-Za-z0-9_-]{16,}$/.test(token)) { say('That does not look like a RANY persona token (rany_persona_…).'); process.exit(1) }
    current.token = token
  }
  if (api) current.apiUrl = api.replace(/\/+$/, '')
  mkdirSync(RANY_HOME, { recursive: true })
  writeFileSync(path, JSON.stringify(current, null, 2) + '\n')
  try { chmodSync(path, 0o600) } catch { /* Windows */ }
  say(`saved ${token ? 'the Gemini token' : 'the API URL'} to ${path}`)
}

const settings = loadSettings()
if (settings === null) {
  say(`${SETTINGS} has comments or is not plain JSON, so it was not edited. Add these two settings yourself:`)
  say('  "experimental": { "modelSteering": true },')
  say('  "tools": { "shell": { "backgroundCompletionBehavior": "inject" } }')
} else {
  settings.experimental = { ...(settings.experimental ?? {}), modelSteering: true }
  settings.tools = { ...(settings.tools ?? {}), shell: { ...(settings.tools?.shell ?? {}), backgroundCompletionBehavior: 'inject' } }
  mkdirSync(GEMINI_HOME, { recursive: true })
  if (existsSync(SETTINGS)) writeFileSync(`${SETTINGS}.rany-backup`, readText(SETTINGS))
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')
  say(`enabled model steering and background-completion injection in ${SETTINGS}`)
}

// Only the listener: the exact prefix the SessionStart context tells the model to run.
const prefix = `node "${fwd(join(STABLE, 'bridge.mjs'))}" --listen`
mkdirSync(dirname(POLICY), { recursive: true })
writeFileSync(POLICY, [
  '# Written by RANY (plugins/gemini-rany/scripts/setup.mjs). Lets the RANY listener — a background command',
  '# that waits for RANY work addressed to this session — start without a confirmation prompt. Nothing else.',
  '[[rule]]',
  'toolName = "run_shell_command"',
  `commandPrefix = '${prefix}'`,
  'decision = "allow"',
  'priority = 100',
  'modes = ["default", "autoEdit"]',
  '',
].join('\n'))
say(`allowed the RANY listener in ${POLICY}`)

say('')
say('RANY for Gemini is set up. If you have not yet, install the extension itself:')
say(`  gemini extensions link "${fwd(join(here, '..'))}"`)
say('Then start Gemini in a repository: it will start the RANY listener in the background, and a pasted')
say('work-room invite link or /rany:rany-bind <boardId> connects the session to RANY.')
