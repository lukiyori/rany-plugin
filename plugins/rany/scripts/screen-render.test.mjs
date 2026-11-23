import { test } from 'node:test'
import assert from 'node:assert/strict'
import { screenLines } from './screen-render.mjs'

const plain = (s) => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
const ts = '2026-11-23T12:30:05.000Z'

test('what the owner typed is a › line; tag-wrapped plumbing is not shown', () => {
  assert.equal(plain(screenLines({ type: 'user', timestamp: ts, message: { content: 'fix the\nbuild' } })),
    '12:30:05 › fix the ⏎ build')
  assert.equal(screenLines({ type: 'user', timestamp: ts, message: { content: '<command-name>/clear</command-name>' } }), null)
  assert.equal(screenLines({ type: 'user', isMeta: true, timestamp: ts, message: { content: 'hidden' } }), null)
})

test('a command shows, and its output follows when the result arrives', () => {
  const state = {}
  const call = screenLines({ type: 'assistant', timestamp: ts, cwd: 'E:\\repo', message: { content: [
    { type: 'thinking', thinking: 'not shown' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm   run build' } },
  ] } }, state)
  assert.equal(plain(call), '12:30:05 $ npm run build')
  const result = screenLines({ type: 'user', timestamp: ts, message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'ok\nbuilt in 5s' },
  ] } }, state)
  assert.match(plain(result), /^ {9}ok\r\n {9}built in 5s$/)
})

test('a read shows only the path, relative to the session directory; its content is not shown', () => {
  const state = {}
  const call = screenLines({ type: 'assistant', timestamp: ts, cwd: 'E:\\repo', message: { content: [
    { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'E:\\repo\\src\\a.ts' } },
  ] } }, state)
  assert.equal(plain(call), '12:30:05 read src/a.ts')
  assert.equal(screenLines({ type: 'user', timestamp: ts, message: { content: [
    { type: 'tool_result', tool_use_id: 'r1', content: 'the whole file' },
  ] } }, state), null)
})

test('an edit, an MCP tool and a failed call', () => {
  const state = {}
  const out = plain(screenLines({ type: 'assistant', timestamp: ts, cwd: '/r', message: { content: [
    { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/r/web/x.tsx' } },
    { type: 'tool_use', id: 'm1', name: 'mcp__plugin_rany_rany__post_message', input: { channelId: '1' } },
  ] } }, state))
  assert.equal(out, '12:30:05 ✎ edit web/x.tsx\r\n12:30:05 ⚙ rany post_message {"channelId":"1"}')
  const err = plain(screenLines({ type: 'user', timestamp: ts, message: { content: [
    { type: 'tool_result', tool_use_id: 'e1', is_error: true, content: 'String not found' },
  ] } }, state))
  assert.equal(err, '         ✗ String not found')
})

test('the agent\'s text is shown; a sub-agent\'s own steps are not', () => {
  assert.equal(plain(screenLines({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: 'Done.\nBuild green.' }] } })),
    '12:30:05 Done.\r\n         Build green.')
  assert.equal(screenLines({ type: 'assistant', isSidechain: true, timestamp: ts, message: { content: [{ type: 'text', text: 'x' }] } }), null)
})

test('long output is cut to a few lines', () => {
  const state = {}
  screenLines({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }] } }, state)
  const out = plain(screenLines({ type: 'user', timestamp: ts, message: { content: [
    { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: Array.from({ length: 20 }, (_, i) => `f${i}`).join('\n') }] },
  ] } }, state))
  const lines = out.split('\r\n')
  assert.equal(lines.length, 9)
  assert.equal(lines[8].trim(), '… 12 more lines')
})
