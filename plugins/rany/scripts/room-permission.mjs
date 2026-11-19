/**
 * The TERMINAL's permission prompt, moved into the work room (ADR-099 follow-up).
 *
 * A seated session's owner is reading the room, not the terminal. Until now a call the runtime would not
 * run unattended stopped in the terminal and nowhere else: the room showed an agent going quiet, and the
 * owner had to walk to that machine to answer a question they never saw ("bu terminal promptları neden
 * ranye taşınmıyor? Aşırı vakit kaybı", 2026-10-19 — a seat had been waiting at such a prompt since the
 * day before). The guard now files the approval card in the room, waits for the answer, and tells the
 * runtime what the owner decided, so the only place a decision is ever asked for is the room.
 *
 * Pure on purpose: what counts as risky, what the card says and how an answer maps onto the runtime's
 * permission decision live here with their tests; the posting, polling and waiting live in listen.mjs.
 */
import { createHash } from 'node:crypto'
import { commandMatches, commandSegments } from './repo-rules.mjs'

/**
 * Calls a runtime does not run unattended, with the words for WHY each one is being asked. This is the
 * floor, not the whole list: a checkout's own `.rany/rany.json` adds to it, and its `deny` entries are
 * refused outright and never reach a card.
 *
 * Narrow by intent: a call that cannot be taken back. Editing files, building, running tests, committing,
 * pushing, moving a file and reading anything are the job — asking for them would teach the owner to
 * approve without reading, which is worse than not asking at all. Where an owner does want one of those
 * decided, `.rany/rany.json` says so for that checkout and this guard asks for it the same way.
 */
export const RISKY = [
  { rule: 'git reset', why: 'moves this branch and can drop commits' },
  { rule: 'git checkout --', why: 'throws away uncommitted work in those files' },
  { rule: 'git restore', why: 'throws away uncommitted work in those files' },
  { rule: 'git clean', why: 'deletes files git is not tracking' },
  { rule: 'git stash drop', why: 'deletes a stash for good' },
  { rule: 'git stash clear', why: 'deletes every stash for good' },
  { rule: 'git rebase', why: 'rewrites commits that may already be shared' },
  { rule: 'git filter-branch', why: 'rewrites the whole history' },
  { rule: 'rm -r*', why: 'deletes a directory tree' },
  { rule: 'rm -f*', why: 'deletes files without asking' },
  { rule: 'rmdir', why: 'deletes a directory' },
  { rule: 're:Remove-Item\\b[^|;]*-(?:Recurse|Force)\\b', why: 'deletes files or a tree without asking' },
  { rule: 're:\\bdel\\s+/[sq]\\b', why: 'deletes files without asking' },
  { rule: 'dotnet run --project tools/Rany.DbMigrator*', why: 'applies migrations to the target database' },
  { rule: 're:\\bdrop\\s+(?:table|schema|database)\\b', why: 'drops a database object' },
  { rule: 're:\\btruncate\\s+table\\b', why: 'empties a table' },
  { rule: 'npm publish', why: 'publishes a package the public installs' },
]

/** The one shell segment that tripped a rule, so the card quotes what will run and not a 400-character line. */
function segmentFor(rule, cmd) {
  const seg = commandSegments(cmd).find((s) => commandMatches(rule, s))
  return (seg ?? String(cmd ?? '')).slice(0, 200)
}

/**
 * Whether this call is one the room should decide. `call` is the hook payload's { tool_name, tool_input }.
 * Returns null, or { rule, why, what } — `what` is the segment that will run.
 * Only shell calls: a file edit is ordinary work, and `.rany/` guards the paths that are not.
 */
export function riskyCall(call) {
  const name = String(call?.tool_name ?? '')
  if (name !== 'Bash' && name !== 'PowerShell') return null
  const cmd = String(call?.tool_input?.command ?? '')
  if (!cmd.trim()) return null
  const hit = RISKY.find((r) => commandMatches(r.rule, cmd))
  return hit ? { rule: hit.rule, why: hit.why, what: segmentFor(hit.rule, cmd) } : null
}

/**
 * What the card in the room says. The owner is deciding about a command they cannot see the terminal of,
 * so it names the command, the folder it runs in and why it needs an answer — nothing else. One approval
 * is one command: the text is what the approval is FOR, and a vague card cannot be audited later.
 */
export function permissionCard({ what, cwd, why, source = 'runtime' }) {
  const where = cwd ? ` in \`${cwd}\`` : ''
  const because = source === 'rules'
    ? `the repository's rules say it needs your approval (${why})`
    : `it ${why}`
  return `Run \`${what}\`${where}? Asking because ${because}. `
    + 'Approve and it runs now; deny and it does not run at all.'
}

/** A decided card → the runtime's permission decision, or null while it is still pending.
 *  An approval is for THIS command only, which is why the reason quotes it back. */
export function decisionOf(request, { what, channelId = null } = {}) {
  const state = String(request?.state ?? '')
  const note = String(request?.decisionNote ?? request?.note ?? '').trim()
  if (state === 'approved') {
    return {
      permissionDecision: 'allow',
      permissionDecisionReason: `Your owner approved this in the work room${note ? ` — "${note}"` : ''}. `
        + `The approval is for exactly \`${what}\`; anything else needs its own card.`,
    }
  }
  if (state === 'denied') {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: `Your owner DENIED this in the work room${note ? ` — "${note}"` : ''}. `
        + 'Do not run it, do not work around it (another tool, a script, a copy elsewhere); say in ONE room '
        + 'line what you will do instead.',
    }
  }
  if (state === 'expired') {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: 'The approval card for this expired unanswered in the work room, so nobody '
        + 'decided it. Ask again when it is still needed — and say in ONE room line what is waiting on it.',
    }
  }
  return null
}

/** What to tell the runtime when the card is filed but no answer came while we could wait. NOT "ask": a
 *  terminal prompt is something the room's Approve can never reach — the owner approved the card and the
 *  terminal sat there anyway (owner, 2026-11-09: "izin veriyoruz ama terminal geçmiyor"). So the call is
 *  held back, the card stays open, and the owner's answer WAKES the session (PERSONA_ROOM_DECISION); the
 *  retry of the same command then reads that same card and runs — or not — by what it says. */
export function stillWaiting({ what, channelId, requestId, waitedMs }) {
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: `NOT RUN YET — an approval card for \`${what}\` is open in the work room `
      + `(request ${requestId}, channel ${channelId}) and nobody answered it in ${Math.round(waitedMs / 1000)}s. `
      + 'Say in ONE room line that you are waiting on it, then end your turn: the answer wakes you, and running '
      + 'the exact same command again then follows it. Do not file a second card for the same command and do '
      + 'not work around it.',
  }
}

/** The key one decision is remembered under: this seat, this exact command. A retry of the same command
 *  inside the window must not re-ask — an agent retrying a denied call would otherwise spam the room —
 *  and an approval of one command must never open another. */
export function callKey(agentId, what) {
  return `${agentId}:${createHash('sha256').update(String(what)).digest('hex').slice(0, 16)}`
}

// ---------------------------------------------------------------------------------------------------------
// "Approve & never ask again" (ADR-115)
//
// A risky call the owner keeps approving — deleting a build directory (bin/obj) gitignore already throws away —
// should be something a developer can switch off for good, on their OWN machine, without the agent editing their
// Claude Code settings or a committed `.rany/` rule. The card offers a per-TARGET "never ask again for `bin`"
// action; the token it remembers is the delete target's basename, kept in a user-level allow-store the plugin
// consults BEFORE it files a card. Only the delete family carries a token — "git reset" or "npm publish" have no
// safe "forever yes". Token derivation lives here (next to the repo-rules path logic) so the web, which only
// needs it to LABEL the button, re-derives nothing it must keep in step; the plugin is the authority and
// validates any remembered token against the real command before storing it.

/** The RISKY rules whose approval may be remembered: each deletes a NAMED target, so "never ask again for that
 *  name" is meaningful and bounded. `rmdir`/`del` included; `git clean` is NOT (it names no target). */
const DELETE_RULES = new Set([
  'rm -r*', 'rm -f*', 'rmdir',
  're:Remove-Item\\b[^|;]*-(?:Recurse|Force)\\b',
  're:\\bdel\\s+/[sq]\\b',
])

/** Split a shell segment into words, honouring single/double quotes (so `"Program Files"` stays one word). */
function shellWords(s) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(String(s ?? '')))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** The last path component of a path, with any trailing slashes and quotes dropped: `./src/Foo/bin/` → `bin`,
 *  `C:\tmp\obj` → `obj`. Returns '' for a path that is only slashes. */
function baseName(p) {
  const s = String(p ?? '').replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '')
  const parts = s.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * The directory names a risky DELETE would remove, as basenames (so `src/Foo/bin` and `./bin` both → `bin`),
 * deduped and lower-cased. Empty for a non-delete risky rule, or when the targets are not plain names (a glob,
 * `.`/`..`, a bare drive) — those are never offered a "never ask again", because the scope would be unclear.
 * `risky` is a {rule, what} from {@link riskyCall}; `what` is the single segment that will run.
 */
export function forgetTokens(risky) {
  if (!risky || !DELETE_RULES.has(risky.rule)) return []
  const seg = String(risky.what ?? '')
  const words = shellWords(seg)
  const isDel = /\bdel\b/i.test(risky.rule) || /^del$/i.test(words[0] ?? '')
  const targets = []
  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    if (/^-/.test(w)) {
      // PowerShell -Path / -LiteralPath take the NEXT word as their value; other switches take none.
      if (/^-(?:LiteralPath|Path)$/i.test(w) && words[i + 1] && !/^[-/]/.test(words[i + 1])) targets.push(words[++i])
      continue
    }
    if (isDel && /^\/[a-z]$/i.test(w)) continue // a `del /s /q` switch, not a path
    targets.push(w)
  }
  const toks = targets
    .map((t) => baseName(t).toLowerCase())
    .filter((t) => t && t !== '.' && t !== '..' && !/[*?]/.test(t) && !/^[a-z]:$/i.test(t))
  return [...new Set(toks)]
}

/** Whether EVERY target of this call is already forgiven — then no card is filed. An empty `tokens` is never
 *  forgiven (a call with no clear target still asks). Case-insensitive (Windows paths are). */
export function isForgiven(forgiven, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return false
  const set = new Set((Array.isArray(forgiven) ? forgiven : []).map((s) => String(s).toLowerCase()))
  return tokens.every((t) => set.has(String(t).toLowerCase()))
}

/** The allow-store with `tokens` added, deduped and lower-cased — what gets written back to approvals.json. */
export function mergeForgiven(forgiven, tokens) {
  const set = new Set((Array.isArray(forgiven) ? forgiven : []).map((s) => String(s).toLowerCase()).filter(Boolean))
  for (const t of Array.isArray(tokens) ? tokens : []) { const v = String(t ?? '').toLowerCase(); if (v) set.add(v) }
  return [...set]
}

/** The stable marker the card's "never ask again" button puts in the decision note, so the plugin (any
 *  language) recognises the intent. The web composes the same string and renders it back as friendly text. */
export const FORGET_MARKER = 'rany:forget:'
export function forgetNote(tokens) {
  const t = (Array.isArray(tokens) ? tokens : []).map((x) => String(x ?? '').toLowerCase()).filter(Boolean)
  return t.length ? FORGET_MARKER + [...new Set(t)].join(',') : ''
}

/** The tokens named in a decision note's forget-marker (empty when there is none). The caller still intersects
 *  these with the command's real {@link forgetTokens} before storing, so a stray note cannot forgive anything
 *  the approved command would not itself delete. */
export function parseForgetNote(note) {
  const s = String(note ?? '')
  const i = s.toLowerCase().indexOf(FORGET_MARKER)
  if (i < 0) return []
  return s.slice(i + FORGET_MARKER.length).split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)
}
