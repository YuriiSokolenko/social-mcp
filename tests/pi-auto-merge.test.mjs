import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { allowedFiles, issueNumber } from '../scripts/pi-auto-merge.mjs';

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

test('merge gate follows the simple merge-then-test contract', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(source, /merge_method: 'squash'/);
  assert.match(source, /dev push CI now validates the merged result/);
  assert.doesNotMatch(source, /integration_base_sha|repair_base_sha|BASE_SHA|base\.object\.sha/);
  assert.doesNotMatch(source, /social-mcp\/(?:integration|integration-conflict|pi-review|repair-)/);
  assert.doesNotMatch(source, /pi-pr-review\.yml|pi-pr-fix\.yml|ci\.yml/);
  assert.doesNotMatch(source, /statuses|reserveAndDispatch|latestStatus/);
});

test('unsafe control-plane PRs leave one explicit human-attention comment', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
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
