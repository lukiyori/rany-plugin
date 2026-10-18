// node --test plugins/rany/scripts/seat-session.test.mjs
//
// ROOM-12: a seat that is answering is not shown as asleep.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionAnnouncement } from './seat-session.mjs'

test('a seat that has never reported a conversation reports this one', () => {
  assert.equal(sessionAnnouncement(undefined, 'a'), 'new')
  assert.equal(sessionAnnouncement([], 'a'), 'new')
})

test('a different conversation is reported', () => {
  assert.equal(sessionAnnouncement([{ id: 'old' }], 'new-one'), 'new')
})

test('the same conversation, still believed open, is not reported again', () => {
  // The daemon sweeps every few minutes and every prompt fires a hook: this is the ordinary case, and
  // it must cost nothing.
  assert.equal(sessionAnnouncement([{ id: 'a', seen: '2026-10-18T20:00:00Z' }], 'a'), 'none')
})

test('the same conversation, RESUMED after we said it closed, is reported again', () => {
  // The bug: `closedAt` was cleared locally and the room was never told, so the tile said "Session
  // closed" for a seat that answered a ping.
  assert.equal(sessionAnnouncement([{ id: 'a', closedAt: '2026-10-17T21:00:00Z' }], 'a'), 'reopened')
})

test('no conversation id yet means nothing to say', () => {
  // Codex reveals a thread id only once a prompt has been typed; a hook before that must stay silent
  // rather than report a seat as open under the wrong id.
  assert.equal(sessionAnnouncement([{ id: 'a' }], undefined), 'none')
  assert.equal(sessionAnnouncement([{ id: 'a' }], null), 'none')
})

test('ids are compared as text, not by identity', () => {
  assert.equal(sessionAnnouncement([{ id: 123 }], '123'), 'none')
})
