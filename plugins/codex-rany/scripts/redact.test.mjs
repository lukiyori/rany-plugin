// node --test plugins/rany/scripts/redact.test.mjs
//
// The secret-redaction gate (owner, 2026-11-26, critical): nothing sensitive from the terminal reaches the room.
// Evaluated adversarially in 3 passes — coverage, false positives, robustness — and hardened accordingly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, REDACTED } from './redact.mjs'

const has = (s) => s.includes(REDACTED)
const gone = (s, secret) => !s.includes(secret)
const r = redactSecrets

// ── Coverage: every secret shape is masked, the surrounding label kept ──

test('env-var and connection-string passwords are masked, labels kept', () => {
  for (const [cmd, secret] of [
    ['PGPASSWORD=S3cr3t! psql -h db -U admin', 'S3cr3t!'],
    ['MYSQL_PWD=hunter2 mysql', 'hunter2'],
    ['export CLIENT_SECRET=abc123def', 'abc123def'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'wJalrXUtnFEMI/K7MDENG'],
    ['psql "Host=db;Username=sa;Password=Tr0ub4dour;SSL=true"', 'Tr0ub4dour'],
    ['AccountName=x;AccountKey=Zm9vYmFyYmF6cXV4==;', 'Zm9vYmFyYmF6cXV4=='],
    ['openssl --passphrase TopSecretPhrase', 'TopSecretPhrase'],
  ]) {
    const out = r(cmd)
    assert.ok(gone(out, secret), `leaked in: ${out}`)
    assert.ok(has(out), `no mask in: ${out}`)
  }
  const cs = r('Host=db;Username=sa;Password=Tr0ub4dour;SSL=true')
  assert.ok(cs.includes('Host=db') && cs.includes('Username=sa') && cs.includes('SSL=true'))
  assert.ok(gone(cs, 'Tr0ub4dour'))
})

test('JSON and quoted keys are masked (the value, not the whole object)', () => {
  const j = r('{"db_password": "secret123", "user": "admin"}')
  assert.ok(gone(j, 'secret123') && j.includes('"user"') && j.includes('admin'))
  assert.ok(gone(r("'apiKey' = 'AKIAsecretVALUE1'"), 'AKIAsecretVALUE1'))
})

test('CLI flags (incl. nuget/PowerShell/dashed-prefix) mask their argument', () => {
  for (const [cmd, secret] of [
    ['dotnet nuget add source https://f -u me --password myNugetPass', 'myNugetPass'],
    ['dotnet nuget push pkg.nupkg --api-key oy2abcdefKEY', 'oy2abcdefKEY'],
    ['dotnet nuget push pkg.nupkg -k oy2shortKEYVAL -s feed', 'oy2shortKEYVAL'],
    ['Connect -Password "P@ss w0rd" -Server db', 'P@ss w0rd'],
    ['wget --http-password hunter2 http://x', 'hunter2'],
    ['tool --token=ghYMX_abc123 run', 'ghYMX_abc123'],
    ['nuget setApiKey MY-SECRET-KEY -Source feed', 'MY-SECRET-KEY'],
    ['sshpass -p MyRootPass ssh root@host', 'MyRootPass'],
  ]) {
    const out = r(cmd)
    assert.ok(gone(out, secret), `leaked in: ${out}`)
    assert.ok(has(out), `no mask in: ${out}`)
  }
})

test('URL credentials, basic auth and auth headers are masked', () => {
  const u = r('git clone https://user:gh_tokenValue123@github.com/x/y.git')
  assert.ok(gone(u, 'gh_tokenValue123') && u.includes('user') && u.includes('github.com'))
  const basic = r('curl -u admin:S3cretPass https://api')
  assert.ok(gone(basic, 'S3cretPass') && basic.includes('admin'))
  const basicLong = r('curl --user admin:OtherPass https://api')
  assert.ok(gone(basicLong, 'OtherPass') && basicLong.includes('admin'))
  const h = r('curl -H "Authorization: Bearer eyJhbGc.payload.sig" https://api')
  assert.ok(gone(h, 'eyJhbGc.payload.sig'))
})

test('token shapes are masked wherever they appear', () => {
  for (const secret of [
    'rany_persona_abcDEF123456',
    'ghp_0123456789abcdefghijABCDEFGHIJ0123456789',
    'github_pat_11ABCDEFG0abcdefghijkl',
    'xoxb-123456789012-abcdefABCDEF',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'sk_live_abcdEFGH1234567890',
    'whsec_abcdEFGH1234567890',
    'sk-ant-api03-abcdefghijklmnop',
    'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'SG.abcdefghijklmnop.qrstuvwxyz0123456789ABCDEF',
    'AKIAIOSFODNN7EXAMPLE',
  ]) {
    const out = r(`value here ${secret} trailing`)
    assert.ok(gone(out, secret), `leaked: ${out}`)
  }
  assert.ok(gone(r('url=https://hooks.slack.com/services/T00/B00/XXXXsecretXXXX'), 'XXXXsecretXXXX'))
})

test('a PEM private key block is masked even when truncated (Screen clips output)', () => {
  assert.ok(gone(r('-----BEGIN RSA PRIVATE KEY-----\nMIIExyz\nabc\n-----END RSA PRIVATE KEY-----'), 'MIIExyz'))
  assert.ok(gone(r('-----BEGIN OPENSSH PRIVATE KEY-----\nMIIsecretBODY\nmoremore'), 'MIIsecretBODY')) // no END
})

// ── False positives: ordinary command text must survive untouched ──

test('ordinary command text is NOT mangled (shas, ambiguous flags, paths, prose)', () => {
  for (const safe of [
    'ssh -p 22 deploy@host',
    'git log -p --oneline 3e596538',
    'curl -k https://self-signed.local',
    'kubectl get pods -n prod -o yaml',
    'curl --user-agent "Mozilla/5.0" https://x',
    'dotnet run --project src/Rany.Core.Api --token-file ./t.txt',
    'rg "password" src/ && echo done',
    'npm run build && node test/test-manifest.mjs',
    'git commit -m "fix: parser, see token handling"',
    'psql -h db -p 5432 -U reader',
    'scp file.txt user@host:/path',
  ]) {
    assert.equal(r(safe), safe, `mangled: ${safe}`)
  }
})

test('KNOWN LIMITATION: a bare -k/-p outside nuget/sshpass is NOT masked (would break ssh -p 22 / git log -p)', () => {
  // Pinned so the trade-off is deliberate: use a long flag (--api-key / --password) or an env var for secrets.
  const out = r('somecli run -k oy2shortKey')
  assert.ok(out.includes('oy2shortKey'), 'if this starts masking, revisit the false-positive trade-off')
})

// ── Robustness ──

test('non-strings pass through; redaction is idempotent', () => {
  assert.equal(r(null), null)
  assert.equal(r(undefined), undefined)
  assert.equal(r(123), 123)
  assert.equal(r(''), '')
  const once = r('PGPASSWORD=abc psql; token: eyJaaaaaa.bbbbbb.cccccc; https://u:p@h')
  assert.equal(r(once), once)
})

test('pathological input finishes fast (no catastrophic backtracking)', () => {
  const t = Date.now()
  for (const inp of ['-'.repeat(5000), '"'.repeat(5000), 'password='.repeat(2000), ('a-_.'.repeat(4000) + 'password=x')])
    r(inp)
  assert.ok(Date.now() - t < 2000, 'redaction too slow on adversarial input')
})

test('a multiline Screen frame masks every secret and keeps the normal lines', () => {
  const frame = '› run deploy\n  PGPASSWORD=s3cr3t pg_dump\n  AccountKey=Zm9v==;\n  normal output line 42'
  const out = r(frame)
  assert.ok(gone(out, 's3cr3t') && gone(out, 'Zm9v=='))
  assert.ok(out.includes('normal output line 42') && out.includes('run deploy'))
})
