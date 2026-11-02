// What a session that sits in a work room is CALLED — in the terminal tab, the /resume list and the prompt
// bar: "<seat> @ <room>". Claude Code otherwise names a session from its conversation ("✳ Cortex decisions…"),
// and an owner with five agent windows open could not tell which tab was which agent in which room
// (owner, 2026-11-02: "kanal - agent ismi veya agent @ kanal ismi olmali").

/** A seat binding's `room` → its title, or null when there is no seat. Control characters are dropped: the
 *  title goes into a terminal escape sequence, and a name must not be able to end it early. */
export function seatTitleOf(room) {
  if (!room?.name) return null
  const title = (room.roomName ? `${room.name} @ ${room.roomName}` : String(room.name))
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 80)
  return title || null
}

/** The OSC 0 sequence that puts a title on the terminal tab, for a hook's `terminalSequence`. */
export function titleSequence(title) {
  return title ? `\x1b]0;${title}\x07` : null
}
