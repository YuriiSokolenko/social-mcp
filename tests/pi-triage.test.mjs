import test from 'node:test';
import assert from 'node:assert/strict';
import { finalText, triageFromJsonl, validateTriage } from '../scripts/pi-triage.mjs';

const needsHuman = (issue, comment = 'This issue is missing an acceptance criteria section entirely.') => ({ issue, comment });
const skipped = (issue, reason = 'lacks enough repository context to judge safely') => ({ issue, reason });

test('accepts a classification covering ready, needs_human and skipped disjointly', () => {
  const result = { ready: [3], needs_human: [needsHuman(4)], skipped: [skipped(5)] };
  assert.equal(validateTriage(result), result);
});

test('rejects an issue classified into two buckets', () => {
  const result = { ready: [3], needs_human: [needsHuman(3)], skipped: [] };
  assert.throws(() => validateTriage(result), /duplicate issue classification/);
});

test('rejects a needs_human comment that is too short', () => {
  const result = { ready: [], needs_human: [needsHuman(3, 'too short')], skipped: [] };
  assert.throws(() => validateTriage(result), /invalid needs_human list/);
});

test('rejects a skipped entry with an empty reason', () => {
  const result = { ready: [], needs_human: [], skipped: [skipped(3, '')] };
  assert.throws(() => validateTriage(result), /invalid skipped list/);
});

test('prefers a submit_result tool entry over any TRIAGE_RESULT text line', () => {
  const result = { ready: [3], needs_human: [], skipped: [] };
  const stale = { ready: [4], needs_human: [], skipped: [] };
  const jsonl = [
    JSON.stringify({ type: 'entry_appended', entry: { type: 'custom', customType: 'triage-result', data: result } }),
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
      content: [{ type: 'text', text: `TRIAGE_RESULT: ${JSON.stringify(stale)}` }] }] }),
  ].join('\n');
  assert.deepEqual(triageFromJsonl(jsonl), result);
});

test('uses the last TRIAGE_RESULT line when the model second-guesses itself mid-response', () => {
  const draft = { ready: [4], needs_human: [], skipped: [] };
  const final = { ready: [3], needs_human: [], skipped: [] };
  const jsonl = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
    content: [{ type: 'text', text: `TRIAGE_RESULT: ${JSON.stringify(draft)}\nOn reflection:\nTRIAGE_RESULT: ${JSON.stringify(final)}` }] }] });
  assert.deepEqual(triageFromJsonl(jsonl), final);
});

test('rejects a run with no TRIAGE_RESULT line and no tool entry', () => {
  const jsonl = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
    content: [{ type: 'text', text: 'Nothing to report.' }] }] });
  assert.throws(() => triageFromJsonl(jsonl), /expected a TRIAGE_RESULT line/);
});

test('finalText uses the last non-empty assistant message across agent_end events', () => {
  const jsonl = [
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'first' }] }] }),
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'second' }] }] }),
  ].join('\n');
  assert.equal(finalText(jsonl), 'second');
});
