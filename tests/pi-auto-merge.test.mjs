import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { allowedFiles, finishArchitectParents, issueNumber, latestCI, latestStatus, needsCIDispatch } from '../scripts/pi-auto-merge.mjs';

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

test('integration CI must match exact PR SHA, branch and dev base SHA', () => {
  const runs = [
    { id: 1, event: 'workflow_dispatch', display_title: '🧪 CI · target:new ref:pi/issue-42 base:dev-old', conclusion: 'success' },
    { id: 2, event: 'workflow_dispatch', display_title: '🧪 CI · target:new ref:pi/issue-42 base:dev-new', conclusion: 'success' },
    { id: 3, event: 'push', display_title: '🧪 CI · target:new ref:pi/issue-42 base:dev-new', conclusion: 'failure' },
  ];
  assert.equal(latestCI(runs, 'new', 'pi/issue-42', 'dev-new').id, 2);
  assert.equal(latestCI(runs, 'new', 'pi/issue-42', 'missing'), null);
  assert.equal(latestCI(runs, 'new', 'pi/issue-43', 'dev-new'), null);
});

test('a bot PR CI run needing approval must not count as a passing run', () => {
  const runs = [{ id: 7, head_sha: 'new', head_branch: 'pi/issue-42',
    event: 'pull_request', status: 'completed', conclusion: 'action_required' }];
  // PR-triggered runs may require approval; only trusted workflow_dispatch can satisfy the merge gate.
  assert.equal(latestCI(runs, 'new', 'pi/issue-42'), null);
  assert.equal(needsCIDispatch(latestCI(runs, 'new', 'pi/issue-42'), null), true);
  assert.equal(needsCIDispatch({ event: 'workflow_dispatch', status: 'queued' }, null), false);
  assert.equal(needsCIDispatch({ event: 'workflow_dispatch', conclusion: 'failure' }, null), false);
});

test('latest review status is the merge gate authority for the fetched PR SHA', () => {
  assert.equal(latestStatus([
    { context: 'social-mcp/pi-review', state: 'failure', updated_at: '2026-09-26T11:00:00Z' },
    { context: 'social-mcp/pi-review', state: 'success', updated_at: '2026-09-26T11:01:00Z' },
  ], 'social-mcp/pi-review'), 'success');
  assert.equal(latestStatus([], 'social-mcp/pi-review'), null);
});

test('Pi cannot change the workflow definitions used for its own checks', () => {
  assert.equal(allowedFiles([{ filename: 'app/server.py' }], 1), true);
  assert.equal(allowedFiles([{ filename: '.github/workflows/ci.yml' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'app/server.py' }], 2), false);
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


test('auto-merge guards reviewer dispatch against an already-live review', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(source, /async function hasLiveReview\(prNumber\)/);
  assert.match(source, /await hasLiveReview\(pr\.number\)/);
  assert.match(source, /Review PR/);
});


test('merge gate does not use review labels or repair checkpoints for correctness', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.doesNotMatch(source, /review:passed|review:changes-requested|review:running/);
  assert.doesNotMatch(source, /hasRepairCheckpoint|repairCheckpoint/);
  assert.match(source, /currentReview === 'failure'/);
  assert.match(source, /review !== 'success'/);
});


test('merge gate is pair-driven and does not orchestrate branch ancestry', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.doesNotMatch(source, /behind_by|ahead_by|compare\/dev|update-branch/);
  assert.match(source, /base\.object\.sha/);
  assert.match(source, /latestCI\(runs, sha, pr\.head\.ref, base\.object\.sha\)/);
  assert.match(source, /freshBase\.object\.sha !== base\.object\.sha/);
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


test('merge gate owns integration CI and starts review only after CI success', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  const awaitCi = fs.readFileSync('scripts/pi-await-ci.mjs', 'utf8');
  assert.match(gate, /actions\/workflows\/ci\.yml\/dispatches/);
  assert.match(gate, /ci\.status !== 'completed' \|\| ci\.conclusion !== 'success'/);
  assert.doesNotMatch(awaitCi, /actions\/workflows\/ci\.yml\/dispatches/);
});


test('issue summary follows exact current dev and PR integration pair', () => {
  const source = fs.readFileSync('scripts/pi-issue-summary.mjs', 'utf8');
  assert.match(source, /target:\$\{pr\.head\.sha\} ref:\$\{pr\.head\.ref\} base:\$\{base\.object\.sha\}/);
  assert.doesNotMatch(source, /ci\.yml\/runs\?head_sha=/);
});

test('review transitions use SHA status rather than review labels', () => {
  const source = fs.readFileSync('scripts/pi-transition.mjs', 'utf8');
  assert.match(source, /social-mcp\/pi-review/);
  const reviewBranch = source.slice(source.indexOf('} else {'));
  assert.doesNotMatch(reviewBranch, /replaceLabels\(/);
});


test('shared state helpers contain issue state only', () => {
  for (const path of ['scripts/pi-state-machine.mjs', 'scripts/pi-github-state.mjs', 'scripts/pi-labels.mjs']) {
    const source = fs.readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /REVIEW_LABELS|REVIEW_TRANSITIONS|review:ready|review:running|review:passed|review:changes-requested|review:failed/, path);
  }
});
