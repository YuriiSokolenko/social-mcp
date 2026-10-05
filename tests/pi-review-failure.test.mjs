import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  applyReview,
  invalidateReview,
  markReviewStarted,
  recordReviewRun,
  recoverReviewFailure,
  recoverReviewWorkflowRun,
} from '../scripts/pi-common/review-state.mjs';

function fakeClient({
  head = 'head-1',
  labels = ['pi:mr-created', 'review:passed'],
  dispatchError = null,
} = {}) {
  const state = {
    pr: { number: 7, head: { sha: head }, labels: labels.map(name => ({ name })) },
    comments: [],
    dispatches: [],
  };
  return {
    state,
    async loadPullRequest() { return structuredClone(state.pr); },
    async replaceLabels(_number, names) { state.pr.labels = names.map(name => ({ name })); },
    async pages() { return state.comments; },
    async comment(_number, body) { state.comments.push({ body }); },
    async dispatchWorkflow(workflow, inputs) {
      state.dispatches.push({ workflow, inputs });
      if (dispatchError) throw new Error(dispatchError);
    },
  };
}

const failure = {
  prNumber: 7,
  reviewedHead: 'head-1',
  runId: '123',
  runAttempt: 1,
  outcome: 'failure',
  runUrl: 'https://github.test/runs/123',
};

test('independent review failure clears stale verdict and dispatches one durable retry without issuing a verdict', async () => {
  const client = fakeClient();
  const result = await recoverReviewFailure(failure, client);

  assert.deepEqual(result, { status: 'retry-dispatched' });
  assert.deepEqual(client.state.dispatches, [{ workflow: 'pi-pr-review.yml', inputs: { pr_number: '7', model: 'default' } }]);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created']);
  assert.match(client.state.comments[0].body, /infrastructure failure, not a code-review verdict/);
  assert.match(client.state.comments[0].body, /pi-review:failure-retry:7:head-1:123/);
  assert.match(client.state.comments[0].body, /https:\/\/github\.test\/runs\/123/);
});

test('repeated recovery is idempotent and does not dispatch another retry', async () => {
  const client = fakeClient();
  await recoverReviewFailure(failure, client);
  const repeated = await recoverReviewFailure(failure, client);

  assert.deepEqual(repeated, { status: 'retry-already-requested' });
  assert.equal(client.state.dispatches.length, 1);
  assert.equal(client.state.comments.length, 1);
});

test('a failed retry removes stale PASS and durably transfers the PR to human review', async () => {
  const client = fakeClient();
  await recoverReviewFailure(failure, client);
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '124', runAttempt: 1,
  }, client);
  const result = await recoverReviewFailure({ ...failure, runId: '124', outcome: 'cancelled' }, client);

  assert.deepEqual(result, { status: 'needs-human', reason: 'retry-exhausted' });
  assert.equal(client.state.dispatches.length, 1);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'pi:needs-human']);
  assert.match(client.state.comments[1].body, /after the single automatic retry/);
  assert.match(client.state.comments[1].body, /No PASS or CHANGES_REQUESTED verdict/);
  assert.match(client.state.comments[1].body, /pi-review:failure-exhausted:7:head-1:124/);
});

test('failed retry dispatch transfers the PR to human review', async () => {
  const client = fakeClient({ dispatchError: 'workflow dispatch unavailable' });
  const result = await recoverReviewFailure(failure, client);

  assert.deepEqual(result, { status: 'needs-human', reason: 'retry-request-failed' });
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'pi:needs-human']);
  assert.equal(client.state.comments.length, 2);
  assert.match(client.state.comments[1].body, /bounded retry workflow could not be dispatched/);
  assert.match(client.state.comments[1].body, /pi-review:failure-retry-request-failed:7:head-1:123/);
});

test('failure from a stale review head is ignored', async () => {
  const client = fakeClient({ head: 'head-2' });
  const result = await recoverReviewFailure(failure, client);

  assert.deepEqual(result, { status: 'stale' });
  assert.deepEqual(client.state.dispatches, []);
  assert.equal(client.state.comments.length, 0);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:passed']);
});


test('delayed invalidator does not erase a verdict already applied to the pushed HEAD', async () => {
  const client = fakeClient({ head: 'head-2', labels: ['pi:mr-created'] });
  const applied = await applyReview({
    prNumber: 7,
    reviewedHead: 'head-2',
    verdict: 'PASS',
    text: 'Looks good.',
  }, client);

  assert.deepEqual(applied, { status: 'applied', verdict: 'PASS' });
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:passed']);
  assert.match(client.state.comments[0].body, /pi-review:verdict:head-2:PASS/);

  const invalidated = await invalidateReview(7, 'head-2', client);
  assert.deepEqual(invalidated, { status: 'current-verdict' });
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:passed']);
});

test('invalidator clears a stale verdict when no verdict marker exists for the pushed HEAD', async () => {
  const client = fakeClient({ head: 'head-2', labels: ['pi:mr-created', 'review:passed'] });
  client.state.comments.push({ body: '<!-- pi-review:verdict:head-1:PASS -->' });

  const result = await invalidateReview(7, 'head-2', client);

  assert.deepEqual(result, { status: 'invalidated' });
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created']);
});

test('invalidator from an older push cannot mutate a newer PR HEAD', async () => {
  const client = fakeClient({ head: 'head-3', labels: ['pi:mr-created', 'review:passed'] });
  client.state.comments.push({ body: '<!-- pi-review:verdict:head-3:PASS -->' });

  const result = await invalidateReview(7, 'head-2', client);

  assert.deepEqual(result, { status: 'stale-push' });
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:passed']);
});


test('whole-workflow cancellation resolves the durable run marker and retries the same head/model once', async () => {
  const client = fakeClient();
  const recorded = await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '501',
    runAttempt: 1,
    runUrl: 'https://github.test/runs/501',
    model: 'qwen',
  }, client);

  assert.deepEqual(recorded, { status: 'recorded', reviewedHead: 'head-1', model: 'qwen' });
  await markReviewStarted({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '501',
    runAttempt: 1,
  }, client);
  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '501',
    runAttempt: 1,
    outcome: 'cancelled',
    runUrl: 'https://github.test/runs/501',
  }, client);

  assert.deepEqual(result, { status: 'retry-dispatched' });
  assert.deepEqual(client.state.dispatches, [{
    workflow: 'pi-pr-review.yml',
    inputs: { pr_number: '7', model: 'qwen' },
  }]);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created']);
  assert.match(client.state.comments.at(-1).body, /infrastructure failure, not a code-review verdict/);
  assert.doesNotMatch(client.state.comments.at(-1).body, /PASS|CHANGES_REQUESTED/);
});

test('timeout-equivalent workflow conclusion is infrastructure failure and never a review verdict', async () => {
  const client = fakeClient();
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '502',
    runAttempt: 1,
    model: 'default',
  }, client);

  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '502',
    runAttempt: 1,
    outcome: 'timed_out',
    runUrl: 'https://github.test/runs/502',
  }, client);

  assert.deepEqual(result, { status: 'retry-dispatched' });
  assert.equal(client.state.dispatches.length, 1);
  assert.match(client.state.comments.at(-1).body, /ended with timed_out/);
});

test('whole-workflow recovery ignores a failed run recorded for an obsolete PR head', async () => {
  const client = fakeClient({ head: 'head-2' });
  client.state.comments.push({
    body: 'Independent review run 503 attempt 1 started.\n\n<!-- pi-review:run:7:head-1:503:attempt:1:default -->',
  });

  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '503',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/503',
  }, client);

  assert.deepEqual(result, { status: 'stale' });
  assert.deepEqual(client.state.dispatches, []);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:passed']);
});

test('whole-workflow recovery re-dispatches a missing PASS follow-up exactly once', async () => {
  const client = fakeClient({ labels: ['pi:mr-created'] });
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '505',
    runAttempt: 1,
    model: 'qwen',
  }, client);
  await applyReview({
    prNumber: 7,
    reviewedHead: 'head-1',
    verdict: 'PASS',
    text: 'Looks good.',
    runId: '505',
    runAttempt: 1,
  }, client);

  const first = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '505',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/505',
  }, client);

  assert.deepEqual(first, { status: 'followup-dispatched', verdict: 'PASS' });
  assert.deepEqual(client.state.dispatches, [{ workflow: 'pi-auto-merge.yml', inputs: undefined }]);
  assert.match(client.state.comments.at(-1).body, /pi-review:followup:head-1:PASS:run:505:attempt:1/);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:passed']);

  const repeated = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '505',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/505',
  }, client);
  assert.deepEqual(repeated, { status: 'followup-already-dispatched', verdict: 'PASS' });
  assert.equal(client.state.dispatches.length, 1);
});

test('re-run attempt on the same workflow run records and recovers the new PR head', async () => {
  const client = fakeClient();
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '506',
    runAttempt: 1,
    model: 'default',
  }, client);

  client.state.pr.head.sha = 'head-2';
  const recorded = await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-2',
    runId: '506',
    runAttempt: 2,
    model: 'qwen',
  }, client);

  assert.deepEqual(recorded, { status: 'recorded', reviewedHead: 'head-2', model: 'qwen' });
  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '506',
    runAttempt: 2,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/506',
  }, client);

  assert.deepEqual(result, { status: 'retry-dispatched' });
  assert.deepEqual(client.state.dispatches, [{
    workflow: 'pi-pr-review.yml',
    inputs: { pr_number: '7', model: 'qwen' },
  }]);
});

test('second failed attempt of the same workflow run exhausts the single retry for that head', async () => {
  const client = fakeClient();
  await recoverReviewFailure({
    ...failure,
    runId: '507',
    runAttempt: 1,
  }, client);
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '507', runAttempt: 2,
  }, client);
  const result = await recoverReviewFailure({
    ...failure,
    runId: '507',
    runAttempt: 2,
    outcome: 'cancelled',
  }, client);

  assert.deepEqual(result, { status: 'needs-human', reason: 'retry-exhausted' });
  assert.equal(client.state.dispatches.length, 1);
  assert.ok(client.state.pr.labels.some(label => label.name === 'pi:needs-human'));
  assert.match(client.state.comments.at(-1).body, /507:attempt:2/);
});

test('verdict recovery match requires the exact run and attempt marker', async () => {
  const client = fakeClient({ labels: ['pi:mr-created', 'review:passed'] });
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '508',
    runAttempt: 2,
    model: 'default',
  }, client);
  client.state.comments.push({
    body: '<!-- pi-review:verdict:head-1:PASS:run:999:attempt:1 --> unrelated :run:508:attempt:2 -->',
  });

  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '508',
    runAttempt: 2,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/508',
  }, client);

  assert.deepEqual(result, { status: 'retry-dispatched' });
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created']);
});

test('markerless whole-workflow failure is left to ordinary orphan reconciliation without mutating the PR', async () => {
  const client = fakeClient();
  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '504',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/504',
  }, client);

  assert.deepEqual(result, { status: 'ignored', reason: 'review-not-started-without-run-marker' });
  assert.deepEqual(client.state.dispatches, []);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:passed']);
  assert.equal(client.state.comments.length, 0);
});

test('markerless cancellation is ignored without relying on cancelled-step API semantics', async () => {
  const client = fakeClient();
  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '511',
    runAttempt: 1,
    outcome: 'cancelled',
    runUrl: 'https://github.test/runs/511',
  }, client);

  assert.deepEqual(result, { status: 'ignored', reason: 'cancelled-without-run-marker' });
  assert.deepEqual(client.state.dispatches, []);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:passed']);
  assert.equal(client.state.comments.length, 0);
});

test('identity-only cancellation before independent execution does not dispatch a retry', async () => {
  const client = fakeClient();
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '512',
    runAttempt: 1,
    model: 'qwen',
  }, client);

  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '512',
    runAttempt: 1,
    outcome: 'cancelled',
    runUrl: 'https://github.test/runs/512',
  }, client);

  assert.deepEqual(result, { status: 'ignored', reason: 'cancelled-before-independent-start' });
  assert.deepEqual(client.state.dispatches, []);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:passed']);
});

test('review workflow and reconciler cover missing step outputs and whole-workflow terminal outcomes', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  const reconcile = fs.readFileSync('.github/workflows/pi-reconcile.yml', 'utf8');

  assert.match(review, /name: Record review run identity[\s\S]*?record-run "\$PR" "\$HEAD_SHA" "\$GITHUB_RUN_ID"/);
  assert.doesNotMatch(review, /needs\.review\.result/);
  assert.match(
    review,
    /recover_failed_review:[\s\S]*?if: always\(\) && contains\(fromJSON\('\["failure","cancelled"\]'\), needs\.review\.outputs\.independent_outcome\)/,
  );
  assert.ok(
    review.indexOf('name: Load and guard PR') < review.indexOf('name: Record review run identity') &&
      review.indexOf('name: Record review run identity') < review.indexOf('name: Create review worktree') &&
      review.indexOf('name: Create review worktree') < review.indexOf('name: Run independent review'),
    'durable run identity must be recorded immediately after the PR head is loaded and before review setup',
  );
  assert.match(review, /id: record/);
  assert.match(review, /\.pi\/default-model/);
  assert.match(review, /echo "model=\$\(jq -r '\.model \/\/ empty'/);
  assert.match(review, /model: \$\{\{ steps\.record\.outputs\.model \}\}/);
  assert.match(review, /start-run "\$PR" "\$HEAD_SHA" "\$GITHUB_RUN_ID"/);
  assert.match(review, /contains\(fromJSON\('\["recorded","already-recorded"\]'\), steps\.record\.outputs\.status\)/);
  assert.match(reconcile, /workflow_run:[\s\S]*?workflows: \["Pi PR Review"\][\s\S]*?types: \[completed\]/);
  assert.match(reconcile, /github\.event\.workflow_run\.event == 'workflow_dispatch'/);
  assert.match(reconcile, /\["failure","cancelled","timed_out"\]/);
  assert.match(reconcile, /\["RUNNING","DRAINING"\]/);
  assert.match(reconcile, /group: \$\{\{ format\('pi-review-recovery-\{0\}-\{1\}', github\.event\.workflow_run\.id, github\.event\.workflow_run\.run_attempt\) \}\}/);
  assert.match(reconcile, /REVIEW_RUN_ATTEMPT: \$\{\{ github\.event\.workflow_run\.run_attempt \}\}/);
  assert.match(review, /REVIEW_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(reconcile, /review-state\.mjs recover-workflow-run/);
});
