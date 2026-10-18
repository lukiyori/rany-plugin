/**
 * "Can RANY actually reach this session?" as text — the thing a person reads when everything else
 * has already failed, so it must never say more than it knows.
 *
 * A running process proved nothing: the daemon retries its gateway socket forever, and before 0.38.0
 * it did so silently, so a bridge that had never connected and an idle healthy one looked identical
 * from outside (2026-10-18: "bridge süreci çalışıyor … ancak bridge'in açık ağ bağlantısı görünmüyor
 * ve logda mesajın kuyruğa teslim edildiğine dair kayıt yok"). Every line here is read off disk, and
 * a fact that cannot be read is printed as UNKNOWN rather than guessed.
 *
 * Pure on purpose: the caller gathers, this formats, and the test holds it to what it may claim.
 */

/** @param {string|number|null|undefined} at @param {number} now */
export function ago(at, now = Date.now()) {
  const t = typeof at === 'number' ? at : Date.parse(at ?? '')
  if (!Number.isFinite(t)) return 'never'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/**
 * @param {{
 *   version: string, token: boolean, apiUrl: string, gatewayUrl?: string,
 *   daemon: {pid: number, version: string|null}|null, running: boolean,
 *   state: object, seats: Array<{id: string, name: string, threadId: string|null}>,
 *   sessions: Array<{threadId: string|null, ts: number}>, now?: number,
 * }} x
 * @returns {string[]}
 */
export function statusLines(x) {
  const now = x.now ?? Date.now()
  const when = (v) => ago(v, now)
  const out = [`RANY codex bridge — this script is v${x.version}`]

  // The fingerprint is the first bytes of the token's SHA-256 — what the server stores and lists next to
  // each key. It says WHICH token this machine is sending without ever showing the token, which is the
  // only way to tell "the new key is not working" from "this terminal is still sending the old one".
  out.push(x.token
    ? `  token:   set (${x.apiUrl})${x.fingerprint ? ` · fingerprint ${x.fingerprint}${x.tokenFrom ? ` · from ${x.tokenFrom}` : ''}` : ''}`
    : '  token:   MISSING. Set RANY_PERSONA_TOKEN (RANY → your AI tools → Codex) — nothing can reach this machine without it.')
  // The address being dialled, always: "not connected" without it leaves nothing to test by hand, and a
  // self-hosted RANY_API_URL with no matching gateway is a real way to end up dialling the wrong host.
  if (x.gatewayUrl) out.push(`  url:     ${x.gatewayUrl}`)

  if (!x.running || !x.daemon) {
    out.push('  daemon:  NOT RUNNING. Any Codex session start brings it back, or: node scripts/bridge.mjs --daemon')
    // A daemon that STOPPED because it was refused must say so here: otherwise the one fact that
    // explains everything dies with the process, and the next start fails the same way in silence.
    if (x.state?.error) out.push(`  why:     ${x.state.error}`)
  } else {
    const d = x.daemon
    out.push(`  daemon:  pid ${d.pid}, ${d.version ? `v${d.version}` : 'version unknown (started by a build before 0.38.0)'}`
      + (d.version === x.version ? '' : ' — NOT this build; the next Codex session start replaces it'))
    // Only THIS daemon's own state may be read as this daemon's state. An older build writes none, and
    // a file left behind by a previous daemon would read as "connected" for a process that never was.
    if (x.state?.pid !== d.pid) {
      out.push('  gateway: UNKNOWN — this daemon is older than the state file it would write. Restart it:'
        + ' node scripts/bridge.mjs --stop, then start any Codex session.')
    } else {
      const s = x.state
      // Three states. "Open but not identified" is its own fault — the gateway took the connection and
      // never answered Identify — and calling it "not connected" sends someone to their firewall for
      // something on the far side of a socket that is working.
      out.push(`  gateway: ${s.ready
        ? `CONNECTED since ${when(s.readyAt)}${s.persona ? ` as ${s.persona}` : ''}`
        : s.socketOpen
          ? `OPEN BUT NOT IDENTIFIED since ${when(s.socketOpenAt)} — the gateway took the connection and has not answered Identify. The network is fine; this is the token or the persona.`
          : `NOT CONNECTED${s.error ? ` — ${s.error}` : ' — retrying; routing.log has the close reason'}`}`)
      out.push(`  events:  last ${s.lastEvent ? `${s.lastEvent} ${when(s.lastEventAt)}` : 'none since this daemon started'}`
        + ` (started ${when(s.startedAt)})`)
    }
  }

  out.push(x.seats.length
    ? `  seats:   ${x.seats.map((s) => `${s.name} (${s.id}) → thread ${s.threadId ?? 'none yet'}`).join(', ')}`
    : '  seats:   none bound to this folder. Paste a room invite link, or $rany-rejoin to take a remembered seat back.')

  out.push(`  sessions: ${x.sessions.length
    ? x.sessions.map((s) => `${s.threadId ?? 'no thread id yet'} (seen ${when(s.ts)})`).join(', ')
    : 'none open in this folder — a hook has not run here recently'}`)

  out.push('  log:     ~/.rany-plugin/routing.log')
  return out
}
