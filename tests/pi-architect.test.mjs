import test from 'node:test';
import assert from 'node:assert/strict';
import { childNumbers, parentOf, planFromJsonl, taskMetadataFromBody, validatePlan, withTaskMetadata } from '../scripts/pi-architect.mjs';

const body = '## Goal\nSpecify the shared contract.\n\n## Acceptance criteria\n- Define the stable schema.\n- Cover compatibility with focused tests.\n- Keep the contract independently reviewable.\n\n## Out of scope\nNo business logic.';
const step = (key, kind, depends_on = []) => ({
  key, kind, priority: 'P1', title: `Complete the ${key} part of issue 42`, body, depends_on,
});

test('accepts ordered, independently mergeable contract, test and implementation', () => {
  const plan = { parent_issue: 42, steps: [
    step('contract', 'contract'), step('tests', 'test', ['contract']),
    step('feature', 'implementation', ['tests']),
  ] };
  assert.equal(validatePlan(plan, 42), plan);
  const jsonl = JSON.stringify({ type: 'entry_appended',
    entry: { type: 'custom', customType: 'architect-result', data: plan } });
  assert.deepEqual(planFromJsonl(jsonl, 42), plan);
});

test('can split a contract-only child without inventing an implementation', () => {
  const plan = { parent_issue: 42, steps: [
    step('schema', 'contract'), step('compatibility', 'contract', ['schema']),
  ] };
  assert.equal(validatePlan(plan, 42), plan);
});

test('prefers a submit_result tool entry over any ARCHITECT_RESULT text line', () => {
  const keep = { parent_issue: 42, action: 'keep', reason: 'The task is already bounded and its dependencies are correct.' };
  const stale = { parent_issue: 42, action: 'keep', reason: 'A stale text line that should be ignored once a tool result exists.' };
  const jsonl = [
    JSON.stringify({ type: 'entry_appended', entry: { type: 'custom', customType: 'architect-result', data: keep } }),
    JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
      content: [{ type: 'text', text: `ARCHITECT_RESULT: ${JSON.stringify(stale)}` }] }] }),
  ].join('\n');
  assert.deepEqual(planFromJsonl(jsonl, 42), keep);
});

test('rejects text-only ARCHITECT_RESULT markers without submit_result', () => {
  const final = { parent_issue: 42, action: 'keep', reason: 'The task is already bounded and its dependencies are correct.' };
  const jsonl = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
    content: [{ type: 'text', text: `ARCHITECT_RESULT: ${JSON.stringify(final)}` }] }] });
  assert.throws(() => planFromJsonl(jsonl, 42), /Expected submit_result tool output/);
});

test('accepts review decisions without forcing unnecessary child issues', () => {
  const keep = { parent_issue: 42, action: 'keep', reason: 'The task is already bounded and its dependencies are correct.' };
  const revise = { parent_issue: 42, action: 'revise',
    reason: 'The original issue still includes work that was already completed.',
    title: 'Implement the remaining account profile read behavior', body,
    priority: 'P1', depends_on: [14, 18] };
  assert.equal(validatePlan(keep, 42), keep);
  assert.equal(validatePlan(revise, 42), revise);
  assert.throws(() => validatePlan({ ...revise, depends_on: [42] }, 42));
  assert.throws(() => validatePlan({ ...revise, body: `${body}\n<!-- architect-parent:1; architect-key:x -->` }, 42));
  const jsonl = JSON.stringify({ type: 'entry_appended',
    entry: { type: 'custom', customType: 'architect-result', data: keep } });
  assert.deepEqual(planFromJsonl(jsonl, 42), keep);
});

test('rejects forward dependencies, duplicate keys and missing test dependency', () => {
  assert.throws(() => validatePlan({ parent_issue: 42, steps: [step('feature', 'implementation', ['later']), step('later', 'implementation')] }, 42));
  assert.throws(() => validatePlan({ parent_issue: 42, steps: [step('feature', 'implementation'), step('feature', 'implementation')] }, 42));
  assert.throws(() => validatePlan({ parent_issue: 42, steps: [step('tests', 'test'), step('feature', 'implementation')] }, 42));
});

test('only explicit architect markers link parent and child issues', () => {
  assert.equal(parentOf('Part of #42.\n<!-- architect-parent:42; architect-key:tests -->'), 42);
  assert.deepEqual(childNumbers('<!-- architect-children:61,62 -->'), [61, 62]);
  assert.equal(parentOf('Part of #42.'), null);
  assert.deepEqual(childNumbers('No children'), []);
});


test('reads architect metadata from canonical issue body header', () => {
  assert.deepEqual(taskMetadataFromBody(42, '## Task metadata\nPriority: P0\nDepends on: [#14, #18]\n\n## Goal\nX'),
    { priority: 'P0', dependencies: [14, 18] });
});


test('rewrites Task metadata without consuming issue content', () => {
  assert.equal(
    withTaskMetadata('## Task metadata\nPriority: P2\nDepends on: []\n\n## Goal\nKeep this.', 'P0', [12]),
    '## Task metadata\nPriority: P0\nDepends on: [#12]\n\n## Goal\nKeep this.',
  );
  assert.equal(
    withTaskMetadata('## Task metadata\nPriority: P2\nDepends on: []\n', 'P1', [7, 8]),
    '## Task metadata\nPriority: P1\nDepends on: [#7, #8]\n\n',
  );
});


test('architect rejects revised or child issue bodies outside the 3-15 AC range', () => {
  const tooFew = '## Goal\nX\n\n## Acceptance criteria\n- One\n- Two\n\n## Out of scope\nNone';
  const revise = { parent_issue: 42, action: 'revise', reason: 'The issue needs a clearer specification before implementation.',
    title: 'Implement the remaining account profile behavior', body: tooFew, priority: 'P1', depends_on: [] };
  assert.throws(() => validatePlan(revise, 42), /Invalid revised issue/);
  assert.throws(() => validatePlan({ parent_issue: 42, steps: [
    { key: 'a', kind: 'implementation', priority: 'P1', title: 'Implement the first bounded feature',
      body: tooFew, depends_on: [] },
    { key: 'b', kind: 'implementation', priority: 'P1', title: 'Implement the second bounded feature',
      body, depends_on: [] },
  ] }, 42), /Invalid step metadata/);
});
