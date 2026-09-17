#!/usr/bin/env node
// RANY MCP for Kimi: a stdio MCP server that forwards every JSON-RPC message to RANY's remote MCP endpoint
// (POST <api>/mcp, stateless Streamable HTTP with plain JSON responses).
//
// Why a proxy instead of `kimi mcp add --transport http … -H "Authorization: Bearer …"`: that writes the
// persona token into ~/.kimi/mcp.json in clear text, and kimi-cli does not expand environment variables in
// headers. The proxy reads the token when it starts — RANY_KIMI_TOKEN, ~/.rany-plugin/kimi.json, then
// RANY_PERSONA_TOKEN — so the config file only names a script. Zero dependencies.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

function fileConfig() {
  try { return JSON.parse(readFileSync(join(homedir(), '.rany-plugin', 'kimi.json'), 'utf8')) } catch { return {} }
}

/** A stdio MCP server may be started with a trimmed environment (the MCP SDK passes only a safe subset
 *  by default), so an env var set with `setx` can be missing here even though the terminal has it. On
 *  Windows, read the user's persistent environment as a last resort. */
function userEnv(name) {
  if (process.platform !== 'win32') return ''
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
    const m = new RegExp(`${name}\\s+REG_\\w+\\s+(\\S+)`).exec(r.stdout ?? '')
    return m ? m[1] : ''
  } catch { return '' }
}

const file = fileConfig()
const apiUrl = (process.env.RANY_API_URL || file.apiUrl || 'https://www.rany.work/api').replace(/\/+$/, '')
const token = process.env.RANY_KIMI_TOKEN || file.token || process.env.RANY_PERSONA_TOKEN
  || userEnv('RANY_KIMI_TOKEN') || userEnv('RANY_PERSONA_TOKEN')

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const fail = (id, message) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message } }) }

async function forward(msg) {
  const isRequest = msg && typeof msg === 'object' && 'method' in msg && msg.id !== undefined && msg.id !== null
  if (!token) return fail(msg?.id, 'RANY: no Kimi persona token. Run the RANY Kimi installer with --token (RANY → persona settings → Kimi).')
  let res
  try {
    res = await fetch(`${apiUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify(msg),
    })
  } catch (e) {
    return fail(msg?.id, `RANY: could not reach ${apiUrl} (${e?.message ?? e})`)
  }
  const text = await res.text()
  if (!isRequest) return // a notification: the server answers 202 with no body
  if (!res.ok) return fail(msg.id, `RANY: MCP request failed (HTTP ${res.status})${text ? `: ${text.slice(0, 300)}` : ''}`)
  // Plain JSON is what RANY sends; accept a single SSE `data:` frame too, in case a proxy upgrades it.
  const body = /^\s*[[{]/.test(text) ? text : (text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop() ?? '')
  try { write(JSON.parse(body)) } catch { fail(msg.id, 'RANY: unreadable MCP response') }
}

let buffer = ''
let queue = Promise.resolve()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    // In order: an MCP client expects `initialize` answered before it sends `notifications/initialized`.
    queue = queue.then(() => (Array.isArray(msg) ? Promise.all(msg.map(forward)) : forward(msg))).catch(() => {})
  }
})
process.stdin.on('end', () => { void queue.then(() => process.exit(0)) })
