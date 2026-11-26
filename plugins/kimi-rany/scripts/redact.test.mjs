// node --test plugins/rany/scripts/redact.test.mjs
//
// The secret-redaction gate (owner, 2026-11-26, critical): nothing sensitive from the terminal reaches the room.
// Evaluated adversarially in 3 passes — coverage, false positives, robustness — and hardened accordingly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, secretValuesFromEnv, REDACTED } from './redact.mjs'

const has = (s) => s.includes(REDACTED)
const gone = (s, secret) => !s.includes(secret)
const r = redactSecrets

// These probes are DUMMY, non-real values that only need to MATCH the redactor's shapes. They are assembled from
// fragments with `mk` so no contiguous secret-shaped literal (a Google key, a GitHub PAT, a PEM header…) ever sits
// in the source — otherwise GitHub secret scanning flags the test file (it did, for the `AIza…` probe, 2026-11-26).
// The redactor still sees the full joined string at runtime, so coverage is unchanged.
const mk = (...parts) => parts.join('')

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
  const awsKey = mk('AKIA', 'secretVALUE1')
  assert.ok(gone(r(`'apiKey' = '${awsKey}'`), awsKey))
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
  const jwt = mk('eyJ', 'hbGc.payload.sig')
  const h = r(`curl -H "Authorization: Bearer ${jwt}" https://api`)
  assert.ok(gone(h, jwt))
})

test('token shapes are masked wherever they appear', () => {
  for (const secret of [
    mk('rany_persona_', 'abcDEF123456'),
    mk('ghp', '_0123456789abcdefghijABCDEFGHIJ0123456789'),
    mk('github', '_pat_11ABCDEFG0abcdefghijkl'),
    mk('xox', 'b-123456789012-abcdefABCDEF'),
    mk('AIza', 'SyA1234567890abcdefghijklmnopqrstuv'),
    mk('sk_', 'live_abcdEFGH1234567890'),
    mk('whsec', '_abcdEFGH1234567890'),
    mk('sk-', 'ant-api03-abcdefghijklmnop'),
    mk('npm', '_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
    mk('SG', '.abcdefghijklmnop.qrstuvwxyz0123456789ABCDEF'),
    mk('AKIA', 'IOSFODNN7EXAMPLE'),
  ]) {
    const out = r(`value here ${secret} trailing`)
    assert.ok(gone(out, secret), `leaked: ${out}`)
  }
  const slack = mk('https://hooks.slack.com/services/', 'T00/B00/XXXXsecretXXXX')
  assert.ok(gone(r(`url=${slack}`), 'XXXXsecretXXXX'))
})

test('a PEM private key block is masked even when truncated (Screen clips output)', () => {
  assert.ok(gone(r(mk('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIExyz\nabc\n-----END RSA PRIVATE KEY-----')), 'MIIExyz'))
  assert.ok(gone(r(mk('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\nMIIsecretBODY\nmoremore')), 'MIIsecretBODY')) // no END
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
  const once = r(mk('PGPASSWORD=abc psql; token: eyJ', 'aaaaaa.bbbbbb.cccccc; https://u:p@h'))
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

// ── Known-value masking: mask the actual secret VALUES we hold, whatever shape they take ──

test('secretValuesFromEnv collects values of sensitively-named vars only, long enough', () => {
  const vals = secretValuesFromEnv({
    DB_PASSWORD: 'Tr0ub4dour',
    MY_API_KEY: 'abcdef123456',
    GITHUB_TOKEN: 'ghtokvalue9',
    PATH: '/usr/bin:/bin',        // not sensitive → never collected (would mangle everything)
    HOME: '/home/agent',          // not sensitive
    SHORT_SECRET: 'abc',          // sensitive name but < 6 chars → skipped (too word-like)
    LANG: 'en_US.UTF-8',
  })
  assert.ok(vals.includes('Tr0ub4dour') && vals.includes('abcdef123456') && vals.includes('ghtokvalue9'))
  assert.ok(!vals.includes('/usr/bin:/bin') && !vals.includes('/home/agent') && !vals.includes('abc'))
  // longest first, so a value containing a shorter one is masked whole first
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i - 1].length >= vals[i].length)
})

test('redactSecrets masks a known value in ANY shape, even one no pattern recognises', () => {
  const secret = 'Zx9-quux-plain-nonpattern-value'   // no recognisable token shape, no sensitive key around it
  assert.equal(r(`the setting is ${secret} now`), `the setting is ${secret} now`) // unknown by shape → survives
  const out = r(`the setting is ${secret} now`, { values: [secret] })             // known by value → masked
  assert.ok(gone(out, secret) && has(out) && out.includes('the setting is') && out.includes('now'))
})

test('known-value masking is idempotent and leaves ordinary text alone', () => {
  const vals = ['SuperSecretValue123']
  const once = r('key is SuperSecretValue123', { values: vals })
  assert.equal(r(once, { values: vals }), once)
  assert.equal(r('nothing to hide here', { values: vals }), 'nothing to hide here')
  // empty/garbage value lists never throw or over-mask
  assert.equal(r('plain text', { values: ['', null, undefined] }), 'plain text')
})
