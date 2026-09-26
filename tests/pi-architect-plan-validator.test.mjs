import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArchitectPlanAgainstBacklog } from '../scripts/pi-architect-plan-validator.mjs';

const issue = (number, body = '') => ({ number, body });
const split = (parent, steps = [{ key: 'a' }, { key: 'b' }]) => ({ parent_issue: parent, action: 'split', steps });
const tasks = new Map();
const reader = number => {
  if (!tasks.has(number)) throw new Error('no task');
  return { dependencies: tasks.get(number) };
};

test('rejects a split of an already decomposed epic', () => {
  tasks.set(10, []);
  assert.throws(() => validateArchitectPlanAgainstBacklog(split(10), 10,
    [issue(10, '<!-- architect-children:11,12 -->')], reader), /already split/);
});

test('rejects revise dependency on an ancestor', () => {
  tasks.set(11, []);
  const plan = { parent_issue: 11, action: 'revise', depends_on: [10] };
  assert.throws(() => validateArchitectPlanAgainstBacklog(plan, 11,
    [issue(10), issue(11, '<!-- architect-parent:10; architect-key:child -->')], reader), /ancestor/);
});

test('rejects excessive nested architect depth', () => {
  for (const n of [1,2,3,4,5]) tasks.set(n, []);
  const issues = [
    issue(1),
    issue(2, '<!-- architect-parent:1; architect-key:a -->'),
    issue(3, '<!-- architect-parent:2; architect-key:b -->'),
    issue(4, '<!-- architect-parent:3; architect-key:c -->'),
    issue(5, '<!-- architect-parent:4; architect-key:d -->'),
  ];
  assert.throws(() => validateArchitectPlanAgainstBacklog(split(5), 5, issues, reader), /maximum Architect depth/);
});

test('rejects cycles already present in executable task graph', () => {
  tasks.set(20, [21]);
  tasks.set(21, [20]);
  assert.throws(() => validateArchitectPlanAgainstBacklog(split(20), 20,
    [issue(20), issue(21)], reader), /Dependency cycle/);
});

test('accepts a normal nested split below depth limit', () => {
  tasks.set(30, []);
  tasks.set(31, [30]);
  const plan = split(31);
  assert.equal(validateArchitectPlanAgainstBacklog(plan, 31, [
    issue(30), issue(31, '<!-- architect-parent:30; architect-key:child -->'),
  ], reader), plan);
});
