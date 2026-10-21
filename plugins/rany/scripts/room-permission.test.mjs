// node --test plugins/rany/scripts/room-permission.test.mjs
//
// ROOM-14: a decision a seated session needs is asked for in the ROOM, never only in its terminal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { riskyCall, permissionCard, decisionOf, stillWaiting, callKey, RISKY } from './room-permission.mjs'

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } })
const pwsh = (command) => ({ tool_name: 'PowerShell', tool_input: { command } })

test('the calls that cannot be taken back are the ones asked about', () => {
  for (const cmd of [
    'git reset --hard origin/master',
    'git reset --mixed 651b05455',
    'git checkout -- web/src/index.css',
    'git restore .',
    'git clean -fd',
    'git rebase origin/master',
    'rm -rf temp/build',
    'rm -f .env',
    'dotnet run --project tools/Rany.DbMigrator',
    'npm publish',
  ]) assert.ok(riskyCall(bash(cmd)), `should ask about: ${cmd}`)
  assert.ok(riskyCall(pwsh('Remove-Item -Recurse -Force C:/tmp/x')))
  assert.ok(riskyCall(bash('psql -c "DROP TABLE bots.room_requests"')))
})

test('ordinary work is never asked about — a card nobody reads is worse than no card', () => {
  for (const cmd of [
    'git status',
    'git add -A plugins/rany',
    'git commit -m "fix: x"',
    'git push origin master',
    'git log --oneline -5',
    'npm run build',
    'npm run lint',
    'dotnet test Rany.sln',
    'node --test plugins/rany/scripts/room-permission.test.mjs',
    'mv a.txt b.txt',
    'cat db/0525_pending_uploads.sql',
    'grep -rn "rm -rf" docs/',
  ]) assert.equal(riskyCall(bash(cmd)), null, `should NOT ask about: ${cmd}`)
})

test('an edit is not a permission question — the repo rules guard the paths that are', () => {
  assert.equal(riskyCall({ tool_name: 'Edit', tool_input: { file_path: 'db/0001_init.sql' } }), null)
  assert.equal(riskyCall({ tool_name: 'Write', tool_input: { file_path: '.rany/rany.json' } }), null)
  assert.equal(riskyCall(bash('')), null)
  assert.equal(riskyCall(null), null)
})

test('the card quotes the one segment that will run, not the whole line', () => {
  const hit = riskyCall(bash('cd E:/x && git fetch origin && git reset --hard origin/master && npm run build'))
  assert.equal(hit.what, 'git reset --hard origin/master')
  const card = permissionCard({ ...hit, cwd: 'E:/Works/Repo/BetArts/Repo/Cortex' })
  assert.match(card, /git reset --hard origin\/master/)
  assert.match(card, /E:\/Works\/Repo\/BetArts\/Repo\/Cortex/)
  assert.match(card, /moves this branch and can drop commits/)
})

test('a rules card says the rules asked, not that the command is dangerous', () => {
  const card = permissionCard({ what: 'git rm old.txt', cwd: 'E:/r', why: 'git rm', source: 'rules' })
  assert.match(card, /repository's rules/)
})

test('approved means the runtime runs it, for that command only', () => {
  const d = decisionOf({ state: 'approved' }, { what: 'git clean -fd' })
  assert.equal(d.permissionDecision, 'allow')
  assert.match(d.permissionDecisionReason, /approved this in the work room/)
  assert.match(d.permissionDecisionReason, /for exactly `git clean -fd`/)
})

test("the owner's note is quoted back, because it is the instruction", () => {
  const d = decisionOf({ state: 'approved', decisionNote: 'only temp/, nothing else' }, { what: 'rm -rf temp/x' })
  assert.match(d.permissionDecisionReason, /"only temp\/, nothing else"/)
})

test('denied is final and says not to work around it', () => {
  const d = decisionOf({ state: 'denied' }, { what: 'git reset --hard' })
  assert.equal(d.permissionDecision, 'deny')
  assert.match(d.permissionDecisionReason, /DENIED/)
  assert.match(d.permissionDecisionReason, /work around it/)
})

test('an expired card is not an approval, and says nobody decided', () => {
  const d = decisionOf({ state: 'expired' }, { what: 'git clean -fd' })
  assert.equal(d.permissionDecision, 'deny')
  assert.match(d.permissionDecisionReason, /nobody\s+decided/)
})

test('a pending card is no decision at all', () => {
  assert.equal(decisionOf({ state: 'pending' }, { what: 'x' }), null)
  assert.equal(decisionOf(null, { what: 'x' }), null)
})

test('when the wait runs out the terminal may still ask, and the room keeps the card', () => {
  const s = stillWaiting({ what: 'git clean -fd', channelId: '94778527731154944', requestId: '105', waitedMs: 240_000 })
  assert.equal(s.permissionDecision, 'ask')
  assert.match(s.permissionDecisionReason, /105/)
  assert.match(s.permissionDecisionReason, /240s/)
  assert.match(s.permissionDecisionReason, /not file a second card/)
})

test('one decision is remembered per seat AND per exact command', () => {
  assert.equal(callKey('9', 'git clean -fd'), callKey('9', 'git clean -fd'))
  assert.notEqual(callKey('9', 'git clean -fd'), callKey('9', 'git clean -fdx'))
  assert.notEqual(callKey('9', 'git clean -fd'), callKey('8', 'git clean -fd'))
})

test('every entry in the floor list carries the words for WHY it is being asked', () => {
  for (const r of RISKY) {
    assert.ok(r.rule && typeof r.rule === 'string')
    assert.ok(r.why && /[a-z]/.test(r.why), `no reason for ${r.rule}`)
  }
})
