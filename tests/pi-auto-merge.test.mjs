import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedFiles, issueNumber, latestCI, latestStatus, needsCIDispatch } from '../scripts/pi-auto-merge.mjs';

const repo = 'owner/social-mcp';
const pr = {
  state: 'open', draft: false, body: 'Closes #42',
  base: { ref: 'main', repo: { full_name: repo } },
  head: { ref: 'pi/issue-42', repo: { full_name: repo } },
};

test('only a same-repository Pi PR closing its own issue is eligible', () => {
  assert.equal(issueNumber(pr, repo), 42);
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
  assert.equal(latestCI(runs, 'new', 'pi/issue-42').conclusion, 'action_required');
  assert.equal(needsCIDispatch(runs[0], null), true);
  assert.equal(needsCIDispatch(runs[0], 'pending'), false);
  assert.equal(needsCIDispatch({ conclusion: 'failure' }, null), false);
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
