// node --test plugins/codex-rany/scripts/bridge-status.test.mjs
//
// ROOM-13: the bridge can say whether RANY reaches this session, and never claims what it cannot read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statusLines, ago } from './bridge-status.mjs'

const NOW = Date.parse('2026-10-18T21:00:00Z')
const iso = (minutes) => new Date(NOW - minutes * 60_000).toISOString()
const base = {
  version: '0.38.0', token: true, apiUrl: 'https://www.rany.work/api', gatewayUrl: 'wss://www.rany.work/gateway',
  daemon: { pid: 42, version: '0.38.0' }, running: true,
  state: { pid: 42, ready: true, readyAt: iso(30), persona: 'Rainman', startedAt: iso(31), lastEvent: 'PERSONA_ROOM_MESSAGE', lastEventAt: iso(2) },
  seats: [{ id: '9', name: 'Olivia', threadId: 'abc' }],
  sessions: [{ threadId: 'abc', ts: NOW - 60_000 }],
  now: NOW,
}
const text = (x) => statusLines({ ...base, ...x }).join('\n')

test('a healthy bridge says connected, and names the last event', () => {
  const s = text({})
  assert.match(s, /gateway: CONNECTED since 30m ago as Rainman/)
  assert.match(s, /events:  last PERSONA_ROOM_MESSAGE 2m ago/)
  assert.doesNotMatch(s, /UNKNOWN|MISSING|NOT RUNNING/)
})

test('the address being dialled is always printed, so a failure can be tested by hand', () => {
  assert.match(text({}), /url:     wss:\/\/www\.rany\.work\/gateway/)
  assert.match(text({ state: { ...base.state, ready: false } }), /url:     wss:\/\/www\.rany\.work\/gateway/)
})

test('a running process with no socket is NOT reported as working', () => {
  // The whole point: this is what the owner was looking at while being told the bridge was fine.
  const s = text({ state: { ...base.state, ready: false, readyAt: null, lastEvent: null, lastEventAt: null } })
  assert.match(s, /gateway: NOT CONNECTED/)
  assert.match(s, /events:  last none since this daemon started/)
})

test('a socket that opened but never identified is its own state, not "not connected"', () => {
  // Calling this "not connected" sends someone to their firewall for a fault on the far side of a
  // socket that is working — which is exactly the hour that was lost before this line existed.
  const s = text({ state: { ...base.state, ready: false, socketOpen: true, socketOpenAt: iso(4) } })
  assert.match(s, /gateway: OPEN BUT NOT IDENTIFIED since 4m ago/)
  assert.doesNotMatch(s, /NOT CONNECTED/)
})

test('a refused token is quoted, not summarised as "retrying"', () => {
  const s = text({ state: { ...base.state, ready: false, error: 'the gateway refused this persona token' } })
  assert.match(s, /gateway: NOT CONNECTED — the gateway refused this persona token/)
})

test('a daemon older than the state file gets UNKNOWN, never a borrowed "connected"', () => {
  // The state file may be left over from a daemon that has since been replaced; reading it as this
  // one's would report a process that never connected as healthy.
  const s = text({ daemon: { pid: 7, version: null }, state: { ...base.state, pid: 42, ready: true } })
  assert.match(s, /gateway: UNKNOWN/)
  assert.doesNotMatch(s, /CONNECTED since/)
  assert.match(s, /version unknown \(started by a build before 0\.38\.0\)/)
  assert.match(s, /NOT this build/)
})

test('a daemon of another version is named as such', () => {
  assert.match(text({ daemon: { pid: 42, version: '0.33.0' } }), /pid 42, v0\.33\.0 — NOT this build/)
})

test('no token is the first thing said, because nothing else can work without it', () => {
  const s = text({ token: false })
  assert.match(s, /token:   MISSING\./)
  assert.match(s, /RANY_PERSONA_TOKEN/)
})

test('no daemon says how to get one back, and claims nothing about the gateway', () => {
  const s = text({ running: false, state: { ...base.state, error: null } })
  assert.match(s, /daemon:  NOT RUNNING\./)
  assert.doesNotMatch(s, /gateway:/)
})

test('a daemon that STOPPED because it was refused says why, after it is gone', () => {
  // The refusal is the only fact that explains everything, and it used to die with the process.
  const s = text({ running: false, state: { ...base.state, error: 'the gateway refused this persona token (authentication_failed). Issue a new key…' } })
  assert.match(s, /why:     the gateway refused this persona token \(authentication_failed\)/)
})

test('a folder with no seat says so, with the way to get one', () => {
  const s = text({ seats: [] })
  assert.match(s, /seats:   none bound to this folder/)
  assert.match(s, /\$rany-rejoin/)
})

test('a seat that has no thread id yet is not printed as bound to "null"', () => {
  assert.match(text({ seats: [{ id: '9', name: 'Olivia', threadId: null }] }), /→ thread none yet/)
})

test('ago() never invents a time', () => {
  assert.equal(ago(undefined, NOW), 'never')
  assert.equal(ago('not a date', NOW), 'never')
  assert.equal(ago(NOW - 5_000, NOW), '5s ago')
  assert.equal(ago(NOW - 3 * 3600_000, NOW), '3h ago')
})
