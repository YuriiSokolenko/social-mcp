import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readScript } from './helpers/resolved-source.mjs';
import { allowedFiles, issueNumber, prCiVerdict } from '../scripts/pi-auto-merge.mjs';

const repo = 'owner/social-mcp';
const pr = {
  state: 'open', draft: false, body: 'Closes #42',
  base: { ref: 'dev', repo: { full_name: repo } },
  head: { ref: 'pi/issue-42', repo: { full_name: repo }, sha: 'abc' },
};

test('only a same-repository Pi PR closing its own issue is eligible', () => {
  assert.equal(issueNumber(pr, repo), 42);
  assert.equal(issueNumber({ ...pr, base: { ...pr.base, ref: 'main' } }, repo), null);
  assert.equal(issueNumber({ ...pr, body: 'Closes #43' }, repo), null);
  assert.equal(issueNumber({ ...pr, head: { ...pr.head, repo: { full_name: 'attacker/fork' } } }, repo), null);
  assert.equal(issueNumber({ ...pr, draft: true }, repo), null);
});

test('Pi cannot change the workflow definitions used for its own merge', () => {
  assert.equal(allowedFiles([{ filename: 'app/server.py' }], 1), true);
  assert.equal(allowedFiles([{ filename: '.github/workflows/ci.yml' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'scripts/pi-auto-merge.mjs' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'app/server.py' }], 2), false);
});

test('merge gate requires successful PR CI for the exact head SHA', () => {
  assert.deepEqual(prCiVerdict([], 'abc'), { state: 'pending', run: null });
  assert.equal(prCiVerdict([
    { id: 1, event: 'pull_request', head_sha: 'old', status: 'completed', conclusion: 'success' },
  ], 'abc').state, 'pending');
  assert.equal(prCiVerdict([
    { id: 2, event: 'pull_request', head_sha: 'abc', status: 'in_progress', conclusion: null },
  ], 'abc').state, 'pending');
  assert.equal(prCiVerdict([
    { id: 3, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'failure' },
  ], 'abc').state, 'failed');
  assert.equal(prCiVerdict([
    { id: 4, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'success' },
  ], 'abc').state, 'success');

  const source = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(source, /workflowFile\('ci'\)/);
  assert.match(source, /head_sha=/);
  assert.match(source, /waiting for green PR CI/);
  assert.match(source, /merge_method: 'squash'/);
  assert.doesNotMatch(source, /integration_base_sha|repair_base_sha|BASE_SHA|base\.object\.sha/);
  assert.doesNotMatch(source, /social-mcp\/(?:integration|integration-conflict|pi-review|repair-)/);
});

test('unsafe control-plane PRs leave one explicit human-attention comment', () => {
  const source = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(source, /Human review is required/);
  assert.match(source, /merge-gate:unsafe-pr:/);
  assert.match(source, /comments\.some/);
});

test('agent workflows execute control scripts only from fresh GITHUB_WORKSPACE checkout', () => {
  const workflows = [
    'pi-issue-agent.yml', 'pi-pr-fix.yml', 'pi-pr-review.yml',
    'pi-dispatcher.yml', 'pi-architect.yml', 'pi-triage.yml', 'pi-auto-merge.yml',
  ];
  for (const name of workflows) {
    const source = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.doesNotMatch(source, /(?:node|bash) scripts\//, name);
    assert.doesNotMatch(source, /\/home\/runner|actions-runner\/_work/, name);
    assert.match(source, /GITHUB_WORKSPACE\/scripts\//, name);
  }
});


test('merge gate merges at most one PR per dev CI cycle', () => {
  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(gate, /if \(await processPR\(pr\)\) break/);
  assert.match(ci, /needs: \[test, docker\]/);
  assert.match(ci, /github\.ref == 'refs\/heads\/dev'/);
  assert.match(ci, /workflow-dispatch\.mjs pi-auto-merge\.yml/);
});


test('late merge conflict invalidates review, dispatches PR Fix, and blocks the queue', () => {
  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /merge conflicts/i);
  assert.match(gate, /merge-gate:conflict-pr:\$\{pr\.number\}:\$\{sha\}/);
  assert.match(gate, /withoutReviewLabels/);
  assert.match(gate, /dispatchWorkflow\('pi-pr-fix\.yml'/);
  assert.match(gate, /return 'blocked'/);
  assert.match(gate, /if \(await processPR\(pr\)\) break/);
});
