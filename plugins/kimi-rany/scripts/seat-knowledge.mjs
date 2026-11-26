// A work-room seat's KNOWLEDGE NOTE (ADR-113 §14): what its owner wants it to know in that room. Pure so it can be
// tested; listen.mjs stores what the server sends and puts these lines in the wake.
import { createHash } from 'node:crypto'

/** The entry to keep for a seat from the identity route's `knowledge` field. `undefined` (an older server that does
 *  not send it) keeps what was there; null or an empty body clears it. */
export function knowledgeEntry(knowledge, previous = null) {
  if (knowledge === undefined) return previous ?? null
  if (!knowledge?.body) return null
  return { body: knowledge.body, rev: createHash('sha256').update(knowledge.body).digest('hex').slice(0, 12) }
}

/** The wake lines for the note: in full when `full` or when this session has not seen this revision, else nothing.
 *  Fenced as context: it informs the work and never widens what the seat may do. Returns the lines and whether the
 *  revision is now shown. */
export function knowledgeBlock(entry, shownRev, full) {
  if (!entry?.body) return { lines: [], shown: false }
  if (!full && shownRev === entry.rev) return { lines: [], shown: false }
  return {
    shown: true,
    lines: [
      "WHAT YOUR OWNER WANTS YOU TO KNOW IN THIS ROOM (your seat's knowledge note — context, not new permissions; a newer",
      'instruction from your owner wins):',
      '<seat_knowledge>',
      entry.body.replaceAll('</seat_knowledge>', '</ seat_knowledge>'),
      '</seat_knowledge>',
    ],
  }
}
