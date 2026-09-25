import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchFromJsonl, finalText, validateDispatch } from '../scripts/pi-dispatcher.mjs';

test('accepts disjoint issue and architect lists', () => {
  const result = { issues: [3, 4], architect: [5] };
  assert.equal(validateDispatch(result), result);
});

test('rejects an issue classified into both lists', () => {
  assert.throws(() => validateDispatch({ issues: [3], architect: [3] }), /duplicate issue/);
});

test('rejects a non-integer entry', () => {
  assert.throws(() => validateDispatch({ issues: [3.5], architect: [] }), /invalid dispatcher classification/);
});

test('prefers a submit_result tool entry over any DISPATCH_RESULT text line', () => {
  const result = { issues: [3], architect: [] };
  const stale = { issues: [4], architect: [] };
  const jsonl = [
    JSON.stringify({ type: 'entry_appended', entry: { type: 'custom', customType: 'dispatcher-result', data: result } }),
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
      content: [{ type: 'text', text: `DISPATCH_RESULT: ${JSON.stringify(stale)}` }] }] }),
  ].join('\n');
  assert.deepEqual(dispatchFromJsonl(jsonl), result);
});

test('uses the last DISPATCH_RESULT line when the model second-guesses itself mid-response', () => {
  const draft = { issues: [4], architect: [] };
  const final = { issues: [3], architect: [] };
  const jsonl = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
    content: [{ type: 'text', text: `DISPATCH_RESULT: ${JSON.stringify(draft)}\nOn reflection:\nDISPATCH_RESULT: ${JSON.stringify(final)}` }] }] });
  assert.deepEqual(dispatchFromJsonl(jsonl), final);
});

test('rejects a run with no DISPATCH_RESULT line and no tool entry', () => {
  const jsonl = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
    content: [{ type: 'text', text: 'I looked around but found nothing to report.' }] }] });
  assert.throws(() => dispatchFromJsonl(jsonl), /expected a DISPATCH_RESULT line/);
});

test('finalText uses the last non-empty assistant message across agent_end events', () => {
  const jsonl = [
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'first' }] }] }),
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'second' }] }] }),
  ].join('\n');
  assert.equal(finalText(jsonl), 'second');
});
