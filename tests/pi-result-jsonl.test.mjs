import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantText, readPiJsonl } from '../scripts/pi-common/result-jsonl.mjs';

const line = event => JSON.stringify(event);

test('assistantText joins only assistant text parts', () => {
  assert.equal(assistantText({ role: 'assistant', content: [
    { type: 'text', text: 'a' }, { type: 'toolCall', name: 'bash' }, { type: 'text', text: 'b' },
  ] }), 'ab');
  assert.equal(assistantText({ role: 'user', content: [{ type: 'text', text: 'ignored' }] }), '');
});

test('ignores malformed JSONL and keeps the last completed assistant message', () => {
  const jsonl = ['not json', line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: ' first ' }] } }),
    line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: ' final ' }] } })].join('\n');
  assert.equal(readPiJsonl(jsonl).finalText, 'final');
});

test('empty agent_end preserves the immediately completed message_end', () => {
  const jsonl = [line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    line({ type: 'agent_end', messages: [] })].join('\n');
  assert.equal(readPiJsonl(jsonl).finalText, 'done');
});

test('non-empty agent_end is authoritative and a tool-only assistant clears stale text', () => {
  const jsonl = [line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'quoted result' }] } }),
    line({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] }] })].join('\n');
  assert.equal(readPiJsonl(jsonl).finalText, '');
});

test('uses the last matching structured result entry', () => {
  const jsonl = [line({ type: 'entry_appended', entry: { type: 'custom', customType: 'x', data: { n: 1 } } }),
    line({ type: 'entry_appended', entry: { type: 'custom', customType: 'other', data: { n: 9 } } }),
    line({ type: 'entry_appended', entry: { type: 'custom', customType: 'x', data: { n: 2 } } })].join('\n');
  assert.deepEqual(readPiJsonl(jsonl, { customType: 'x' }).customResult, { n: 2 });
});
