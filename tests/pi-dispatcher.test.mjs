import test from 'node:test';
import assert from 'node:assert/strict';
import { classificationLists, dispatchFromJsonl, finalText, validateDispatch } from '../scripts/pi-dispatcher.mjs';

test('accepts binary classifications and derives handoff lists', () => {
  const result = { classifications: [
    { issue: 3, decision: 'IMPLEMENT' },
    { issue: 4, decision: 'IMPLEMENT' },
    { issue: 5, decision: 'ARCHITECT' },
  ] };
  assert.equal(validateDispatch(result), result);
  assert.deepEqual(classificationLists(result), { issues: [3, 4], architect: [5] });
});

test('rejects duplicate issue classifications', () => {
  assert.throws(() => validateDispatch({ classifications: [
    { issue: 3, decision: 'IMPLEMENT' }, { issue: 3, decision: 'ARCHITECT' },
  ] }), /duplicate issue/);
});

test('rejects an invalid decision or non-integer issue', () => {
  assert.throws(() => validateDispatch({ classifications: [{ issue: 3.5, decision: 'IMPLEMENT' }] }), /invalid dispatcher classifications/);
  assert.throws(() => validateDispatch({ classifications: [{ issue: 3, decision: 'SKIP' }] }), /invalid dispatcher classifications/);
});

test('prefers a submit_result tool entry over any DISPATCH_RESULT text line', () => {
  const result = { classifications: [{ issue: 3, decision: 'IMPLEMENT' }] };
  const stale = { classifications: [{ issue: 4, decision: 'IMPLEMENT' }] };
  const jsonl = [
    JSON.stringify({ type: 'entry_appended', entry: { type: 'custom', customType: 'dispatcher-result', data: result } }),
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
      content: [{ type: 'text', text: `DISPATCH_RESULT: ${JSON.stringify(stale)}` }] }] }),
  ].join('\n');
  assert.deepEqual(dispatchFromJsonl(jsonl), result);
});

test('uses the last DISPATCH_RESULT line when the model second-guesses itself mid-response', () => {
  const draft = { classifications: [{ issue: 4, decision: 'IMPLEMENT' }] };
  const final = { classifications: [{ issue: 3, decision: 'IMPLEMENT' }] };
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
