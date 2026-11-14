import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, secretValuesOf, describeTranscript, REDACTED } from './session-archive.mjs'

test('secret-looking environment values are masked wherever they appear', () => {
  const env = { RANY_PERSONA_TOKEN: 'abcdef0123456789abcd', DB_PASSWORD: 'hunter2hunter2', HOME: '/home/x', PATH: 'a:b' }
  assert.deepEqual(secretValuesOf(env).sort(), ['abcdef0123456789abcd', 'hunter2hunter2'].sort())
  const { text, count } = redact('{"cmd":"echo abcdef0123456789abcd && psql hunter2hunter2"}', { env })
  assert.equal(text, `{"cmd":"echo ${REDACTED} && psql ${REDACTED}"}`)
  assert.equal(count, 2)
})

test('known token shapes are masked and the line stays valid JSON', () => {
  const line = JSON.stringify({
    out: 'token rany_persona_ab3dae60d099762ee49acaf70af6ac6423ed048f key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA '
      + 'aws AKIAABCDEFGHIJKLMNOP gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  })
  const { text, count } = redact(line)
  assert.equal(count, 4)
  assert.doesNotMatch(text, /ab3dae60|AAAAAAAAAAAAAAAA|ABCDEFGHIJKLMNOP|ghp_abcdef/)
  assert.doesNotThrow(() => JSON.parse(text))
})

test('headers, connection strings, URL credentials and secret-named pairs are masked', () => {
  const src = [
    'curl -H "Authorization: Bearer eyJhbGciOi.abc.def" https://x',
    'Host=db.example;Username=app;Password=s3cretpass;Database=app',
    'git clone https://bob:pa55word@gitlab.example/x.git',
    'export OPENAI_API_KEY=sk_live_value_123456',
    '{\\"SecretKey\\": \\"wJalrXUtnFEMI/K7MDENG\\", \\"Region\\": \\"eu-central-1\\"}',
  ].join('\n')
  const { text, count } = redact(src)
  assert.equal(count, 5)
  for (const leaked of ['eyJhbGciOi', 's3cretpass', 'pa55word', 'sk_live_value', 'wJalrXUtnFEMI']) assert.doesNotMatch(text, new RegExp(leaked))
  assert.match(text, /eu-central-1/)
  assert.match(text, /Username=app/)
})

test('ordinary transcript text is left alone', () => {
  const src = '{"type":"assistant","usage":{"input_tokens":1234,"output_tokens":56},"text":"the password field is required"}'
  assert.deepEqual(redact(src), { text: src, count: 0 })
})

test('the title is the first prompt a person typed; times span the transcript', () => {
  const jsonl = [
    { type: 'user', timestamp: '2026-11-13T10:00:00Z', message: { content: '<command-name>/rany-rejoin</command-name>' } },
    { type: 'user', timestamp: '2026-11-13T10:01:00Z', isMeta: true, message: { content: 'meta' } },
    { type: 'user', timestamp: '2026-11-13T10:02:00Z', message: { content: [{ type: 'text', text: '  fix the   login bug ' }] } },
    { type: 'assistant', timestamp: '2026-11-13T11:00:00Z', message: { content: 'ok' } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n'
  assert.deepEqual(describeTranscript(jsonl),
    { title: 'fix the login bug', startedAt: '2026-11-13T10:00:00Z', endedAt: '2026-11-13T11:00:00Z' })
})
