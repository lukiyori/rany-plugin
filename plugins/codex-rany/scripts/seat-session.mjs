/**
 * When the room must be TOLD that a seat's local conversation is open.
 *
 * A seat's tile says "Session closed" or offers the way back in (ROOM-07), and that state comes from
 * what the plugin last reported — the room cannot see a terminal. The plugin used to report an open
 * session only when the id it saw differed from the one it had remembered, which is right exactly once:
 * the first time a seat learns which conversation holds it. A RESUMED conversation keeps its id, so the
 * close we reported at SessionEnd was never taken back, and the tile kept saying the seat was asleep
 * while it answered in the room (owner, 2026-10-18: "uyumus gozukuyordu agent … halen uyuyormus gibi
 * gozukuyor ama ping attı").
 *
 * `closedAt` is written by the plugin itself when it tells the room a session ended, so it is precisely
 * the record of "the room believes this is closed" — and therefore the thing that says to speak again.
 *
 * Shared, byte-identical, with the Codex bridge: both keep the same seat history file.
 */

/**
 * @param {Array<{id?: string, closedAt?: string}>|undefined} remembered — the seat's sessions, newest first.
 * @param {string|null|undefined} sessionId — the conversation that is live now.
 * @returns {'new'|'reopened'|'none'} 'new' also means the seat history must record it.
 */
export function sessionAnnouncement(remembered, sessionId) {
  if (!sessionId) return 'none'
  const was = Array.isArray(remembered) ? remembered[0] : undefined
  if (String(was?.id ?? '') !== String(sessionId)) return 'new'
  return was?.closedAt ? 'reopened' : 'none'
}

/**
 * Does a seat's history show that THIS conversation held it before? The condition for session-matched
 * reattach (ADR-068 as amended 2026-11-26): the SAME session reopening retakes its own seat — it is the
 * deliberately-joined session returning, not an unrelated one, so it carries none of the re-sent-context
 * cost ADR-068 was written against. A session that never held the seat does not auto-take it (it is only
 * offered). Order-independent: a reopened session is not always the newest the seat remembers.
 * @param {Array<{id?: string}>|undefined} remembered — the seat's sessions.
 * @param {string|null|undefined} sessionId — the conversation that is live now.
 * @returns {boolean}
 */
export function seatKnowsThread(remembered, sessionId) {
  if (!sessionId) return false
  return Array.isArray(remembered) && remembered.some((s) => String(s?.id ?? '') === String(sessionId))
}
