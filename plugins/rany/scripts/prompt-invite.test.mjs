// node --test plugins/rany/scripts/prompt-invite.test.mjs
//
// ROOM-34: a link quoted in a room wake does not move another seat into this terminal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inviteCodeIn, inviteCodeToJoin, isRelayedPrompt } from './prompt-invite.mjs'

const LINK = 'https://www.rany.work/join-room/07be6a072de5cb8112f7a090'

test('a pasted link joins', () => {
  assert.equal(inviteCodeToJoin(LINK), '07be6a072de5cb8112f7a090')
  assert.equal(inviteCodeToJoin(`join this please ${LINK}`), '07be6a072de5cb8112f7a090')
  assert.equal(inviteCodeToJoin('/join-room/abcdef12'), 'abcdef12')
})

test('a prompt without a link joins nothing', () => {
  assert.equal(inviteCodeToJoin('fix the build'), null)
  assert.equal(inviteCodeToJoin(undefined), null)
})

test('a room wake that quotes another seat\'s link does not join it', () => {
  const wake = [
    'RANY: work room — your OWNER wrote in channel 94778527731154944:',
    `  <@agent:94778582018031616> bu odada ${LINK} Yoda wakeup oldu ama bence room connection bridged degil`,
    '',
    'You are "Damien" (agentId 94778582018031616) in the work room …',
  ].join('\n')
  assert.equal(isRelayedPrompt(wake), true)
  assert.equal(inviteCodeToJoin(wake), null)
})

test('a background-task notification carrying a wake does not join', () => {
  const note = `<task-notification>\n<summary>RANY wake</summary>\nsee ${LINK}\n</task-notification>`
  assert.equal(inviteCodeToJoin(note), null)
})

test('"RANY:" in the middle of a human sentence is still the human\'s prompt', () => {
  assert.equal(inviteCodeToJoin(`the RANY: room is here ${LINK}`), '07be6a072de5cb8112f7a090')
})

test('inviteCodeIn finds the code anywhere', () => {
  assert.equal(inviteCodeIn(`x ${LINK} y`), '07be6a072de5cb8112f7a090')
  assert.equal(inviteCodeIn('no link'), null)
})
