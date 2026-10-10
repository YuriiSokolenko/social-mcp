import assert from 'node:assert/strict';
import test from 'node:test';

import * as architect from '../scripts/pi-architect.mjs';
import * as planValidator from '../scripts/pi-architect-plan-validator.mjs';
import * as autoMerge from '../scripts/pi-auto-merge.mjs';
import * as postMerge from '../scripts/pi-post-merge.mjs';
import { issueStateIo, transitionIssueState } from '../scripts/pi-common/github-state.mjs';
import { closingIssueNumber } from '../scripts/pi-common/pr-guard.mjs';
import { PIPELINE_LABELS } from '../scripts/pi-common/state-machine.mjs';

// Characterization tests for helpers consolidated by #736. Each stage used to
// carry its own copy; these pin the behavior every caller now shares.

function fakeIssueApi(issues) {
  const calls = [];
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    const number = Number(/^\/issues\/(\d+)$/.exec(path)?.[1]);
    const issue = issues.get(number);
    if (!issue) throw new Error(`unexpected request ${method} ${path}`);
    if (method === 'GET') return structuredClone(issue.next?.shift() ?? issue.current);
    if (method === 'PATCH') {
      issue.current = { ...issue.current, labels: body.labels.map(name => ({ name })) };
      return structuredClone(issue.current);
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { api, calls };
}

const openIssue = (number, ...labels) => ({ number, state: 'open', labels: labels.map(name => ({ name })) });

test('transitionIssueState reads, validates and compare-and-swaps the issue state label', async () => {
  const issues = new Map([[7, { current: openIssue(7, 'bug', PIPELINE_LABELS.queued) }]]);
  const { api, calls } = fakeIssueApi(issues);

  await transitionIssueState({ api, number: 7, action: 'ready', context: 'Dispatcher' });

  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), ['GET /issues/7', 'GET /issues/7', 'PATCH /issues/7']);
  assert.deepEqual(calls.at(-1).body, { labels: ['bug', PIPELINE_LABELS.ready] });
});

test('transitionIssueState rejects an illegal action before any write', async () => {
  const issues = new Map([[7, { current: openIssue(7, PIPELINE_LABELS.pr) }]]);
  const { api, calls } = fakeIssueApi(issues);

  await assert.rejects(transitionIssueState({ api, number: 7, action: 'needs-human', context: 'Triage' }),
    /needs-human cannot replace/);
  assert.equal(calls.some(call => call.method === 'PATCH'), false);
});

test('transitionIssueState names the stage in a lost race and defaults to "pipeline"', async () => {
  const raced = () => new Map([[7, {
    current: openIssue(7, PIPELINE_LABELS.ready),
    next: [openIssue(7, PIPELINE_LABELS.queued)],
  }]]);

  for (const [context, label] of [['Architect', 'Architect'], [undefined, 'pipeline']]) {
    const { api, calls } = fakeIssueApi(raced());
    await assert.rejects(transitionIssueState({ api, number: 7, action: 'ready', context }),
      new RegExp(`^Error: concurrent ${label} transition on #7`));
    assert.equal(calls.some(call => call.method === 'PATCH'), false);
  }
});

test('issueStateIo maps load/patch onto the plain issue endpoints', async () => {
  const calls = [];
  const io = issueStateIo(async (...args) => { calls.push(args); return {}; });
  await io.load(3);
  await io.patch(3, ['a']);
  assert.deepEqual(calls, [['/issues/3'], ['/issues/3', 'PATCH', { labels: ['a'] }]]);
});

const repo = 'owner/repo';
const pr = {
  body: 'Implements it.\n\nResolves #94',
  base: { ref: 'dev', repo: { full_name: repo } },
  head: { ref: 'pi/issue-94', repo: { full_name: repo } },
};

test('closingIssueNumber is the single PR -> issue linkage rule', () => {
  assert.equal(closingIssueNumber(pr, repo), 94);
  assert.equal(closingIssueNumber({ ...pr, body: 'Implements #94' }, repo), null);
  assert.equal(closingIssueNumber({ ...pr, body: 'Closes #95' }, repo), null);
  assert.equal(closingIssueNumber({ ...pr, base: { ...pr.base, ref: 'main' } }, repo), null);
  assert.equal(closingIssueNumber({ ...pr, head: { ...pr.head, repo: { full_name: 'fork/repo' } } }, repo), null);
  assert.equal(closingIssueNumber({ ...pr, head: { ...pr.head, ref: 'pi/issue-0' } }, repo), null);
  const huge = '99999999999999999999';
  assert.equal(closingIssueNumber({ ...pr, head: { ...pr.head, ref: `pi/issue-${huge}` }, body: `Closes #${huge}` }, repo), null);
});

test('Merge Gate additionally refuses draft PRs; post-merge keeps the shared rule', () => {
  const draft = { ...pr, draft: true };
  assert.equal(autoMerge.linkedIssueNumber(pr, repo), 94);
  assert.equal(autoMerge.linkedIssueNumber(draft, repo), null);
  assert.equal(postMerge.linkedIssueNumber(draft, repo), 94);
  assert.equal(postMerge.linkedIssueNumber, closingIssueNumber);
});

test('Architect marker parsers have one implementation', () => {
  assert.equal(architect.parentOf, planValidator.parentOf);
  assert.equal(architect.childNumbers, planValidator.childNumbers);
  assert.equal(architect.parentOf('x\n<!-- architect-parent:12; architect-key:api-a -->'), 12);
  assert.equal(architect.parentOf('<!-- architect-parent:12; architect-key:Bad -->'), null);
  assert.deepEqual(architect.childNumbers('<!-- architect-children:4,5,6 -->'), [4, 5, 6]);
  assert.deepEqual(architect.childNumbers('<!-- architect-children:0,5 -->'), []);
});
