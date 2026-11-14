/**
 * Session archive (ADR-111 phase 1): what the plugin does to a seated session's transcript before it leaves
 * this machine. Pure functions — no I/O — so the redaction can be tested on its own.
 *
 * Redaction is best effort and runs on the CLIENT: the secret never reaches RANY at all. It masks
 *   · the VALUES of secret-looking environment variables of this process (RANY_*, *_TOKEN, *_SECRET, *_KEY, …),
 *   · well-known token shapes (RANY persona/seat tokens, Anthropic/OpenAI keys, AWS access keys, GitHub/GitLab/
 *     Slack tokens, PEM private keys),
 *   · Authorization headers, connection-string passwords, user:password@ in URLs,
 *   · `NAME=value` and `"SomethingSecret": "value"` pairs whose name says secret.
 * Every replacement keeps the JSONL valid (no quotes or backslashes are introduced) and is counted, so the owner
 * can see that it ran. Owner deletion is the backstop for what a pattern misses.
 */

export const REDACTED = '[REDACTED]'

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CONN(ECTION)?_?STRING)/i

/** The values worth masking from an environment: secret-named, or RANY's own, and long enough to be a secret
 *  rather than a word that happens to be in every transcript. Longest first, so a value that contains another
 *  is masked whole. */
export function secretValuesOf(env = {}) {
  const out = new Set()
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    const value = v.trim()
    if (value.length < 8 || /\s/.test(value) || /^(true|false|null|undefined|\d+)$/i.test(value)) continue
    if (SECRET_NAME.test(k) || /^RANY_/.test(k)) out.add(value)
  }
  return [...out].sort((a, b) => b.length - a.length)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** [pattern, replacement] — a replacement keeps the part that says WHAT it was, so the transcript still reads. */
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----PRIVATE KEY ${REDACTED}-----`],
  [/\brany_(persona|seat|bot|plugin|setup)_[A-Za-z0-9]{16,}/g, `rany_$1_${REDACTED}`],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{20,}/g, `sk-$1${REDACTED}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, `AKIA${REDACTED}`],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, `gh_${REDACTED}`],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, `glpat-${REDACTED}`],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, `xox-${REDACTED}`],
  [/(Authorization:\s*(?:Bearer|Bot|Basic|Token)\s+)[^\s"'\\]+/gi, `$1${REDACTED}`],
  [/(\b(?:password|passwd|pwd)\s*=\s*)[^;"'\\\s]+/gi, `$1${REDACTED}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"\\]+:)[^@\s/"\\]+@/gi, `$1${REDACTED}@`],
  [/(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY))(\s*=\s*)(?!\[REDACTED\])([^\s"'\\]{6,})/g, `$1$2${REDACTED}`],
  [/(\\?"[A-Za-z_]*(?:secret|password|passwd|token|apikey|api_key|accesskey|access_key|privatekey)[A-Za-z_]*\\?"\s*:\s*\\?")(?!\[REDACTED\])([^"\\]{6,})/gi, `$1${REDACTED}`],
]

/** Mask what looks secret in `text`. Returns the masked text and how many values were masked. */
export function redact(text, { env = {} } = {}) {
  let out = String(text ?? '')
  let count = 0
  for (const value of secretValuesOf(env)) {
    const re = new RegExp(escapeRe(value), 'g')
    out = out.replace(re, () => { count++; return REDACTED })
  }
  for (const [re, rep] of PATTERNS) {
    out = out.replace(re, (...m) => {
      count++
      // Expand $1/$2 by hand: the callback form is what lets us count.
      return rep.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '')
    })
  }
  return { text: out, count }
}

/** What the session was about — its first prompt typed by a person, not a hook's or the harness's text. And when
 *  it ran, from the first and last timestamps. Read from Claude Code's JSONL; a line that does not parse is
 *  skipped. */
export function describeTranscript(jsonl) {
  let title = null, startedAt = null, endedAt = null
  for (const line of String(jsonl ?? '').split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (typeof e?.timestamp === 'string') {
      startedAt ??= e.timestamp
      endedAt = e.timestamp
    }
    if (title || e?.type !== 'user' || e?.isMeta) continue
    const c = e?.message?.content
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join(' ') : ''
    const t = text.replace(/\s+/g, ' ').trim()
    // Harness and hook text arrives as user turns too; it starts with a tag or a command wrapper.
    if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) title = t.slice(0, 200)
  }
  return { title, startedAt, endedAt }
}
