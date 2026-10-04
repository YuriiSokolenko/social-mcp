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

test('PASS requires structured criterion evidence', () => {
  assert.throws(
    () => validateReviewResult({ verdict: 'PASS', text: 'Looks correct.' }),
    /PASS review result requires structured criteria_evidence/,
  );
});

test('CHANGES_REQUESTED can omit criterion evidence for a non-criterion blocker', () => {
  assert.deepEqual(
    validateReviewResult({
      verdict: 'CHANGES_REQUESTED',
      text: 'The PR contains an unrelated generated artifact that must be removed.',
    }),
    {
      verdict: 'CHANGES_REQUESTED',
      text: 'The PR contains an unrelated generated artifact that must be removed.',
      criteria_evidence: [],
    },
  );
});

test('requires an explicit assumption only for ASSUMPTION evidence', () => {
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

test('ignores an accidental assumption field on ESTABLISHED evidence', () => {
  assert.deepEqual(
    validateReviewResult({
      verdict: 'PASS',
      text: 'Behavior is established.',
      criteria_evidence: [{
        ...evidence[0],
        assumption: 'Extraneous model field.',
      }],
    }).criteria_evidence[0],
    evidence[0],
  );
});

test('enforces evidence item and criterion count limits in runtime validation', () => {
  assert.throws(
    () => validateReviewResult({
      verdict: 'PASS',
      text: 'Too much evidence in one criterion.',
      criteria_evidence: [{
        criterion: 'One criterion',
        status: 'ESTABLISHED',
        evidence: ['1', '2', '3', '4', '5'],
      }],
    }),
    /invalid review criterion evidence/,
  );

  assert.throws(
    () => validateReviewResult({
      verdict: 'PASS',
      text: 'Too many criteria.',
      criteria_evidence: Array.from({ length: 31 }, (_, index) => ({
        criterion: `Criterion ${index}`,
        status: 'ESTABLISHED',
        evidence: ['Concrete evidence.'],
      })),
    }),
    /invalid structured criteria_evidence/,
  );
});

test('rejects a rendered review comment that exceeds the GitHub-safe bound', () => {
  assert.throws(
    () => validateReviewResult({
      verdict: 'PASS',
      text: 'x'.repeat(59000),
      criteria_evidence: [{
        criterion: 'A'.repeat(500),
        status: 'ESTABLISHED',
        evidence: ['B'.repeat(1000)],
      }],
    }),
    /exceeds 60000 rendered characters/,
  );
});
