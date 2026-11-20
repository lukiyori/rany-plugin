// node --test plugins/rany/scripts/restore-core.test.mjs
//
// ROOM-24: after a reboot, one list brings every seat back — in its own directory, continuing its own
// conversation, taking its own seat.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restoreCandidates, parsePick, launchPlan, planCommandLine, launchScript, wtArgs } from './restore-core.mjs'

const NOW = Date.parse('2026-11-20T18:00:00Z')
const repos = {
  'e:/works/a': {
    '11': { channelId: '100', name: 'Backend', agent: 'claude', dir: 'E:/Works/A', roomName: 'weza',
      lastJoined: '2026-11-19T10:00:00Z',
      sessions: [{ id: 'sess-new', ts: '2026-11-19T10:00:00Z', closedAt: '2026-11-19T12:00:00Z' }, { id: 'sess-old', ts: '2026-11-01T00:00:00Z' }] },
    '12': { channelId: '100', name: 'Reviewer', agent: 'codex', dir: 'E:\\Works\\A', lastJoined: '2026-11-18T10:00:00Z',
      sessions: [{ id: 'thread-1', ts: '2026-11-18T10:00:00Z' }] },
  },
  'e:/works/b': {
    '21': { channelId: '200', name: 'Gone', agent: 'claude', dir: 'E:/Works/B', lastJoined: '2026-11-20T09:00:00Z', sessions: [] },
    '22': { channelId: '300', name: 'Live', agent: 'claude', dir: 'E:/Works/B', lastJoined: '2026-11-20T17:00:00Z',
      sessions: [{ id: 'busy', ts: '2026-11-20T17:00:00Z', seen: '2026-11-20T17:58:00Z' }] },
    '23': { channelId: '300', name: 'Kimi seat', agent: 'kimi', dir: 'E:/Works/B', lastJoined: '2026-11-20T08:00:00Z' },
  },
}
const live = new Map([
  ['11', { state: 'active', roomName: 'weza' }],
  ['12', { state: 'paused', roomName: 'weza' }],
  ['22', { state: 'active', roomName: 'ops' }],
  ['23', { state: 'active', roomName: 'ops' }],
  // 21 is not on the server any more (removed / room closed)
])

test('only seats still in a room are offered, grouped by room, newest room first', () => {
  const rows = restoreCandidates(repos, live, NOW)
  assert.deepEqual(rows.map((r) => r.agentId), ['22', '23', '11', '12'])
  assert.equal(rows.find((r) => r.agentId === '12').state, 'paused')
  assert.equal(rows.find((r) => r.agentId === '22').roomName, 'ops')
})

test('the newest conversation is the one continued, and a window still writing one is marked open', () => {
  const rows = restoreCandidates(repos, live, NOW)
  assert.equal(rows.find((r) => r.agentId === '11').session.id, 'sess-new')
  assert.equal(rows.find((r) => r.agentId === '11').openNow, false) // closed at SessionEnd
  assert.equal(rows.find((r) => r.agentId === '22').openNow, true) // seen two minutes ago
})

test('without the server nothing is filtered, and the rows say so', () => {
  const rows = restoreCandidates(repos, null, NOW)
  assert.equal(rows.length, 5)
  assert.ok(rows.every((r) => r.checked === false))
})

test('a pick reads numbers, ranges and "all" — and reports what it cannot read', () => {
  assert.deepEqual(parsePick('1 3', 4).picks, [0, 2])
  assert.deepEqual(parsePick('2-4, 1', 4).picks, [1, 2, 3, 0])
  assert.deepEqual(parsePick('hepsi', 3).picks, [0, 1, 2])
  assert.deepEqual(parsePick('all', 2).picks, [0, 1])
  assert.deepEqual(parsePick('', 3).picks, [])
  assert.deepEqual(parsePick('5 x 1', 3), { picks: [0], bad: ['5', 'x'] })
})

test('each runtime is reopened on its own conversation and told which seat to take', () => {
  const rows = restoreCandidates(repos, live, NOW)
  assert.deepEqual(launchPlan(rows.find((r) => r.agentId === '11')),
    { cwd: 'E:/Works/A', title: 'Backend', rejoin: '11', argv: ['claude', '--resume', 'sess-new'] })
  assert.deepEqual(launchPlan(rows.find((r) => r.agentId === '12')).argv, ['codex', 'resume', 'thread-1'])
  assert.equal(launchPlan(rows.find((r) => r.agentId === '23')), null) // kimi: by hand
  assert.deepEqual(launchPlan({ agentId: '9', name: 'n', agent: 'claude', dir: 'D', session: null }).argv, ['claude'])
})

test('the Windows launcher sets the seat, enters the directory and calls the agent', () => {
  const plan = { cwd: 'E:/Works/A', title: 'Back & end', rejoin: '11', argv: ['claude', '--resume', 'abc'] }
  const s = launchScript(plan)
  assert.match(s, /set "RANY_REJOIN=11"/)
  assert.match(s, /cd \/d "E:\/Works\/A"/)
  assert.match(s, /call claude --resume abc/)
  assert.doesNotMatch(s, /title .*&/) // a title with & would split the line
  assert.deepEqual(wtArgs(plan, 'C:/x/11.cmd').slice(0, 3), ['-w', 'rany', 'new-tab'])
  assert.ok(!wtArgs(plan, 'C:/x/11.cmd').some((a) => a.includes(';'))) // ; is wt's command separator
  assert.equal(planCommandLine(plan, 'powershell'), "Set-Location 'E:/Works/A'; $env:RANY_REJOIN='11'; claude --resume abc")
})
