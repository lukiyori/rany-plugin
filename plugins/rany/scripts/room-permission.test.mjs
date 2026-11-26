// node --test plugins/rany/scripts/room-permission.test.mjs
//
// ROOM-14: a decision a seated session needs is asked for in the ROOM, never only in its terminal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { riskyCall, permissionCard, decisionOf, stillWaiting, callKey, RISKY,
  forgetTokens, isForgiven, mergeForgiven, forgetNote, parseForgetNote, FORGET_MARKER,
  floorCardAppliesInMode, AUTO_PERMISSION_MODES,
  normCommand, cardCommands, requestIdOf, cardAllows } from './room-permission.mjs'

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

test('when the wait runs out the call is held back (never a terminal prompt the room cannot reach), and the room keeps the card', () => {
  const s = stillWaiting({ what: 'git clean -fd', channelId: '94778527731154944', requestId: '105', waitedMs: 240_000 })
  assert.equal(s.permissionDecision, 'deny')
  assert.match(s.permissionDecisionReason, /wakes you/)
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

// ── ADR-115: "approve & never ask again" ───────────────────────────────────────────────────────────────

test('forgetTokens: the delete target basename, for the delete family only', () => {
  const tok = (cmd) => forgetTokens(riskyCall(bash(cmd)))
  assert.deepEqual(tok('rm -rf bin'), ['bin'])
  assert.deepEqual(tok('rm -rf ./src/Foo/bin'), ['bin'])            // basename, any depth
  assert.deepEqual(tok('rm -rf bin obj'), ['bin', 'obj'])           // multiple targets
  assert.deepEqual(tok('rm -rf Bin'), ['bin'])                      // lower-cased
  assert.deepEqual(tok('rmdir obj'), ['obj'])
  assert.deepEqual(forgetTokens(riskyCall(pwsh('Remove-Item -Recurse -Force bin'))), ['bin'])
  assert.deepEqual(forgetTokens(riskyCall(pwsh('Remove-Item -Recurse -Force .\\src\\obj'))), ['obj'])
  assert.deepEqual(forgetTokens(riskyCall(pwsh('Remove-Item -Recurse -Force -Path C:\\w\\bin'))), ['bin'])
  assert.deepEqual(forgetTokens(riskyCall(bash('del /s /q bin'))), ['bin'])
})

test('forgetTokens: no token for a risky rule that names no clear target', () => {
  assert.deepEqual(forgetTokens(riskyCall(bash('git reset --hard origin/master'))), [])
  assert.deepEqual(forgetTokens(riskyCall(bash('git clean -fd'))), [])
  assert.deepEqual(forgetTokens(riskyCall(bash('npm publish'))), [])
  assert.deepEqual(forgetTokens(riskyCall(bash('rm -rf *'))), [])   // a glob is not a nameable target
  assert.deepEqual(forgetTokens(riskyCall(bash('rm -rf .'))), [])
  assert.deepEqual(forgetTokens(null), [])
})

test('isForgiven: only when EVERY target is already allow-listed', () => {
  assert.equal(isForgiven(['bin', 'obj'], ['bin']), true)
  assert.equal(isForgiven(['bin', 'obj'], ['bin', 'obj']), true)
  assert.equal(isForgiven(['bin'], ['bin', 'obj']), false)         // obj not forgiven → still ask
  assert.equal(isForgiven(['Bin'], ['bin']), true)                 // case-insensitive
  assert.equal(isForgiven(['bin'], []), false)                     // no clear target → never auto-allow
  assert.equal(isForgiven([], ['bin']), false)
})

test('mergeForgiven: additive, deduped, lower-cased', () => {
  assert.deepEqual(mergeForgiven(['bin'], ['obj']).sort(), ['bin', 'obj'])
  assert.deepEqual(mergeForgiven(['bin'], ['BIN']), ['bin'])
  assert.deepEqual(mergeForgiven(null, ['bin']), ['bin'])
  assert.deepEqual(mergeForgiven(['bin'], null), ['bin'])
})

test('forget note marker round-trips, and a plain note carries no tokens', () => {
  assert.equal(forgetNote(['bin', 'obj']), `${FORGET_MARKER}bin,obj`)
  assert.equal(forgetNote([]), '')
  assert.deepEqual(parseForgetNote(`${FORGET_MARKER}bin,obj`), ['bin', 'obj'])
  assert.deepEqual(parseForgetNote('looks fine to me'), [])
  assert.deepEqual(parseForgetNote(''), [])
  assert.deepEqual(parseForgetNote(forgetNote(['bin'])), ['bin'])
})

// ROOM-29: a card the agent filed with `commands` lets exactly those commands past the terminal's check, once a
// PERSON approved it, inside the window — and nothing else.
const now = Date.parse('2026-11-23T19:40:00Z')
const card = (over = {}) => ({
  state: 'approved', byPerson: true, decidedAt: '2026-11-23T19:35:00Z',
  question: 'Push and build?\n\nCommands this approval covers (exactly):\n```\ngit push origin HEAD:master\nnpm run build\n```',
  ...over,
})

test('an approved card lets its named command run', () => {
  assert.equal(cardAllows(card(), 'git push origin HEAD:master', { now }), true)
  assert.equal(cardAllows(card(), '  git push   origin HEAD:master ', { now }), true)
  assert.equal(cardAllows(card(), 'npm run build', { now }), true)
})

test('a command the card does not name is not covered, not even a longer one that contains it', () => {
  assert.equal(cardAllows(card(), 'git push origin HEAD:master --force', { now }), false)
  assert.equal(cardAllows(card(), 'git push', { now }), false)
  assert.equal(cardAllows(card(), 'git push origin HEAD:master && rm -rf .', { now }), false)
  assert.equal(cardAllows(card(), '', { now }), false)
})

test('only a person\'s approval, only approved, only inside the window', () => {
  assert.equal(cardAllows(card({ byPerson: false }), 'npm run build', { now }), false)
  assert.equal(cardAllows(card({ byPerson: undefined }), 'npm run build', { now }), false)
  assert.equal(cardAllows(card({ state: 'pending' }), 'npm run build', { now }), false)
  assert.equal(cardAllows(card({ state: 'denied' }), 'npm run build', { now }), false)
  assert.equal(cardAllows(card({ decidedAt: '2026-11-23T19:20:00Z' }), 'npm run build', { now }), false)
  assert.equal(cardAllows(card({ decidedAt: null }), 'npm run build', { now }), false)
  assert.equal(cardAllows(null, 'npm run build', { now }), false)
})

test('the commands a call names are cleaned; the request id is read from the tool response', () => {
  assert.deepEqual(cardCommands({ commands: [' git  push ', 'git push', 'a\nb', '', 'x'.repeat(501), 'npm test'] }),
    ['git push', 'npm test'])
  assert.deepEqual(cardCommands({}), [])
  assert.equal(normCommand(' a \t b '), 'a b')
  assert.equal(requestIdOf('{"requestId":"118431534779727872","state":"pending"}'), '118431534779727872')
  assert.equal(requestIdOf([{ type: 'text', text: '{"requestId":"42","state":"pending"}' }]), '42')
  assert.equal(requestIdOf({ content: [{ type: 'text', text: '{"requestId":"7"}' }] }), '7')
  assert.equal(requestIdOf({ requestId: '9' }), '9')
  assert.equal(requestIdOf('not json'), null)
})

// floorCardAppliesInMode (owner, 2026-11-26): the standard-command FLOOR card steps aside in an auto Claude Code
// permission mode (the runtime runs under its own guard there); it still shows in manual/plan, and when the mode
// is unknown/absent the safe default is to keep asking.
test('the floor card is suppressed only in auto mode (bypassPermissions), kept in the other three', () => {
  assert.equal(floorCardAppliesInMode('bypassPermissions'), false) // owner's "auto mode" → no card
  assert.equal(floorCardAppliesInMode('acceptEdits'), true)        // accept edits still prompts for commands → card
  assert.equal(floorCardAppliesInMode('default'), true)            // manual → card
  assert.equal(floorCardAppliesInMode('plan'), true)               // plan → card
})

test('an unknown or missing permission mode keeps the card (safe default)', () => {
  assert.equal(floorCardAppliesInMode(undefined), true)
  assert.equal(floorCardAppliesInMode(''), true)
  assert.equal(floorCardAppliesInMode('something-new'), true)
  assert.equal(floorCardAppliesInMode(42), true)
})

test('the owner can override which modes count as auto', () => {
  // Override to also treat acceptEdits as auto → it stops carding; a mode left out of the override cards.
  assert.equal(floorCardAppliesInMode('acceptEdits', ['acceptEdits', 'bypassPermissions']), false)
  assert.equal(floorCardAppliesInMode('default', ['acceptEdits', 'bypassPermissions']), true)
  // An explicit empty / all-junk array means "no mode is auto" → always card (suppression turned off).
  assert.equal(floorCardAppliesInMode('bypassPermissions', []), true)
  assert.equal(floorCardAppliesInMode('bypassPermissions', [' ', 7]), true)
  // Only a non-array (unset) falls back to the default set.
  assert.equal(floorCardAppliesInMode('bypassPermissions', null), false)
  assert.equal(floorCardAppliesInMode('bypassPermissions', undefined), false)
  // The default set is auto mode only.
  assert.deepEqual(AUTO_PERMISSION_MODES, ['bypassPermissions'])
})
