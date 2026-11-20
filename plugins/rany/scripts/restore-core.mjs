/**
 * `rany-restore` — the pure half: which seats to offer after a reboot, how to read a pick, and what to run
 * for each. No I/O here, so the rules can be tested without a terminal, a server or a reboot.
 *
 * Why it exists (owner, 2026-11-20): "terminalde actigim sessionlari bir koltuga oturturuyorum, pc'yi
 * restart ettigimde, tekrar bunlari bulmak cok ciddi mesele oluyor, ve o agentin know-how'i gidiyor."
 * Nothing was actually lost — ~/.rany-plugin/seat-history.json remembers every seat this machine held, with
 * its directory, its runtime and its last local conversations, and those conversations are still on disk.
 * What was missing is one list across every repository and one move that reopens them: the owner was
 * keeping `claude --resume <id>` / `codex resume <id>` in .bat files by hand.
 */

/** Runtimes `rany-restore` can reopen by itself. Others are listed with what to do by hand. */
export const LAUNCHABLE = ['claude', 'codex']

/** A conversation a live window is still writing must not be opened twice — the same rule the plugin's
 *  resume hint follows (`seen` is stamped every turn, `closedAt` at SessionEnd). */
export const OPEN_WINDOW_MS = 10 * 60_000

/**
 * Every remembered seat on this machine, newest first within its room, rooms by their latest seat.
 *
 * @param {Record<string, Record<string, any>>} repos — seat-history.json's `repos`.
 * @param {Map<string, {state: string, roomName?: string|null}>|null} live — seats the server still has
 *   (from list_my_rooms), or null when the server could not be asked: then nothing is filtered, and each
 *   row says it was not checked.
 * @param {number} now — ms epoch.
 */
export function restoreCandidates(repos, live, now = Date.now()) {
  const rows = []
  const seen = new Set()
  for (const seats of Object.values(repos ?? {})) {
    for (const [agentId, h] of Object.entries(seats ?? {})) {
      if (!h || seen.has(agentId)) continue
      const server = live ? live.get(agentId) : undefined
      // Gone on the server (removed by the owner, room closed): nothing to come back to.
      if (live && (!server || server.state === 'removed')) continue
      seen.add(agentId)
      const sessions = Array.isArray(h.sessions) ? h.sessions.filter((s) => s?.id) : []
      const last = sessions[0] ?? null
      const openNow = !!(last && !last.closedAt && last.seen && now - Date.parse(last.seen) < OPEN_WINDOW_MS)
      rows.push({
        agentId,
        name: h.name ?? agentId,
        roomName: server?.roomName ?? h.roomName ?? null,
        channelId: h.channelId ?? null,
        agent: h.agent ?? 'claude',
        dir: h.dir ?? null,
        session: last ? { id: String(last.id), ts: last.ts ?? null } : null,
        lastJoined: h.lastJoined ?? null,
        state: server?.state ?? null,
        checked: !!live,
        openNow,
      })
    }
  }
  const roomLatest = new Map()
  for (const r of rows) {
    const k = r.channelId ?? r.agentId
    const t = String(r.session?.ts ?? r.lastJoined ?? '')
    if (!roomLatest.has(k) || t > roomLatest.get(k)) roomLatest.set(k, t)
  }
  const when = (r) => String(r.session?.ts ?? r.lastJoined ?? '')
  return rows.sort((a, b) => {
    const ka = a.channelId ?? a.agentId, kb = b.channelId ?? b.agentId
    if (ka !== kb) return roomLatest.get(kb).localeCompare(roomLatest.get(ka)) || ka.localeCompare(kb)
    return when(b).localeCompare(when(a))
  })
}

/**
 * The owner's answer → 0-based indexes, in the order given, without duplicates. Numbers separated by
 * spaces or commas, ranges ("2-4"), or all of them ("all", "hepsi", "a", "*"). Anything out of range or
 * unreadable is reported rather than guessed at.
 */
export function parsePick(input, count) {
  const text = String(input ?? '').trim().toLowerCase()
  if (!text) return { picks: [], bad: [] }
  if (['all', 'hepsi', 'a', '*', 'tümü', 'tumu'].includes(text))
    return { picks: Array.from({ length: count }, (_, i) => i), bad: [] }
  const picks = []
  const bad = []
  for (const tok of text.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(tok)
    if (!m) { bad.push(tok); continue }
    const from = Number(m[1]), to = m[2] ? Number(m[2]) : from
    if (from < 1 || to > count || to < from) { bad.push(tok); continue }
    for (let n = from; n <= to; n++) if (!picks.includes(n - 1)) picks.push(n - 1)
  }
  return { picks, bad }
}

/** What reopens one seat: its directory, a tab title, the seat to take, and the command. Null when the
 *  runtime is not one this can start, or the directory is unknown. */
export function launchPlan(row) {
  if (!row?.dir || !LAUNCHABLE.includes(row.agent)) return null
  const id = row.session?.id
  const argv = row.agent === 'codex'
    ? (id ? ['codex', 'resume', id] : ['codex'])
    : (id ? ['claude', '--resume', id] : ['claude'])
  return { cwd: row.dir, title: row.name, rejoin: row.agentId, argv }
}

/** The same plan as one line someone can paste (PowerShell or POSIX sh), for a platform with no terminal
 *  this can open, or to keep. */
export function planCommandLine(plan, shell) {
  const q = (s) => (shell === 'powershell' ? `'${String(s).replace(/'/g, "''")}'` : `'${String(s).replace(/'/g, `'\\''`)}'`)
  return shell === 'powershell'
    ? `Set-Location ${q(plan.cwd)}; $env:RANY_REJOIN=${q(plan.rejoin)}; ${plan.argv.join(' ')}`
    : `cd ${q(plan.cwd)} && RANY_REJOIN=${q(plan.rejoin)} ${plan.argv.join(' ')}`
}

/**
 * Windows: a small .cmd per seat does the work, because wt has no per-tab environment and quoting a
 * `set … && claude …` line through Node, wt and cmd in turn is three escaping rules deep. `call` because
 * `claude` / `codex` are themselves .cmd files (npm shims, the rany-term shims), and a batch file that
 * runs another without `call` never comes back.
 */
export function launchScript(plan) {
  return ['@echo off', `title ${plan.title.replace(/[&|<>^%"]/g, '')}`, `set "RANY_REJOIN=${plan.rejoin}"`,
    `cd /d "${plan.cwd}"`, `call ${plan.argv.join(' ')}`, ''].join('\r\n')
}

/** Windows Terminal arguments for one tab — one `wt` call per tab, since `;` is wt's own command separator.
 *  `-w rany` gathers every restored seat in one window. */
export function wtArgs(plan, scriptPath) {
  return ['-w', 'rany', 'new-tab', '--title', plan.title, '-d', plan.cwd, 'cmd', '/k', scriptPath]
}

/** `cmd /c start` fallback when Windows Terminal is not installed: one console window per seat. */
export function startArgs(plan, scriptPath) {
  return ['/c', 'start', '""', '/D', plan.cwd, 'cmd', '/k', scriptPath]
}

/** "31 Eki 14:05"-style local stamp for the list; '—' when unknown. */
export function shortWhen(iso, locale = 'tr-TR') {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
