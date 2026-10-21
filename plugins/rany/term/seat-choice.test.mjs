import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseSeat, handoffSeat } from './seat-choice.mjs'

// ROOM-15: a mirrored terminal belongs to the seat its SESSION holds — never to a seat guessed from the
// directory. These are the two halves of that: what the launcher may decide on its own, and what it
// accepts from the session.

const cortex = [
  { id: '106274470183829504', name: 'Jane', lastJoined: '2026-10-21T06:16:48.253Z' },
  { id: '105747999119900672', name: 'Mike', lastJoined: '2026-10-19T19:24:47.776Z' },
  { id: '100516685013843968', name: 'Jack', lastJoined: '2026-10-14T19:27:43.687Z' },
]

test('one seat in the directory is the answer', () => {
  const { seat, waiting, pinned } = chooseSeat([cortex[1]])
  assert.equal(seat.id, '105747999119900672')
  assert.equal(waiting, false)
  assert.equal(pinned, false)
})

test('several seats: no seat is picked, and the screen waits', () => {
  const { seat, waiting } = chooseSeat(cortex)
  assert.equal(seat, null, 'the newest seat is a guess about which window this is, and it was wrong')
  assert.equal(waiting, true)
})

test('no seat at all: nothing to mirror and nothing to wait for', () => {
  const { seat, waiting } = chooseSeat([])
  assert.equal(seat, null)
  assert.equal(waiting, false, 'most terminals hold no seat and must look like a plain `claude`')
})

test('--seat is the owner being certain: it is used and it is pinned', () => {
  const { seat, pinned, waiting } = chooseSeat(cortex, '105747999119900672')
  assert.equal(seat.name, 'Mike')
  assert.equal(pinned, true, 'a handoff may not move the screen off a seat the owner named')
  assert.equal(waiting, false)
})

test('--seat for a seat this directory does not remember is still honoured', () => {
  const { seat, pinned } = chooseSeat(cortex, '94778582018031616')
  assert.deepEqual(seat, { id: '94778582018031616' })
  assert.equal(pinned, true)
})

test('a handoff names the seat and its name', () => {
  const h = handoffSeat(JSON.stringify({ agentId: 105747999119900672n.toString(), channelId: '1', name: 'Mike' }))
  assert.deepEqual(h, { id: '105747999119900672', name: 'Mike' })
})

test('a half-written or empty handoff says nothing', () => {
  for (const text of ['', '{', '{}', '{"agentId":""}', 'null', '[]'])
    assert.equal(handoffSeat(text), null, `read again next poll, never acted on: ${text}`)
})

test('the id comes back as a string, and the writer must send it as one', () => {
  assert.equal(typeof handoffSeat('{"agentId":"106274470183829504"}').id, 'string')
  assert.equal(handoffSeat('{"agentId":"106274470183829504"}').name, null)
  // A seat id is a snowflake and JSON numbers are doubles: written unquoted it would come back off by a
  // few, which is why writeTermHandoff stringifies it. Asserted so the pair cannot drift apart.
  assert.notEqual(handoffSeat('{"agentId":106274470183829504}').id, '106274470183829504')
})
