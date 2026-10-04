import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewResult, validateReviewResult } from '../scripts/pi-review-result.mjs';

const line = (event) => JSON.stringify(event);
const evidence = [{
  criterion: 'Reject boolean cache capacity',
  status: 'ESTABLISHED',
  evidence: ['Constructor rejects bool before accepting int values.'],
}];

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

test('prefers a submit_result tool entry and renders structured acceptance evidence', () => {
  const events = [
    { type: 'entry_appended', entry: { type: 'custom', customType: 'review-result',
      data: { verdict: 'PASS', text: 'Verified behavior against the linked issue.', criteria_evidence: evidence } } },
    { type: 'agent_end', messages: [{ role: 'assistant', content: [
      { type: 'text', text: 'REVIEW_RESULT: CHANGES_REQUESTED\nStale text that should be ignored.' },
    ] }] },
  ];
  assert.deepEqual(parseReviewResult(events.map(line).join('\n')), {
    verdict: 'PASS',
    text: [
      'REVIEW_RESULT: PASS',
      '',
      'Verified behavior against the linked issue.',
      '',
      'Acceptance evidence:',
      '- [ESTABLISHED] Reject boolean cache capacity: Constructor rejects bool before accepting int values.',
    ].join('\n'),
    criteria_evidence: evidence,
  });
});

test('rejects a review result without structured criterion evidence', () => {
  assert.throws(
    () => validateReviewResult({ verdict: 'PASS', text: 'Looks correct.' }),
    /requires structured criteria_evidence/,
  );
});

test('requires an explicit assumption for assumption evidence', () => {
  assert.throws(
    () => validateReviewResult({
      verdict: 'PASS',
      text: 'Policy ambiguity remains explicit.',
      criteria_evidence: [{
        criterion: 'Define the supported numeric domain',
        status: 'ASSUMPTION',
        evidence: ['Issue says numeric without naming Decimal or Fraction.'],
      }],
    }),
    /requires an explicit assumption/,
  );

  assert.deepEqual(
    validateReviewResult({
      verdict: 'PASS',
      text: 'Policy ambiguity remains explicit.',
      criteria_evidence: [{
        criterion: 'Define the supported numeric domain',
        status: 'ASSUMPTION',
        evidence: ['Issue says numeric without naming Decimal or Fraction.'],
        assumption: 'Treat numbers.Real plus Decimal as the intended ordered numeric domain.',
      }],
    }).criteria_evidence[0],
    {
      criterion: 'Define the supported numeric domain',
      status: 'ASSUMPTION',
      evidence: ['Issue says numeric without naming Decimal or Fraction.'],
      assumption: 'Treat numbers.Real plus Decimal as the intended ordered numeric domain.',
    },
  );
});
