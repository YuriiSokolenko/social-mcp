import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedFiles, finishArchitectParents, issueNumber, latestCI, latestStatus, needsCIDispatch, shouldDeferBranchUpdate } from '../scripts/pi-auto-merge.mjs';

const repo = 'owner/social-mcp';
const pr = {
  state: 'open', draft: false, body: 'Closes #42',
  base: { ref: 'dev', repo: { full_name: repo } },
  head: { ref: 'pi/issue-42', repo: { full_name: repo } },
};

test('only a same-repository Pi PR closing its own issue is eligible', () => {
  assert.equal(issueNumber(pr, repo), 42);
  assert.equal(issueNumber({ ...pr, base: { ...pr.base, ref: 'main' } }, repo), null);
  assert.equal(issueNumber({ ...pr, body: 'Closes #43' }, repo), null);
  assert.equal(issueNumber({ ...pr, head: { ...pr.head, repo: { full_name: 'attacker/fork' } } }, repo), null);
  assert.equal(issueNumber({ ...pr, draft: true }, repo), null);
  assert.equal(issueNumber({ ...pr, head: { ...pr.head, ref: 'feature/42' } }, repo), null);
});

test('CI must match current SHA and branch and latest run must pass', () => {
  const runs = [
    { id: 1, head_sha: 'old', head_branch: 'pi/issue-42', event: 'pull_request', conclusion: 'success' },
    { id: 2, head_sha: 'new', head_branch: 'pi/issue-42', event: 'workflow_dispatch', conclusion: 'success' },
    { id: 3, head_sha: 'new', head_branch: 'pi/issue-42', event: 'workflow_dispatch', conclusion: 'failure' },
  ];
  assert.equal(latestCI(runs, 'new', 'pi/issue-42').conclusion, 'failure');
  assert.equal(latestCI(runs, 'missing', 'pi/issue-42'), null);
  assert.equal(latestCI(runs, 'new', 'pi/issue-43'), null);
});

test('a bot PR CI run needing approval must not count as a passing run', () => {
  const runs = [{ id: 7, head_sha: 'new', head_branch: 'pi/issue-42',
    event: 'pull_request', status: 'completed', conclusion: 'action_required' }];
  // PR-triggered runs may require approval; only a workflow_dispatch run can satisfy the merge gate.
  assert.equal(latestCI(runs, 'new', 'pi/issue-42'), null);
  assert.equal(needsCIDispatch(latestCI(runs, 'new', 'pi/issue-42'), null), true);
  assert.equal(needsCIDispatch({ event: 'workflow_dispatch', status: 'queued' }, null), false);
  assert.equal(needsCIDispatch({ event: 'workflow_dispatch', conclusion: 'failure' }, null), false);
});

test('latest review status must refer to exact SHA fetched by caller', () => {
  assert.equal(latestStatus([{ context: 'social-mcp/pi-review', state: 'failure' },
    { context: 'social-mcp/pi-review', state: 'success' }], 'social-mcp/pi-review'), 'failure');
  assert.equal(latestStatus([], 'social-mcp/pi-review'), null);
});

test('Pi cannot change the workflow definitions used for its own checks', () => {
  assert.equal(allowedFiles([{ filename: 'app/server.py' }], 1), true);
  assert.equal(allowedFiles([{ filename: '.github/workflows/ci.yml' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'app/server.py' }], 2), false);
});

test('do not move a PR head while its reviewer is running or a repair is in flight', () => {
  assert.equal(shouldDeferBranchUpdate({ labels: [{ name: 'review:running' }] }), true);
  assert.equal(shouldDeferBranchUpdate({ labels: [{ name: 'review:changes-requested' }] }), true);
  assert.equal(shouldDeferBranchUpdate({ labels: [{ name: 'review:ready' }] }), false);
  assert.equal(shouldDeferBranchUpdate({ labels: [{ name: 'review:passed' }] }), false);
});

test('closing a completed leaf closes its child epic and then its root epic', async () => {
  const issues = new Map([
    [10, { number: 10, state: 'open', body: '<!-- architect-children:11,12 -->', labels: [{ name: 'architect:epic' }] }],
    [11, { number: 11, state: 'open', body: '<!-- architect-parent:10; architect-key:part -->\n<!-- architect-children:13,14 -->', labels: [{ name: 'architect:epic' }] }],
    [12, { number: 12, state: 'closed', state_reason: 'completed', body: '<!-- architect-parent:10; architect-key:rest -->', labels: [] }],
    [13, { number: 13, state: 'closed', state_reason: 'completed', body: '<!-- architect-parent:11; architect-key:first -->', labels: [] }],
    [14, { number: 14, state: 'closed', state_reason: 'completed', body: '<!-- architect-parent:11; architect-key:second -->', labels: [] }],
  ]);
  const changes = [];
  const issueApi = async (endpoint, method = 'GET', patch = {}) => {
    const number = Number(endpoint.split('/').pop());
    if (method === 'PATCH') {
      Object.assign(issues.get(number), patch);
      changes.push(number);
    }
    return issues.get(number);
  };
  await finishArchitectParents(14, issueApi);
  assert.deepEqual(changes, [11, 10]);
  await finishArchitectParents(14, issueApi);
  assert.deepEqual(changes, [11, 10]);
});

test('an unfinished sibling prevents closure of every ancestor', async () => {
  const issues = new Map([
    [10, { state: 'open', body: '<!-- architect-children:11,12 -->', labels: [{ name: 'architect:epic' }] }],
    [11, { state: 'open', body: '<!-- architect-parent:10; architect-key:part -->\n<!-- architect-children:13,14 -->', labels: [{ name: 'architect:epic' }] }],
    [12, { state: 'open', body: '', labels: [] }],
    [13, { state: 'closed', state_reason: 'completed', body: '', labels: [] }],
    [14, { state: 'closed', state_reason: 'completed', body: '<!-- architect-parent:11; architect-key:second -->', labels: [] }],
  ]);
  const changes = [];
  const issueApi = async (endpoint, method = 'GET') => {
    const number = Number(endpoint.split('/').pop());
    if (method === 'PATCH') changes.push(number);
    return issues.get(number);
  };
  await finishArchitectParents(14, issueApi);
  assert.deepEqual(changes, [11]);
});
