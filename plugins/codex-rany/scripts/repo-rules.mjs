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

/** `instead` rules: a way of working that is closed AND the way that is open — `{ "match": ["ssh *", "scp *"],
 *  "use": "Deploy = the CI deploy job: …", "why": "…" }` (optionally `"paths"` too). A refusal that names only
 *  what is forbidden sends the agent looking for another road to the same place (owner, 2026-11-15: told only "no
 *  ssh", an agent went looking for another way in instead of running the build job); one that names the right road
 *  ends the search. */
function insteadList(v) {
  return (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [])
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      commands: asList(e.match ?? e.commands),
      paths: asList(e.paths),
      use: typeof e.use === 'string' ? e.use.trim().slice(0, 600) : '',
      why: typeof e.why === 'string' ? e.why.trim().slice(0, 400) : '',
    }))
    .filter((e) => (e.commands.length || e.paths.length) && e.use)
}

const KNOWN_KEYS = new Set(['$schema', 'applyTo', 'deny', 'approval', 'instead', 'roles'])

/** What is wrong with the rules as written — shown at session start, so a typo is found before it lets a call
 *  through (an `re:` pattern that does not compile matches nothing; an unknown key is silently ignored). */
export function validateRules(rules) {
  if (!rules) return []
  const out = []
  if (rules.error) out.push(`.rany/rany.json could not be read: ${rules.error}`)
  const raw = readText(join(rules.root, RULES_DIR, 'rany.json'))
  let json = null
  try { json = raw ? JSON.parse(raw) : null } catch { /* reported above */ }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const k of Object.keys(json)) if (!KNOWN_KEYS.has(k)) out.push(`unknown key "${k}" in .rany/rany.json is ignored`)
    if (json.applyTo != null && !['all', 'seats'].includes(json.applyTo)) out.push(`applyTo must be "all" or "seats"`)
    for (const e of Array.isArray(json.instead) ? json.instead : json.instead ? [json.instead] : [])
      if (!e || typeof e !== 'object' || !(asList(e.match ?? e.commands).length || asList(e.paths).length) || typeof e.use !== 'string' || !e.use.trim())
        out.push(`an "instead" entry needs "match" (or "paths") and "use": ${JSON.stringify(e).slice(0, 120)}`)
  }
  const { deny, approval, instead } = rules.policy
  for (const p of [...deny.commands, ...approval.commands, ...instead.flatMap((e) => e.commands)]) {
    if (!/^re:/i.test(p)) continue
    try { new RegExp(p.slice(3), 'i') } catch (e) { out.push(`pattern ${p} does not compile (${String(e?.message ?? e).slice(0, 80)}) — it matches nothing`) }
  }
  return out
}

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
    // Every session the plugin runs in, seated or not (owner, 2026-11-15: a plain `claude` in the repo must keep to
    // them too). `"seats"` keeps the old scope: only sessions that hold a work-room seat.
    applyTo: json.applyTo === 'seats' ? 'seats' : 'all',
    instead: [...insteadList(json.instead), ...insteadList(role?.instead)],
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
  const { deny, approval, instead } = rules.policy
  const summary = [
    deny.paths.length ? `never write: ${deny.paths.join(', ')}` : null,
    deny.commands.length ? `never run: ${deny.commands.join(', ')}` : null,
    ...instead.map((e) => `never ${[...e.commands, ...e.paths].join(' / ')} — instead: ${e.use}`),
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
    `${enforced === 'partial' ? 'The never/instead rules are enforced — such a call is refused and says why; keep to the ask-first ones yourself'
      : enforced ? 'Enforced — a call that breaks these is refused and says why' : 'Not enforced by this runtime — keep to them yourself'}: ${summary.join('; ')}.`,
  ]
}

/** The SESSION-START check (owner, 2026-11-15: "rany plugin calisiyorsa bir pre check ile bunlara bakip"): every
 *  session in a checkout with `.rany/` — seated or not — starts knowing the rules, and a mistake in them is said
 *  out loud before it lets a call through. Empty when the checkout has no `.rany/`. */
export function sessionBrief(rules, { enforced = false, guardInstalled = true } = {}) {
  if (!rules) return []
  const problems = validateRules(rules)
  if (!guardInstalled) problems.push('the pre-tool guard hook is not active in this runtime, so nothing is enforced')
  return [
    ...repoRulesLines(rules, { full: true, enforced: guardInstalled ? enforced : false }),
    ...(problems.length ? ['RULES CHECK found problems — tell the owner (in ONE room line if you hold a seat, else here):',
      ...problems.map((p) => `  - ${p}`)] : []),
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
  const { deny, approval, instead } = rules.policy
  const { name, files, command } = toolCallShape(call)
  const cwd = typeof call?.cwd === 'string' && call.cwd ? call.cwd : rules.root
  const approved = approvedAt > 0 && now - approvedAt < approval.windowMinutes * 60_000
  const insteadFor = (pick) => instead.find(pick)
  const insteadHit = (e, rule, what) => ({ kind: 'deny', rule, what, use: e.use, why: e.why })

  const hits = []
  for (const f of files) {
    const rel = repoRelative(rules.root, f, cwd)
    const what = `${name} ${rel ?? f}`
    const d = matchPath(deny.paths, rel)
    if (d) return { kind: 'deny', rule: d, what }
    const e = insteadFor((x) => matchPath(x.paths, rel))
    if (e) return insteadHit(e, matchPath(e.paths, rel), what)
    const a = matchPath(approval.paths, rel)
    if (a) hits.push({ kind: 'approval', rule: a, what })
  }
  if (command != null) {
    const cmd = command
    const what = cmd.slice(0, 200)
    const dc = deny.commands.find((p) => commandMatches(p, cmd))
    if (dc) return { kind: 'deny', rule: dc, what }
    const e = insteadFor((x) => x.commands.some((p) => commandMatches(p, cmd)))
    if (e) return insteadHit(e, e.commands.find((p) => commandMatches(p, cmd)), what)
    for (const t of writtenPaths(cmd)) {
      const rel = repoRelative(rules.root, t, cwd)
      const d = matchPath(deny.paths, rel)
      if (d) return { kind: 'deny', rule: d, what }
      const ep = insteadFor((x) => matchPath(x.paths, rel))
      if (ep) return insteadHit(ep, matchPath(ep.paths, rel), what)
      const a = matchPath(approval.paths, rel)
      if (a) hits.push({ kind: 'approval', rule: a, what })
    }
    const ac = approval.commands.find((p) => commandMatches(p, cmd))
    if (ac) hits.push({ kind: 'approval', rule: ac, what })
  }
  return hits.length && !approved ? hits[0] : null
}

/** One tool call in the terms the rules speak: the files it writes and the shell line it runs. Claude Code's
 *  tools (Edit/Write/MultiEdit/NotebookEdit, Bash/PowerShell), Codex's (`Bash`, `apply_patch` — the files are in
 *  the patch's `*** Update File:` lines) and Gemini CLI's (`run_shell_command`, `write_file`, `replace`). */
export function toolCallShape(call) {
  const name = String(call?.tool_name ?? '')
  const input = call?.tool_input && typeof call.tool_input === 'object' ? call.tool_input : {}
  const str = (v) => (typeof v === 'string' ? v : null)
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'write_file', 'replace'].includes(name))
    return { name, files: [str(input.file_path) ?? str(input.notebook_path) ?? str(input.absolute_path)].filter(Boolean), command: null }
  if (name === 'apply_patch') {
    const patch = str(input.command) ?? str(input.patch) ?? str(input.input) ?? (Array.isArray(input.command) ? input.command.join('\n') : '')
    const files = [...String(patch).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$|^\*\*\* Move to: (.+?)\s*$/gm)]
      .map((m) => m[1] ?? m[2]).filter(Boolean)
    return { name, files, command: null }
  }
  if (['Bash', 'PowerShell', 'run_shell_command', 'shell', 'exec_command'].includes(name)) {
    const c = input.command ?? input.cmd
    // An argv (`["bash", "-lc", "git push --force"]`) is judged by the script the shell runs, not by "bash".
    const argv = Array.isArray(c) ? c.map(String) : null
    const script = argv && argv.length >= 3 && /^(?:.*[\\/])?(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?$/i.test(argv[0])
      && /^-(?:l?c|Command)$/i.test(argv[argv.length - 2]) ? argv[argv.length - 1] : null
    return { name, files: [], command: script ?? (argv ? argv.join(' ') : String(c ?? '')) }
  }
  return { name, files: [], command: null }
}

/** The refusal text for a broken rule, written for the agent that made the call. */
export function refusalReason(rules, hit, seat) {
  const where = `.rany/ in ${rules.root}`
  if (hit.kind === 'deny' && hit.use) {
    return `Blocked by the repository's rules (${where}): not "${hit.rule}" here — "${hit.what}". `
      + `INSTEAD: ${hit.use}${hit.why ? ` (why: ${hit.why})` : ''}. Do that; do not look for another way to do what `
      + `was blocked.`
  }
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
