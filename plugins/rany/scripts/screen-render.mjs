/**
 * A Claude Code transcript row → the lines a work-room seat's Screen shows (ADR-050, transcript variant).
 *
 * The real-terminal mirror (rany-term) only exists where the session was started through the `claude`
 * shim. Claude Code inside the desktop app, the VS Code extension, or a terminal opened without the shim
 * has no pty to catch — and its Screen stayed empty while the agent worked (owner, 2026-11-23: "claude
 * code'da yapılanları gerçek zamanlı görebileceğimiz bir şey yok … screen boş"). Every one of them still
 * writes its transcript (`~/.claude/projects/<dir>/<session>.jsonl`) as it goes, so the Screen is fed from
 * there, the way the Codex bridge feeds it from the rollout: what the owner typed, what the agent said,
 * each command and tool with a short result, and every file it changed.
 *
 * Pure: no I/O. `state` carries what one row needs from an earlier one (which tool a result belongs to).
 */

export const A = { dim: '\x1b[2m', off: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m', red: '\x1b[31m' }
const PAD = ' '.repeat(9)

export const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
/** Indented block of at most `lines` lines (and `chars` characters), for a tool's output. */
export function block(s, lines = 8, chars = 1200) {
  const all = clip(String(s ?? '').replace(/\r/g, ''), chars).replace(/\s+$/, '').split('\n')
  const shown = all.slice(0, lines).map((l) => PAD + l)
  if (all.length > lines) shown.push(`${PAD}… ${all.length - lines} more lines`)
  return shown.join('\r\n')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c) => (c && c.type === 'text' ? c.text ?? '' : '')).join('')
}

/** Short label of a path: relative to the session's directory when inside it. */
function shortPath(p, cwd) {
  const s = String(p ?? '')
  if (!cwd) return s
  const norm = (x) => x.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const base = norm(cwd)
  return norm(s).startsWith(base + '/') ? s.replace(/\\/g, '/').slice(base.length + 1) : s
}

/** One tool call → its line (no output yet: the result arrives in a later row). */
export function toolUseLine(name, input, cwd) {
  const i = input && typeof input === 'object' ? input : {}
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `${A.cyan}$ ${clip(oneLine(i.command), 300)}${A.off}`
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `${A.yellow}✎ ${name === 'Write' ? 'write' : 'edit'}${A.off} ${clip(shortPath(i.file_path ?? i.notebook_path, cwd), 200)}`
    case 'Read':
      return `${A.dim}read ${clip(shortPath(i.file_path, cwd), 200)}${A.off}`
    case 'Grep':
      return `${A.dim}search ${clip(oneLine(i.pattern), 120)}${i.path ? ` in ${clip(shortPath(i.path, cwd), 120)}` : ''}${A.off}`
    case 'Glob':
      return `${A.dim}find ${clip(oneLine(i.pattern), 160)}${A.off}`
    case 'Agent':
    case 'Task':
      return `${A.magenta}⇢ sub-agent${A.off} ${clip(oneLine(i.description ?? i.prompt), 200)}`
    case 'TodoWrite':
      return null
    case 'WebFetch':
      return `${A.dim}fetch ${clip(i.url, 200)}${A.off}`
    case 'WebSearch':
      return `${A.dim}web search ${clip(oneLine(i.query), 160)}${A.off}`
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ''))
      let args = ''
      try { args = JSON.stringify(i) } catch { /* unprintable */ }
      if (m) return `${A.magenta}⚙ ${m[1].replace(/^plugin_[^_]+_/, '')} ${m[2]}${A.off} ${A.dim}${clip(args, 200)}${A.off}`
      return `${A.magenta}⚙ ${clip(name, 60)}${A.off} ${A.dim}${clip(args, 200)}${A.off}`
    }
  }
}

/** Which tools' output is worth a few lines on the screen. Reads and searches are not: they are the agent
 *  looking, and their output is the file it read. */
const SHOW_OUTPUT = new Set(['Bash', 'PowerShell'])

/**
 * One transcript row (already parsed) → terminal text with \r\n, or null for rows the screen does not need
 * (thinking, meta rows, a sub-agent's own steps, hook bookkeeping).
 */
export function screenLines(row, state = {}) {
  if (!row || typeof row !== 'object' || row.isMeta || row.isSidechain) return null
  state.tools ??= new Map()
  const at = A.dim + String(row.timestamp ?? '').slice(11, 19) + A.off + ' '
  const cwd = typeof row.cwd === 'string' ? row.cwd : state.cwd ?? null
  if (cwd) state.cwd = cwd

  if (row.type === 'system') {
    if (row.subtype === 'compact_boundary') return `${at}${A.dim}── context compacted ──${A.off}`
    return null
  }

  const msg = row.message
  if (!msg || typeof msg !== 'object') return null

  if (row.type === 'user') {
    if (typeof msg.content === 'string') {
      const t = msg.content.trim()
      // Hook output, slash-command plumbing and reminders arrive as user rows wrapped in tags.
      if (!t || t.startsWith('<')) return null
      return `${at}${A.green}›${A.off} ${clip(t.replace(/\s*\n\s*/g, ' ⏎ '), 600)}`
    }
    if (!Array.isArray(msg.content)) return null
    const out = []
    for (const c of msg.content) {
      if (c?.type === 'text') {
        const t = String(c.text ?? '').trim()
        if (t && !t.startsWith('<')) out.push(`${at}${A.green}›${A.off} ${clip(t.replace(/\s*\n\s*/g, ' ⏎ '), 600)}`)
      } else if (c?.type === 'tool_result') {
        const tool = state.tools.get(c.tool_use_id)
        state.tools.delete(c.tool_use_id)
        const body = textOf(c.content)
        if (c.is_error) out.push(`${PAD}${A.red}✗ ${clip(oneLine(body), 300)}${A.off}`)
        else if (tool && SHOW_OUTPUT.has(tool) && body.trim()) out.push(A.dim + block(body) + A.off)
      }
    }
    return out.length ? out.join('\r\n') : null
  }

  if (row.type === 'assistant' && Array.isArray(msg.content)) {
    const out = []
    for (const c of msg.content) {
      if (c?.type === 'text') {
        const t = String(c.text ?? '').trim()
        if (t) out.push(`${at}${A.bold}${clip(t, 2000).replace(/\r?\n/g, '\r\n' + PAD)}${A.off}`)
      } else if (c?.type === 'tool_use') {
        if (c.id) state.tools.set(c.id, c.name)
        // Keep the map small: results normally follow at once, so anything old is an abandoned call.
        if (state.tools.size > 200) state.tools.delete(state.tools.keys().next().value)
        const line = toolUseLine(c.name, c.input, cwd)
        if (line) out.push(at + line)
      }
    }
    return out.length ? out.join('\r\n') : null
  }
  return null
}
