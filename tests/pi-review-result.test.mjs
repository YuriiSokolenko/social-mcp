import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewResult } from '../scripts/pi-review-result.mjs';

const line = (event) => JSON.stringify(event);

test('rejects text-only REVIEW_RESULT output even when syntactically valid', () => {
  for (const text of [
    'REVIEW_RESULT: PASS\nChecks passed.',
    'I reviewed the diff.\n## REVIEW_RESULT: PASS\nAll checks passed.',
    'REVIEW_RESULT: PASS\nREVIEW_RESULT: PASS',
  ]) {
    const events = [{ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] }];
    assert.throws(() => parseReviewResult(events.map(line).join('\n')), /did not call submit_result/);
  }
});

test('prefers a submit_result tool entry over any REVIEW_RESULT text line, and reconstructs the marker line pi-pr-fix.yml scans for', () => {
  const events = [
    { type: 'entry_appended', entry: { type: 'custom', customType: 'review-result',
      data: { verdict: 'PASS', text: 'Verified tests and behavior against the linked issue.' } } },
    { type: 'agent_end', messages: [{ role: 'assistant', content: [
      { type: 'text', text: 'REVIEW_RESULT: CHANGES_REQUESTED\nStale text that should be ignored.' },
    ] }] },
  ];
  assert.deepEqual(parseReviewResult(events.map(line).join('\n')), {
    verdict: 'PASS',
    text: 'REVIEW_RESULT: PASS\n\nVerified tests and behavior against the linked issue.',
  });
});
