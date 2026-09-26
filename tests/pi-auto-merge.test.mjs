import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { allowedFiles, issueNumber, latestStatus } from '../scripts/pi-auto-merge.mjs';

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

test('pair-bound pending review status deduplicates reviewer dispatch', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(source, /state: 'pending'.*social-mcp\/pi-review/s);
  assert.doesNotMatch(source, /hasLiveReview|Review PR/);
});

test('merge gate does not use review labels or repair checkpoints for correctness', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.doesNotMatch(source, /review:passed|review:changes-requested|review:running/);
  assert.doesNotMatch(source, /hasRepairCheckpoint|repairCheckpoint/);
  assert.match(source, /review !== 'success'/);
});


test('merge gate is pair-driven and does not orchestrate branch ancestry', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.doesNotMatch(source, /behind_by|ahead_by|compare\/dev|update-branch/);
  assert.match(source, /base\.object\.sha/);
  assert.match(source, /social-mcp\/integration\/\$\{base\.object\.sha\.slice\(0, 12\)\}/);
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


test('merge gate has no issue or architect finalization responsibilities', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.doesNotMatch(source, /finishArchitectParents|finalizeMergedPR|replaceIssueState|pi-dispatcher\.yml/);
  assert.doesNotMatch(source, /mergeable_state/);
  assert.match(source, /social-mcp\/integration-conflict/);
});

test('review status is bound to the exact dev base', () => {
  const source = fs.readFileSync('scripts/pi-transition.mjs', 'utf8');
  assert.match(source, /social-mcp\/pi-review\/\$\{baseSha\.slice\(0, 12\)\}/);
});


test('integration correctness uses pair-bound statuses, never workflow titles', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  const summary = fs.readFileSync('scripts/pi-issue-summary.mjs', 'utf8');
  assert.match(gate, /social-mcp\/integration\//);
  assert.match(gate, /actions\/workflows\/ci\.yml\/dispatches/);
  assert.doesNotMatch(gate, /latestCI|needsCIDispatch|actions\/workflows\/ci\.yml\/runs/);
  assert.doesNotMatch(summary, /display_title|workflow_runs/);
});


test('dispatcher owns post-completion issue reconciliation', () => {
  const mergeGate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  const dispatcher = fs.readFileSync('.github/workflows/pi-dispatcher.yml', 'utf8');
  assert.doesNotMatch(mergeGate, /architect:epic|pi-issue-reconcile|pi-dispatcher\.yml/);
  assert.match(dispatcher, /types: \[closed\]/);
  assert.match(dispatcher, /pi-issue-reconcile\.mjs/);
});


test('merge gate never scans workflow runs for review or repair liveness', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.doesNotMatch(source, /workflow_runs|display_title|hasLiveReview|hasLiveRepair|actions\/workflows\/pi-pr-(?:review|fix)\.yml\/runs/);
  assert.match(source, /social-mcp\/repair-conflict/);
  assert.match(source, /social-mcp\/repair-review/);
});


test('merge gate uses shared GitHub client and no Actions-run liveness state', () => {
  const source = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(source, /githubClient/);
  assert.doesNotMatch(source, /api\.github\.com|workflow_runs|display_title|hasLive/);
});


test('failed integration dispatches integration repair instead of stopping', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(gate, /integration === 'failure'/);
  assert.match(gate, /reason: 'integration'/);
  assert.match(gate, /social-mcp\/repair-integration/);
  assert.match(repair, /- integration/);
  assert.match(repair, /pi-transition\.mjs" issue needs-human/);
});
