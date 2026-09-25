import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewResult } from '../scripts/pi-review-result.mjs';

const line = (event) => JSON.stringify(event);

test('uses the completed assistant message when agent_end has no messages', () => {
  const events = [
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'REVIEW_RESULT: PASS\nChecks passed.' }] } },
    { type: 'agent_end', messages: [] },
  ];
  assert.deepEqual(parseReviewResult(events.map(line).join('\n')),
    { verdict: 'PASS', text: 'REVIEW_RESULT: PASS\nChecks passed.' });
});

test('does not accept a quoted verdict from a non-final assistant turn', () => {
  const events = [
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'REVIEW_RESULT: PASS' }] } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] } },
    { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] }] },
  ];
  assert.throws(() => parseReviewResult(events.map(line).join('\n')), /did not produce/);
});

test('accepts one verdict after evidence in the final response', () => {
  const events = [{ type: 'agent_end', messages: [{ role: 'assistant', content: [
    { type: 'text', text: 'I reviewed the diff and tests.\n## REVIEW_RESULT: PASS\nAll checks passed.' },
  ] }] }];
  assert.equal(parseReviewResult(events.map(line).join('\n')).verdict, 'PASS');
});

test('rejects missing or conflicting verdicts in the final response', () => {
  for (const text of ['Review passed.', 'REVIEW_RESULT: PASS\nREVIEW_RESULT: CHANGES_REQUESTED']) {
    const events = [{ type: 'agent_end', messages: [{ role: 'assistant', content: [
      { type: 'text', text },
    ] }] }];
    assert.throws(() => parseReviewResult(events.map(line).join('\n')), /exactly one/);
  }
});
