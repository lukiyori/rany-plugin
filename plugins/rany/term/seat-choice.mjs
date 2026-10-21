/**
 * WHICH SEAT a mirrored terminal belongs to (ADR-050) — the one decision the `rany-term` launcher is not
 * allowed to guess.
 *
 * The launcher wraps the agent, so it starts before the session exists and before any seat is bound. All
 * it can see is the directory's seat history, which answers "who has sat here", never "who is sitting
 * here now". While a checkout held one seat the difference did not show; a Cortex checkout holding
 * fourteen made it plain — every new terminal's bytes went to the seat that had joined most recently, so
 * the owner opened one agent's Screen and watched another agent's work while the one actually working
 * showed an empty screen ("Mike'in yaptığı işin terminali Jane'de çıkıyor", 2026-10-21).
 *
 * So: one seat in the directory is an answer, `--seat` is an answer, and anything else WAITS for the
 * session to say (the plugin writes `RANY_TERM_HANDOFF` the moment it binds a seat). Waiting shows an
 * empty Screen for a second or two; guessing shows the wrong agent's work for as long as nobody notices.
 */

/**
 * @param {Array<{id: string, name?: string|null}>} seats — the directory's remembered seats for this kind
 *   of agent, newest first.
 * @param {string|null} seatArg — an explicit `--seat <agentId>`, which is the owner being certain.
 * @returns {{seat: {id: string, name?: string|null}|null, pinned: boolean, waiting: boolean}}
 *   `pinned` means no handoff may move it. `waiting` means the screen is held until one arrives.
 */
export function chooseSeat(seats, seatArg = null) {
  const list = Array.isArray(seats) ? seats.filter((s) => s && s.id) : []
  if (seatArg) {
    const known = list.find((s) => String(s.id) === String(seatArg))
    return { seat: known ?? { id: String(seatArg) }, pinned: true, waiting: false }
  }
  if (list.length === 1) return { seat: list[0], pinned: false, waiting: false }
  // Several seats: not ours to pick. None at all: there is nothing to mirror to, and this is the common
  // case — most terminals are opened in directories that hold no seat, and they must look like a plain
  // `claude`, not like something waiting.
  return { seat: null, pinned: false, waiting: list.length > 1 }
}

/** The seat a handoff file names, or null for anything unreadable — a half-written file is read again on
 *  the next poll, never acted on as if it said something. */
export function handoffSeat(text) {
  let h = null
  try { h = JSON.parse(String(text)) } catch { return null }
  if (!h || typeof h !== 'object') return null
  const id = h.agentId ?? h.agent_id ?? null
  if (id === null || id === undefined || String(id).trim() === '') return null
  return { id: String(id), name: typeof h.name === 'string' && h.name ? h.name : null }
}
