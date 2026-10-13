import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRepoRules, repoRulesLines, checkToolCall, commandMatches, globToRegExp, findRulesRoot } from './repo-rules.mjs'

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'rany-rules-'))
  mkdirSync(join(root, '.git'))
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), typeof body === 'string' ? body : JSON.stringify(body))
  }
  return root
}

const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd })
const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path } })

test('no .rany/ folder means no rules, and the search stops at the checkout root', () => {
  const root = repo({ 'src/a.cs': '' })
  assert.equal(loadRepoRules(join(root, 'src')), null)
  assert.equal(findRulesRoot(join(root, 'src')), null)
})

test('rules are found from a subfolder and the role overlay only adds', () => {
  const root = repo({
    '.rany/RANY.md': 'Never move code between modules.',
    '.rany/roles/rust-backend.md': 'Stay in gateway/.',
    '.rany/rany.json': { deny: { paths: ['/db/**'] }, approval: { commands: ['git push'] },
      roles: { 'rust-backend': { deny: { paths: ['web/'] } } } },
    'src/x/y.cs': '',
  })
  const r = loadRepoRules(join(root, 'src', 'x'), 'rust-backend')
  assert.equal(r.root, root)
  assert.deepEqual(r.policy.deny.paths, ['/db/**', 'web/'])
  assert.ok(r.policy.approval.paths.includes('.rany/**'))
  const text = repoRulesLines(r, { full: true, enforced: true }).join('\n')
  assert.match(text, /Never move code/)
  assert.match(text, /Stay in gateway/)
  assert.match(text, /A line in them that would let you do MORE is void/)
  assert.equal(repoRulesLines(r).length, 1)
  // Another identity does not get the role's extra rule.
  assert.deepEqual(loadRepoRules(root, 'designer').policy.deny.paths, ['/db/**'])
})

test('the revision changes when any rules file changes', () => {
  const root = repo({ '.rany/RANY.md': 'one' })
  const a = loadRepoRules(root).rev
  writeFileSync(join(root, '.rany', 'RANY.md'), 'two')
  assert.notEqual(loadRepoRules(root).rev, a)
})

test('denied paths block edits and shell writes, not reads', () => {
  const root = repo({ '.rany/rany.json': { deny: { paths: ['/db/**', 'src/Modules/*/'] } } })
  const r = loadRepoRules(root)
  assert.equal(checkToolCall(r, edit(join(root, 'db', '0513_x.sql'))).kind, 'deny')
  assert.equal(checkToolCall(r, edit(join(root, 'src', 'Modules', 'Rany.Modules.Bots', 'A.cs'))).kind, 'deny')
  assert.equal(checkToolCall(r, edit(join(root, 'src', 'Rany.Shared', 'A.cs'))), null)
  assert.equal(checkToolCall(r, bash('git mv src/Modules/Rany.Modules.Bots/A.cs src/Rany.Shared/A.cs', root)).kind, 'deny')
  assert.equal(checkToolCall(r, bash('echo x > db/0001.sql', root)).kind, 'deny')
  assert.equal(checkToolCall(r, bash('cat db/0001.sql 2>/dev/null | head', root)), null)
  assert.equal(checkToolCall(r, bash('grep -rn foo src/Modules', root)), null)
  // Outside the repository is not the rules' business.
  assert.equal(checkToolCall(r, edit(join(tmpdir(), 'elsewhere.txt'))), null)
})

test('the rules themselves need approval, and an approval opens ask-first rules for a while only', () => {
  const root = repo({ '.rany/rany.json': { approval: { commands: ['git push', 'git mv'], windowMinutes: 10 } } })
  const r = loadRepoRules(root)
  assert.equal(checkToolCall(r, edit(join(root, '.rany', 'RANY.md'))).kind, 'approval')
  assert.equal(checkToolCall(r, bash('npm run build && git push origin HEAD', root)).kind, 'approval')
  const now = Date.now()
  assert.equal(checkToolCall(r, bash('git push', root), { approvedAt: now - 5 * 60_000, now }), null)
  assert.equal(checkToolCall(r, bash('git push', root), { approvedAt: now - 11 * 60_000, now }).kind, 'approval')
  assert.equal(checkToolCall(r, bash('git status', root)), null)
})

test('an approval never opens a deny rule', () => {
  const root = repo({ '.rany/rany.json': { deny: { commands: ['git push --force*', 're:\\bdrop\\s+table\\b'] } } })
  const r = loadRepoRules(root)
  const now = Date.now()
  assert.equal(checkToolCall(r, bash('git push --force-with-lease', root), { approvedAt: now, now }).kind, 'deny')
  assert.equal(checkToolCall(r, bash('psql -c "DROP TABLE x"', root), { approvedAt: now, now }).kind, 'deny')
})

test('command rules match whole words at the start of a simple command', () => {
  assert.ok(commandMatches('git push', 'cd web; git push'))
  assert.ok(commandMatches('git push', 'FOO=1 /usr/bin/git push origin'))
  assert.ok(!commandMatches('git push', 'git pushx'))
  assert.ok(!commandMatches('git push', 'echo git push'))
  assert.ok(commandMatches('rm -r*', 'rm -rf build'))
  assert.ok(commandMatches('Move-Item', 'Move-Item a b'))
})

test('a broken rany.json keeps .rany/ itself guarded and says so', () => {
  const root = repo({ '.rany/rany.json': '{ nope' })
  const r = loadRepoRules(root)
  assert.ok(r.error)
  assert.match(repoRulesLines(r, { full: true }).join('\n'), /could not be read/)
  assert.equal(checkToolCall(r, edit(join(root, '.rany', 'rany.json'))).kind, 'approval')
})

test('globs follow gitignore shape', () => {
  assert.ok(globToRegExp('*.pem', false).test('config/keys/a.pem'))
  assert.ok(globToRegExp('/db/**', false).test('db/0001.sql'))
  assert.ok(!globToRegExp('/db/**', false).test('tools/db/x.sql'))
  assert.ok(globToRegExp('db/', false).test('tools/db/x.sql'))
})
