/**
 * Scrub secrets from any text BEFORE it leaves the terminal for the room (owner, 2026-11-26, critical: "hiçbir
 * şifre, hiçbir sensitive data çıkmamalı terminalden" — database/NuGet/whatever passwords were going out in the
 * clear on 'action required' cards and the activity/Screen feed). A hard policy: every room-post boundary runs a
 * string through `redactSecrets` first — the permission card, the activity lines, the commit crumb and the Screen
 * mirror. It MASKS values and leaves the surrounding text, so a card still reads `PGPASSWORD=‹redacted› psql …`
 * and stays approvable; the local command that actually RUNS is untouched (matching/approval use the real text) —
 * only what is SHOWN is scrubbed.
 *
 * Pure, no state, no network. Conservative on purpose: it masks the VALUE after a sensitive key or flag (incl.
 * JSON/quoted and dashed-prefix flags), credentials in URLs / auth headers / `user:pass` basic-auth, and a set of
 * unmistakable token shapes. It does NOT assume an arbitrary long string is a secret (that would mangle shas, ids
 * and ordinary prose), and it deliberately leaves ambiguous short flags (`-k`, `-p`) alone EXCEPT in the tools
 * where they are unmistakable (`nuget -k`, `sshpass -p`), because masking them globally would break `ssh -p 22`
 * and `git log -p`. So this RAISES THE FLOOR — a secret in a shape nobody here recognises can still slip through;
 * keep adding shapes as they turn up, and prefer never putting a secret on a command line (use an env var).
 *
 * Shared by listen.mjs, room-permission.mjs and the Screen feeder (screen-feed.mjs), which copies this file
 * alongside itself — keep it dependency-free.
 */

export const REDACTED = '‹redacted›'

// Sensitive key / flag stems. Substring match inside a larger name (DB_PASSWORD, client_secret, SharedAccessKey,
// MyApiKey) is intentional; what gets masked is the VALUE after the `:`/`=`, or the flag's argument.
const SENS = '(?:pass(?:word|phrase|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|client[_-]?secret|auth[_-]?token|private[_-]?key|credentials?|conn(?:ection)?[_-]?string)'
// A value: a single/double-quoted run, or an unquoted run up to whitespace or a shell / connection-string
// delimiter (; & | , so `Password=x;Host=y` masks only `x`).
const VAL = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s;&|,'"]+)`

// Unmistakable token SHAPES — masked wherever they appear, no key needed. A truncated PEM (the Screen clips
// output) still masks from BEGIN to end-of-text via the `|$` branch, so a half-shown private key never leaks.
const SHAPES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\brany_persona_[A-Za-z0-9._-]+/g,                 // RANY's own persona token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,                 // GitHub fine-grained PAT
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                 // GitHub classic tokens
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,                // Slack tokens
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, // Slack incoming webhook
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,                     // Google API key
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,     // Stripe secret / restricted key
  /\bwhsec_[A-Za-z0-9]{10,}/g,                       // Stripe webhook signing secret
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,               // OpenAI / Anthropic keys
  /\bnpm_[A-Za-z0-9]{36}\b/g,                        // npm automation token
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,   // SendGrid key
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g,                   // AWS access key id (long-term / temp)
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT
]

// Boundary rules, applied in order. Each masks the VALUE and keeps the label so the card/line still reads.
function rules() {
  return [
    // URL credentials: scheme://user:PASS@host  →  scheme://user:‹redacted›@host
    { re: /\b([a-z][a-z0-9+.-]*:\/\/[^:/?#\s@]+):([^@/?#\s]+)@/gi, to: (_m, pre) => `${pre}:${REDACTED}@` },
    // HTTP basic auth on the command line: curl -u user:PASS  /  --user user:PASS
    { re: /((?:--user|(?<![\w-])-u)[=\s]+)([^\s:'"]+):(\S+)/gi, to: (_m, pre, user) => `${pre}${user}:${REDACTED}` },
    // Authorization header: Authorization: Bearer|Basic|token XXXX
    { re: /\b(authorization\s*:\s*)(bearer|basic|token)\s+\S+/gi, to: (_m, p1, scheme) => `${p1}${scheme} ${REDACTED}` },
    // key=value / key: value for a sensitive key — env vars, connection strings, JSON/quoted ("password": "x")
    { re: new RegExp(`(["']?)([\\w.\\-]*${SENS}[\\w.\\-]*)\\1(\\s*[:=]\\s*)${VAL}`, 'gi'),
      to: (_m, q, key, sep) => `${q}${key}${q}${sep}${REDACTED}` },
    // --password X / --api-key=X / -Password X / --http-password X / -ApiKey X (sensitive stem anywhere in a flag)
    { re: new RegExp(`(--?[\\w-]*${SENS})([=\\s]+)${VAL}`, 'gi'), to: (_m, flag, sep) => `${flag}${sep}${REDACTED}` },
    // Tools whose short flag is unmistakably a secret (safe to mask where a global -k/-p would not be)
    { re: /\b(nuget\b[^\n]*?\s-k[=\s]+)(\S+)/gi, to: (_m, pre) => `${pre}${REDACTED}` },
    { re: /\b(sshpass\s+-p[=\s]*)(\S+)/gi, to: (_m, pre) => `${pre}${REDACTED}` },
    // nuget / cli positional: setapikey SECRET
    { re: /\b(set-?api-?key\s+)(\S+)/gi, to: (_m, p1) => `${p1}${REDACTED}` },
  ]
}

/**
 * Return `text` with recognised secrets masked. Non-strings pass through unchanged (so a null line from a renderer
 * stays null). Idempotent: running it twice changes nothing (the mask has no secret shape).
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return text
  let s = text
  for (const re of SHAPES) s = s.replace(re, REDACTED)
  for (const { re, to } of rules()) s = s.replace(re, to)
  return s
}
