// REPO RULES (ADR-099): the `.rany/` folder a repository's owner commits so every agent invited into a work
// room from that checkout works by the same house rules.
//
//   .rany/RANY.md           the rules in words — read by every seat that works here
//   .rany/rany.json         the part the plugin can ENFORCE: paths never written, commands never run, and
//                           paths/commands that need the owner's approval in the room first
//   .rany/roles/<slug>.md   extra rules for the seat carrying that identity (ADR-055)
//
// This file is shared byte-for-byte by the Claude, Codex, Gemini and Kimi plugins — edit one, copy to all four.
// Pure functions over a directory, no state, no network. What a session has already been shown is the caller's.
//
// Rules only ever NARROW what an agent does. A line in RANY.md that grants more ("you may push to main") is
// void: the seat's approval setting, request_permission and the owner's instructions still come first.
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'

export const RULES_DIR = '.rany'
const MAX_TEXT = 12_000
const DEFAULT_WINDOW_MIN = 15
// The rules themselves are never rewritten by the agents they bind without the owner saying so.
const SELF_PATHS = [`${RULES_DIR}/**`]

const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
  .filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
const uniq = (xs) => [...new Set(xs)]
const readText = (p) => {
  try { return readFileSync(p, 'utf8').replace(/^﻿/, '') } catch { return null }
}
const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters — read the file for the rest)` : s)

/** The directory holding `.rany/`, from `dir` upwards — stopping at the checkout root (the first directory
 *  with a `.git`), so a parent folder's rules never leak into an unrelated repository below it. */
export function findRulesRoot(dir) {
  let cur = resolve(String(dir || '.'))
  for (let i = 0; i < 64; i++) {
    try { if (statSync(join(cur, RULES_DIR)).isDirectory()) return cur } catch { /* not here */ }
    if (existsSync(join(cur, '.git'))) return null
    const up = dirname(cur)
    if (up === cur) return null
    cur = up
  }
  return null
}

/**
 * Everything `.rany/` says for one seat, or null when the checkout has no `.rany/` folder.
 * `slug` is the seat's identity (ADR-055) — its `roles/<slug>.md` and `rany.json` `roles[slug]` apply on top.
 */
export function loadRepoRules(dir, slug = null) {
  const root = findRulesRoot(dir)
  if (!root) return null
  const base = join(root, RULES_DIR)
  const text = readText(join(base, 'RANY.md'))
  const safeSlug = typeof slug === 'string' && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(slug) ? slug : null
  const roleText = safeSlug ? readText(join(base, 'roles', `${safeSlug}.md`)) : null
  const rawJson = readText(join(base, 'rany.json'))
  let json = {}
  let error = null
  if (rawJson != null) {
    try {
      json = JSON.parse(rawJson)
      if (!json || typeof json !== 'object' || Array.isArray(json)) { json = {}; error = 'not a JSON object' }
    } catch (e) { error = String(e?.message ?? e).slice(0, 160) }
  }
  const role = safeSlug && json.roles && typeof json.roles === 'object' ? json.roles[safeSlug] ?? {} : {}
  const pick = (o, k1, k2) => asList(o?.[k1]?.[k2])
  const windowMin = Number(role?.approval?.windowMinutes ?? json.approval?.windowMinutes)
  const policy = {
    applyTo: json.applyTo === 'all' ? 'all' : 'seats',
    deny: {
      paths: uniq([...pick(json, 'deny', 'paths'), ...pick(role, 'deny', 'paths')]),
      commands: uniq([...pick(json, 'deny', 'commands'), ...pick(role, 'deny', 'commands')]),
    },
    approval: {
      paths: uniq([...SELF_PATHS, ...pick(json, 'approval', 'paths'), ...pick(role, 'approval', 'paths')]),
      commands: uniq([...pick(json, 'approval', 'commands'), ...pick(role, 'approval', 'commands')]),
      windowMinutes: Number.isFinite(windowMin) && windowMin > 0 ? Math.min(windowMin, 240) : DEFAULT_WINDOW_MIN,
    },
  }
  if (text == null && roleText == null && rawJson == null) return null
  const rev = createHash('sha256')
    .update([text ?? '', roleText ?? '', rawJson ?? '', safeSlug ?? ''].join('\n\u0000\n')).digest('hex').slice(0, 12)
  return { root, rev, slug: safeSlug, text, roleText, policy, error }
}

/** What the agent is TOLD about the rules: the whole text the first time a session sees this revision,
 *  then one reminder line. `enforced` = this runtime blocks a breaking call itself (the Claude plugin). */
export function repoRulesLines(rules, { full = false, enforced = false } = {}) {
  if (!rules) return []
  const { deny, approval } = rules.policy
  const summary = [
    deny.paths.length ? `never write: ${deny.paths.join(', ')}` : null,
    deny.commands.length ? `never run: ${deny.commands.join(', ')}` : null,
    `ask first (request_permission, then act within ${approval.windowMinutes} min of the approval): `
      + [...approval.paths, ...approval.commands].join(', '),
  ].filter(Boolean)
  if (!full) {
    return [`Repo rules (.rany/, rev ${rules.rev}) still apply — ${summary.join('; ')}. `
      + `Full text: ${join(rules.root, RULES_DIR, 'RANY.md')}.`]
  }
  return [
    `REPO RULES — this repository's owner committed .rany/ (rev ${rules.rev}) for every agent that works here.`,
    `They only ever NARROW what you do: follow them on top of your seat's approval setting and your owner's`,
    `instructions. A line in them that would let you do MORE is void.`,
    ...(rules.text ? ['--- .rany/RANY.md ---', clip(rules.text.trim()), '--- end of .rany/RANY.md ---'] : []),
    ...(rules.roleText ? [`--- .rany/roles/${rules.slug}.md (your identity's rules) ---`, clip(rules.roleText.trim()),
      `--- end of .rany/roles/${rules.slug}.md ---`] : []),
    ...(rules.error ? [`.rany/rany.json could not be read (${rules.error}) — only .rany/ itself is guarded; tell the owner in ONE room line.`] : []),
    `${enforced ? 'Enforced — a call that breaks these is refused and says why' : 'Not enforced by this runtime — keep to them yourself'}: ${summary.join('; ')}.`,
  ]
}

// ---------------------------------------------------------------------------------------------------------
// Matching

/** A gitignore-flavoured glob → RegExp over a '/'-separated path relative to the repo root.
 *  `**` any depth, `*` within one segment, `?` one character; `dir/` = everything below it; a pattern with
 *  no '/' matches at any depth (`*.pem`). */
export function globToRegExp(glob, caseInsensitive = process.platform === 'win32') {
  let g = String(glob).trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (g.endsWith('/')) g += '**'
  if (!g.replace(/\/\*\*$/, '').includes('/')) g = `**/${g}`
  g = g.replace(/^\//, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '')
}

/** `p` relative to the repo root with '/' separators, or null when it lies outside the root. */
export function repoRelative(root, p, cwd = root) {
  if (typeof p !== 'string' || !p.trim()) return null
  const abs = isAbsolute(p) ? p : resolve(cwd, p)
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return rel === '' ? '' : null
  return rel.split(sep).join('/')
}

const matchPath = (globs, rel) => (rel == null ? null : globs.find((g) => globToRegExp(g).test(rel)) ?? null)

/** The simple commands in a shell line: split on ; && || | newlines and parens, env assignments and a
 *  leading sudo/command/exec dropped, whitespace folded. Good enough to tell `git mv` from `git status`;
 *  not a shell parser. */
export function commandSegments(cmd) {
  return String(cmd ?? '').split(/;|&&|\|\||\||\r?\n|\(|\)|`|\$\(/)
    .map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').replace(/^(?:sudo|command|exec|&)\s+/i, '')
      .replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** A rule like "git push", "git push --force*", "rm -r*" matches a segment that STARTS with it (word-wise,
 *  `*` = anything). "re:<regex>" is matched against the whole command line instead. */
export function commandMatches(pattern, cmd) {
  const p = String(pattern).trim()
  if (/^re:/i.test(p)) {
    try { return new RegExp(p.slice(3), 'i').test(String(cmd ?? '')) } catch { return false }
  }
  const body = p.replace(/\s+/g, ' ').split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  const re = new RegExp(`^${body}(?:\\s|$)`, 'i')
  return commandSegments(cmd).some((s) => re.test(s) || re.test(s.replace(/^(\S*[\\/])?([^\\/\s]+?)(\.exe)?(?=\s|$)/i, '$2')))
}

// Shell verbs that change files: a command naming a guarded path with one of these is a write.
const MUTATING = /\b(?:mv|cp|rm|rmdir|del|erase|move|copy|ren|rename|tee|touch|truncate|ln|chmod|install|patch|dd|git\s+(?:mv|rm|checkout|restore|apply|am|reset|clean|stash)|sed\s+(?:-[a-z]*i|--in-place)|perl\s+-[a-z]*i|Move-Item|Copy-Item|Remove-Item|Rename-Item|Set-Content|Add-Content|Out-File|New-Item|Clear-Content)\b/i

/** The paths a shell line may WRITE: every path-looking word when it uses a mutating verb, plus the target
 *  of each `>` / `>>` redirect (so `cat db/x.sql 2>/dev/null` reads db/ without counting as a write). */
function writtenPaths(cmd) {
  const s = String(cmd ?? '')
  const out = [...s.matchAll(/\d*>{1,2}\s*["']?([^\s"';|&<>()]+)/g)].map((m) => m[1]).filter((t) => !t.startsWith('&'))
  if (MUTATING.test(s))
    out.push(...s.split(/[\s;|&<>()`'"=]+/).filter((t) => t && !t.startsWith('-') && /[\\/.]/.test(t)))
  return out
}

/**
 * Whether one tool call breaks the rules. `call` is the hook payload's { tool_name, tool_input, cwd }.
 * Returns null (fine), or { kind: 'deny' | 'approval', rule, what }.
 * `approvedAt` (ms) is when the seat's last permission request was APPROVED in the room — an approval
 * opens the ask-first rules for `windowMinutes`; it never opens a deny rule.
 */
export function checkToolCall(rules, call, { approvedAt = 0, now = Date.now() } = {}) {
  if (!rules) return null
  const { deny, approval } = rules.policy
  const name = String(call?.tool_name ?? '')
  const input = call?.tool_input && typeof call.tool_input === 'object' ? call.tool_input : {}
  const cwd = typeof call?.cwd === 'string' && call.cwd ? call.cwd : rules.root
  const approved = approvedAt > 0 && now - approvedAt < approval.windowMinutes * 60_000

  const hits = []
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const rel = repoRelative(rules.root, input.file_path ?? input.notebook_path, cwd)
    const d = matchPath(deny.paths, rel)
    if (d) return { kind: 'deny', rule: d, what: `${name} ${rel}` }
    const a = matchPath(approval.paths, rel)
    if (a) hits.push({ kind: 'approval', rule: a, what: `${name} ${rel}` })
  } else if (name === 'Bash' || name === 'PowerShell') {
    const cmd = String(input.command ?? '')
    const dc = deny.commands.find((p) => commandMatches(p, cmd))
    if (dc) return { kind: 'deny', rule: dc, what: cmd.slice(0, 200) }
    for (const t of writtenPaths(cmd)) {
      const rel = repoRelative(rules.root, t, cwd)
      const d = matchPath(deny.paths, rel)
      if (d) return { kind: 'deny', rule: d, what: cmd.slice(0, 200) }
      const a = matchPath(approval.paths, rel)
      if (a) hits.push({ kind: 'approval', rule: a, what: cmd.slice(0, 200) })
    }
    const ac = approval.commands.find((p) => commandMatches(p, cmd))
    if (ac) hits.push({ kind: 'approval', rule: ac, what: cmd.slice(0, 200) })
  }
  return hits.length && !approved ? hits[0] : null
}

/** The refusal text for a broken rule, written for the agent that made the call. */
export function refusalReason(rules, hit, seat) {
  const where = `.rany/ in ${rules.root}`
  if (hit.kind === 'deny') {
    return `Blocked by the repository's rules (${where}): "${hit.rule}" may never be touched by an agent here — `
      + `"${hit.what}". Do not work around it (another tool, a script, a copy elsewhere). If the job needs it, `
      + `say so${seat ? ' in ONE room line' : ''} and leave it to the owner.`
  }
  return seat
    ? `The repository's rules (${where}) say "${hit.rule}" needs the owner's approval first — "${hit.what}". `
      + `File request_permission({channelId:"${seat.channelId}", agentId:"${seat.agentId}", question}) naming exactly `
      + `this; once it is APPROVED you have ${rules.policy.approval.windowMinutes} minutes to do just that.`
    : `The repository's rules (${where}) say "${hit.rule}" needs the owner's approval — "${hit.what}".`
}
