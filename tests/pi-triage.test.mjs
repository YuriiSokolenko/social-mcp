import fs from "node:fs";
import { readScript } from './helpers/resolved-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalText, triageFromJsonl, validateTriage } from '../scripts/pi-triage.mjs';
import { acceptanceCriteria } from '../scripts/pi-common/task-metadata.mjs';

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

test('rejects text-only TRIAGE_RESULT markers without submit_result', () => {
  const final = { ready: [3], needs_human: [], skipped: [] };
  const jsonl = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
    content: [{ type: 'text', text: `TRIAGE_RESULT: ${JSON.stringify(final)}` }] }] });
  assert.throws(() => triageFromJsonl(jsonl), /expected submit_result tool output/);
});

test('rejects a run with neither text nor submit_result', () => {
  const jsonl = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
    content: [{ type: 'text', text: 'Nothing to report.' }] }] });
  assert.throws(() => triageFromJsonl(jsonl), /expected submit_result tool output/);
});

test('finalText uses the last non-empty assistant message across agent_end events', () => {
  const jsonl = [
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'first' }] }] }),
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'second' }] }] }),
  ].join('\n');
  assert.equal(finalText(jsonl), 'second');
});


test('triage no longer depends on deleted task files', () => {
  const source = readScript('scripts/pi-triage.mjs', 'utf8');
  assert.doesNotMatch(source, /readTask\s*\(/);
  assert.match(source, /taskMetadata\(issue, \{ required: false \}\)/);
});


test('acceptance criteria require a Markdown section with 3-15 list items', () => {
  assert.equal(acceptanceCriteria('## Acceptance criteria\n- A\n- B\n- C\n').valid, true);
  assert.equal(acceptanceCriteria('Acceptance criteria:\n- A\n- B\n- C\n').valid, false);
  assert.equal(acceptanceCriteria('## Acceptance criteria\n- A\n- B\n').valid, false);
  const sixteen = Array.from({ length: 16 }, (_, i) => `- AC ${i + 1}`).join('\n');
  assert.equal(acceptanceCriteria(`## Acceptance criteria\n${sixteen}\n`).valid, false);
});
