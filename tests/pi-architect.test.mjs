import test from 'node:test';
import assert from 'node:assert/strict';
import { childNumbers, parentOf, planFromJsonl, validatePlan } from '../scripts/pi-architect.mjs';

const body = '## Goal\nSpecify the shared contract.\n\n## Acceptance criteria\nDefine the stable schema and cover compatibility with focused tests.\n\n## Out of scope\nNo business logic.';
const step = (key, kind, depends_on = []) => ({
  key, kind, priority: 'P1', title: `Complete the ${key} part of issue 42`, body, depends_on,
});

test('accepts ordered, independently mergeable contract, test and implementation', () => {
  const plan = { parent_issue: 42, steps: [
    step('contract', 'contract'), step('tests', 'test', ['contract']),
    step('feature', 'implementation', ['tests']),
  ] };
  assert.equal(validatePlan(plan, 42), plan);
  const jsonl = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
    content: [{ type: 'text', text: `ARCHITECT_RESULT: ${JSON.stringify(plan)}` }] }] });
  assert.deepEqual(planFromJsonl(jsonl, 42), plan);
});

test('can split a contract-only child without inventing an implementation', () => {
  const plan = { parent_issue: 42, steps: [
    step('schema', 'contract'), step('compatibility', 'contract', ['schema']),
  ] };
  assert.equal(validatePlan(plan, 42), plan);
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
  const jsonl = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant',
    content: [{ type: 'text', text: `ARCHITECT_RESULT: ${JSON.stringify(keep)}` }] }] });
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
