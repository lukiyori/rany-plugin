import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seatTitleOf, titleSequence } from './seat-title.mjs'

test('a seated session is called "<seat> @ <room>"', () => {
  assert.equal(seatTitleOf({ name: 'Damien', roomName: 'dev' }), 'Damien @ dev')
})

test('a seat whose room name is unknown is called by the seat alone', () => {
  assert.equal(seatTitleOf({ name: 'Olivia' }), 'Olivia')
})

test('no seat, no title', () => {
  assert.equal(seatTitleOf(null), null)
  assert.equal(seatTitleOf({ roomName: 'dev' }), null)
  assert.equal(titleSequence(null), null)
})

test('a name cannot end the escape sequence early', () => {
  const t = seatTitleOf({ name: 'Mal\x07\x1b]0;x', roomName: 'dev\n' })
  assert.equal(t, 'Mal]0;x @ dev')
  assert.equal(titleSequence(t), '\x1b]0;Mal]0;x @ dev\x07')
})

test('a long title is cut to 80 characters', () => {
  assert.equal(seatTitleOf({ name: 'a'.repeat(100), roomName: 'r' }).length, 80)
})
