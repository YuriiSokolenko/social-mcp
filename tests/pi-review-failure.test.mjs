import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  applyReview,
  dispatchAfterReview,
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
  dispatchFailures = 0,
  commentErrorPattern = null,
  commentReturnsId = true,
} = {}) {
  const state = {
    pr: { number: 7, head: { sha: head }, labels: labels.map(name => ({ name })) },
    comments: [],
    dispatches: [],
    dispatchFailuresRemaining: dispatchFailures,
    nextCommentId: 1,
  };
  return {
    state,
    async loadPullRequest() { return structuredClone(state.pr); },
    async replaceLabels(_number, names) { state.pr.labels = names.map(name => ({ name })); },
    async pages() {
      return state.comments.map(item => item.user
        ? item
        : { ...item, user: { login: 'github-actions[bot]', type: 'Bot' } });
    },
    async comment(_number, body) {
      if (commentErrorPattern && commentErrorPattern.test(body)) throw new Error('comment unavailable');
      const item = {
        id: state.nextCommentId++,
        body,
        user: { login: 'github-actions[bot]', type: 'Bot' },
      };
      state.comments.push(item);
      return commentReturnsId ? item : {};
    },
    async dispatchWorkflow(workflow, inputs) {
      state.dispatches.push({ workflow, inputs });
      if (state.dispatchFailuresRemaining > 0) {
        state.dispatchFailuresRemaining -= 1;
        throw new Error('transient dispatch failure');
      }
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
  model: 'qwen',
};

test('independent review failure clears stale verdict and dispatches one durable retry without issuing a verdict', async () => {
  const client = fakeClient();
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '123', runAttempt: 1,
  }, client);
  const result = await recoverReviewFailure(failure, client);

  assert.deepEqual(result, { status: 'retry-dispatched' });
  assert.deepEqual(client.state.dispatches, [{ workflow: 'pi-pr-review.yml', inputs: { pr_number: '7', model: 'qwen' } }]);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created']);
  assert.match(client.state.comments.at(-1).body, /infrastructure failure, not a code-review verdict/);
  assert.match(client.state.comments.at(-1).body, /pi-review:failure-retry:7:head-1:123/);
  assert.match(client.state.comments.at(-1).body, /https:\/\/github\.test\/runs\/123/);
});

test('repeated recovery is idempotent and does not dispatch another retry', async () => {
  const client = fakeClient();
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '123', runAttempt: 1,
  }, client);
  await recoverReviewFailure(failure, client);
  const repeated = await recoverReviewFailure(failure, client);

  assert.deepEqual(repeated, { status: 'retry-already-requested' });
  assert.equal(client.state.dispatches.length, 1);
  assert.equal(client.state.comments.length, 2);
});

test('concurrent recovery claims for the same run dispatch only from the oldest retry claim', async () => {
  const client = fakeClient();
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '522', runAttempt: 1,
  }, client);

  const originalComment = client.comment.bind(client);
  const marker = '<!-- pi-review:failure-retry:7:head-1:522:attempt:1 -->';
  let injected = false;
  client.comment = async (number, body) => {
    if (!injected && String(body).includes(marker)) {
      injected = true;
      await originalComment(number, `Competing recovery claim.\n\n${marker}`);
    }
    return originalComment(number, body);
  };

  const result = await recoverReviewFailure({
    ...failure,
    runId: '522',
    runAttempt: 1,
  }, client);

  assert.deepEqual(result, { status: 'retry-already-requested' });
  assert.deepEqual(client.state.dispatches, []);
  assert.equal(client.state.comments.filter(item => String(item.body).includes(marker)).length, 2);
});

test('a failed retry removes stale PASS and durably transfers the PR to human review', async () => {
  const client = fakeClient();
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '123', runAttempt: 1,
  }, client);
  await recoverReviewFailure(failure, client);
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '124', runAttempt: 1,
  }, client);
  const result = await recoverReviewFailure({ ...failure, runId: '124', outcome: 'cancelled' }, client);

  assert.deepEqual(result, { status: 'needs-human', reason: 'retry-exhausted' });
  assert.equal(client.state.dispatches.length, 1);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'pi:needs-human']);
  assert.match(client.state.comments.at(-1).body, /after the single automatic retry/);
  assert.match(client.state.comments.at(-1).body, /No PASS or CHANGES_REQUESTED verdict/);
  assert.match(client.state.comments.at(-1).body, /pi-review:failure-exhausted:7:head-1:124/);
});

test('failed retry dispatch transfers the PR to human review', async () => {
  const client = fakeClient({ dispatchError: 'workflow dispatch unavailable' });
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '123', runAttempt: 1,
  }, client);
  const result = await recoverReviewFailure(failure, client);

  assert.deepEqual(result, { status: 'needs-human', reason: 'retry-request-failed' });
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'pi:needs-human']);
  assert.equal(client.state.comments.length, 3);
  assert.match(client.state.comments.at(-1).body, /bounded retry workflow could not be dispatched/);
  assert.match(client.state.comments.at(-1).body, /pi-review:failure-retry-request-failed:7:head-1:123/);
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
    model: 'qwen',
  }, client);
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '502', runAttempt: 1,
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
    body: 'Independent review run 503 attempt 1 started.\n\n<!-- pi-review:run:7:head-1:503:attempt:1:qwen -->',
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

test('follow-up claim is not written when the pre-claim human-gate read fails', async () => {
  const client = fakeClient({ labels: ['pi:mr-created', 'review:passed'] });
  client.loadPullRequest = async () => {
    throw new Error('pull request API unavailable');
  };

  await assert.rejects(
    dispatchAfterReview(7, 'PASS', {
      reviewedHead: 'head-1',
      runId: '525',
      runAttempt: 1,
    }, client),
    /pull request API unavailable/,
  );

  assert.deepEqual(client.state.dispatches, []);
  assert.equal(client.state.comments.length, 0);
});

test('late recovery does not dispatch a stale PASS after the current verdict changed', async () => {
  const client = fakeClient({ labels: ['pi:mr-created'] });
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '526',
    runAttempt: 1,
    model: 'qwen',
  }, client);
  await applyReview({
    prNumber: 7,
    reviewedHead: 'head-1',
    verdict: 'PASS',
    text: 'Run A passed.',
    runId: '526',
    runAttempt: 1,
  }, client);
  await applyReview({
    prNumber: 7,
    reviewedHead: 'head-1',
    verdict: 'CHANGES_REQUESTED',
    text: 'Run B found changes.',
    runId: '527',
    runAttempt: 1,
  }, client);

  const recovered = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '526',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/526',
  }, client);

  assert.deepEqual(recovered, { status: 'superseded-verdict', verdict: 'PASS' });
  assert.deepEqual(client.state.dispatches, []);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:changes-requested']);
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

test('human-authored review markers cannot suppress bot recovery', async () => {
  const client = fakeClient({ labels: ['pi:mr-created', 'review:passed'] });
  client.state.comments.push({
    id: client.state.nextCommentId++,
    user: { login: 'reviewer-person', type: 'User' },
    body: '<!-- pi-review:followup:head-1:PASS:run:530:attempt:1 -->',
  });

  const result = await dispatchAfterReview(7, 'PASS', {
    reviewedHead: 'head-1',
    runId: '530',
    runAttempt: 1,
    requireCurrentVerdict: true,
  }, client);

  assert.deepEqual(result, { status: 'followup-dispatched', verdict: 'PASS' });
  assert.equal(client.state.dispatches.length, 1);
  assert.ok(client.state.comments.some(item =>
    item.user?.login === 'github-actions[bot]' &&
    String(item.body).includes('pi-review:followup:head-1:PASS:run:530:attempt:1')));
});

test('human-authored retry marker cannot exhaust bot retry budget', async () => {
  const client = fakeClient();
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '531', runAttempt: 1,
  }, client);
  client.state.comments.push({
    id: client.state.nextCommentId++,
    user: { login: 'reviewer-person', type: 'User' },
    body: '<!-- pi-review:failure-retry:7:head-1:999:attempt:1 -->',
  });

  const result = await recoverReviewFailure({
    ...failure,
    runId: '531',
    runAttempt: 1,
  }, client);

  assert.deepEqual(result, { status: 'retry-dispatched' });
  assert.equal(client.state.dispatches.length, 1);
  assert.ok(!client.state.pr.labels.some(label => label.name === 'pi:needs-human'));
});

test('follow-up claim suppresses duplicate recovery dispatch', async () => {
  const client = fakeClient({ labels: ['pi:mr-created'] });
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '513',
    runAttempt: 1,
    model: 'qwen',
  }, client);
  await applyReview({
    prNumber: 7,
    reviewedHead: 'head-1',
    verdict: 'PASS',
    text: 'Looks good.',
    runId: '513',
    runAttempt: 1,
  }, client);
  client.state.comments.push({
    id: client.state.nextCommentId++,
    body: 'claimed\n\n<!-- pi-review:followup-claim:head-1:PASS:run:513:attempt:1 -->',
  });

  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '513',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/513',
  }, client);

  assert.deepEqual(result, { status: 'followup-claimed', verdict: 'PASS' });
  assert.deepEqual(client.state.dispatches, []);
});

test('failed claimed follow-up is retried by workflow-run recovery', async () => {
  const client = fakeClient({ labels: ['pi:mr-created'], dispatchFailures: 1 });
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '518',
    runAttempt: 1,
    model: 'qwen',
  }, client);
  await applyReview({
    prNumber: 7,
    reviewedHead: 'head-1',
    verdict: 'PASS',
    text: 'Looks good.',
    runId: '518',
    runAttempt: 1,
  }, client);

  await assert.rejects(
    recoverReviewWorkflowRun({
      displayTitle: '🔬 Review PR #7',
      runId: '518',
      runAttempt: 1,
      outcome: 'failure',
      runUrl: 'https://github.test/runs/518',
    }, client),
    /transient dispatch failure/,
  );
  assert.match(client.state.comments.at(-1).body, /pi-review:followup-failed:head-1:PASS:run:518:attempt:1/);

  const recovered = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '518',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/518',
  }, client);

  assert.deepEqual(recovered, { status: 'followup-dispatched', verdict: 'PASS' });
  assert.equal(client.state.dispatches.length, 2);
  assert.match(client.state.comments.at(-1).body, /pi-review:followup:head-1:PASS:run:518:attempt:1/);
});

test('concurrent failed-follow-up recoveries dispatch only from the oldest retry claim', async () => {
  const client = fakeClient({ labels: ['pi:mr-created'], dispatchFailures: 1 });
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '523',
    runAttempt: 1,
    model: 'qwen',
  }, client);
  await applyReview({
    prNumber: 7,
    reviewedHead: 'head-1',
    verdict: 'PASS',
    text: 'Looks good.',
    runId: '523',
    runAttempt: 1,
  }, client);

  await assert.rejects(
    recoverReviewWorkflowRun({
      displayTitle: '🔬 Review PR #7',
      runId: '523',
      runAttempt: 1,
      outcome: 'failure',
      runUrl: 'https://github.test/runs/523',
    }, client),
    /transient dispatch failure/,
  );

  const originalComment = client.comment.bind(client);
  const retryMarker = '<!-- pi-review:followup-retry:head-1:PASS:run:523:attempt:1 -->';
  let injected = false;
  client.comment = async (number, body) => {
    if (!injected && String(body).includes(retryMarker)) {
      injected = true;
      await originalComment(number, `Competing follow-up retry claim.\n\n${retryMarker}`);
    }
    return originalComment(number, body);
  };

  const recovered = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '523',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/523',
  }, client);

  assert.deepEqual(recovered, { status: 'followup-claimed', verdict: 'PASS' });
  assert.equal(client.state.dispatches.length, 1);
  assert.equal(client.state.comments.filter(item => String(item.body).includes(retryMarker)).length, 2);
});

test('review retry claim fails closed when GitHub comment creation has no durable id', async () => {
  const client = fakeClient({ commentReturnsId: false });
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '524', runAttempt: 1,
  }, client);

  await assert.rejects(
    recoverReviewFailure({
      ...failure,
      runId: '524',
      runAttempt: 1,
    }, client),
    /did not return a durable comment id/,
  );
  assert.deepEqual(client.state.dispatches, []);
});

test('human takeover blocks recovery follow-up dispatch even when a verdict marker exists', async () => {
  const client = fakeClient({ labels: ['pi:mr-created', 'review:passed', 'pi:needs-human'] });
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '519',
    runAttempt: 1,
    model: 'qwen',
  }, client);
  client.state.comments.push({
    id: client.state.nextCommentId++,
    body: '<!-- pi-review:verdict:head-1:PASS:run:519:attempt:1 -->',
  });

  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '519',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/519',
  }, client);

  assert.deepEqual(result, { status: 'human' });
  assert.deepEqual(client.state.dispatches, []);
});

test('deterministic repair handoff refuses a stale reviewed head', async () => {
  const client = fakeClient({ head: 'head-2', labels: ['pi:mr-created'] });

  const result = await dispatchAfterReview(7, 'CHANGES_REQUESTED', {
    reviewedHead: 'head-1',
    runId: '532',
    runAttempt: 1,
  }, client);

  assert.deepEqual(result, { status: 'stale' });
  assert.deepEqual(client.state.dispatches, []);
  assert.equal(client.state.comments.length, 0);
});

test('deterministic repair handoff is idempotent when run identity is available', async () => {
  const client = fakeClient({ labels: ['pi:mr-created'] });

  const first = await dispatchAfterReview(7, 'CHANGES_REQUESTED', {
    reviewedHead: 'head-1',
    runId: '528',
    runAttempt: 1,
  }, client);
  const repeated = await dispatchAfterReview(7, 'CHANGES_REQUESTED', {
    reviewedHead: 'head-1',
    runId: '528',
    runAttempt: 1,
  }, client);

  assert.deepEqual(first, { status: 'followup-dispatched', verdict: 'CHANGES_REQUESTED' });
  assert.deepEqual(repeated, { status: 'followup-already-dispatched', verdict: 'CHANGES_REQUESTED' });
  assert.deepEqual(client.state.dispatches, [{
    workflow: 'pi-pr-fix.yml',
    inputs: { pr_number: '7' },
  }]);
});

test('failure after deterministic repair dispatch but before independent start does not launch a reviewer', async () => {
  const client = fakeClient({ labels: ['pi:mr-created', 'review:changes-requested'] });
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '520',
    runAttempt: 1,
    model: 'qwen',
  }, client);

  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '520',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/520',
  }, client);

  assert.deepEqual(result, { status: 'ignored', reason: 'review-failed-before-independent-start' });
  assert.deepEqual(client.state.dispatches, []);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created', 'review:changes-requested']);
});

test('successful one-shot follow-up retry is not dispatched a third time when confirmation fails', async () => {
  const client = fakeClient({
    labels: ['pi:mr-created'],
    dispatchFailures: 1,
    commentErrorPattern: /was dispatched successfully/,
  });
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '521',
    runAttempt: 1,
    model: 'qwen',
  }, client);
  await applyReview({
    prNumber: 7,
    reviewedHead: 'head-1',
    verdict: 'PASS',
    text: 'Looks good.',
    runId: '521',
    runAttempt: 1,
  }, client);

  await assert.rejects(
    recoverReviewWorkflowRun({
      displayTitle: '🔬 Review PR #7',
      runId: '521',
      runAttempt: 1,
      outcome: 'failure',
      runUrl: 'https://github.test/runs/521',
    }, client),
    /transient dispatch failure/,
  );

  const retried = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '521',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/521',
  }, client);
  assert.deepEqual(retried, { status: 'followup-dispatched-unconfirmed', verdict: 'PASS' });
  assert.equal(client.state.dispatches.length, 2);
  assert.ok(client.state.comments.some(item => /pi-review:followup-retry:head-1:PASS:run:521:attempt:1/.test(item.body)));

  const third = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '521',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/521',
  }, client);
  assert.deepEqual(third, { status: 'followup-claimed', verdict: 'PASS' });
  assert.equal(client.state.dispatches.length, 2);
});

test('successful follow-up dispatch is not retried when its confirmation comment fails', async () => {
  const client = fakeClient({
    labels: ['pi:mr-created'],
    commentErrorPattern: /was dispatched successfully/,
  });
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '514',
    runAttempt: 1,
    model: 'qwen',
  }, client);
  await applyReview({
    prNumber: 7,
    reviewedHead: 'head-1',
    verdict: 'PASS',
    text: 'Looks good.',
    runId: '514',
    runAttempt: 1,
  }, client);

  const first = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '514',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/514',
  }, client);

  assert.deepEqual(first, { status: 'followup-dispatched-unconfirmed', verdict: 'PASS' });
  assert.equal(client.state.dispatches.length, 1);

  const repeated = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7',
    runId: '514',
    runAttempt: 1,
    outcome: 'failure',
    runUrl: 'https://github.test/runs/514',
  }, client);
  assert.deepEqual(repeated, { status: 'followup-claimed', verdict: 'PASS' });
  assert.equal(client.state.dispatches.length, 1);
});

test('empty in-workflow model is recovered from the exact run marker', async () => {
  const client = fakeClient();
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '515',
    runAttempt: 1,
    model: 'laguna',
  }, client);
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '515', runAttempt: 1,
  }, client);

  const result = await recoverReviewFailure({
    ...failure,
    runId: '515',
    runAttempt: 1,
    model: '',
  }, client);

  assert.deepEqual(result, { status: 'retry-dispatched' });
  assert.deepEqual(client.state.dispatches, [{
    workflow: 'pi-pr-review.yml',
    inputs: { pr_number: '7', model: 'laguna' },
  }]);
});

test('missing in-workflow model without a durable record never dispatches invalid default input', async () => {
  const client = fakeClient();
  const result = await recoverReviewFailure({
    ...failure,
    runId: '516',
    runAttempt: 1,
    model: '',
  }, client);

  assert.deepEqual(result, { status: 'missing-run-model' });
  assert.deepEqual(client.state.dispatches, []);
});

test('re-run attempt on the same workflow run records and recovers the new PR head', async () => {
  const client = fakeClient();
  await recordReviewRun({
    prNumber: 7,
    reviewedHead: 'head-1',
    runId: '506',
    runAttempt: 1,
    model: 'qwen',
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
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-2', runId: '506', runAttempt: 2,
  }, client);
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
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '507', runAttempt: 1,
  }, client);
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
    model: 'qwen',
  }, client);
  client.state.comments.push({
    body: '<!-- pi-review:verdict:head-1:PASS:run:999:attempt:1 --> unrelated :run:508:attempt:2 -->',
  });
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '508', runAttempt: 2,
  }, client);

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

test('a claimed review retry intentionally leaves an unreviewed PR for ordinary reconciliation if its winner dies before dispatch', async () => {
  const client = fakeClient();
  await markReviewStarted({
    prNumber: 7, reviewedHead: 'head-1', runId: '529', runAttempt: 1,
  }, client);

  const originalComment = client.comment.bind(client);
  const retryMarker = '<!-- pi-review:failure-retry:7:head-1:529:attempt:1 -->';
  client.comment = async (number, body) => {
    const item = await originalComment(number, body);
    if (String(body).includes(retryMarker)) {
      throw new Error('runner died after durable retry claim');
    }
    return item;
  };

  await assert.rejects(
    recoverReviewFailure({
      ...failure,
      runId: '529',
      runAttempt: 1,
    }, client),
    /runner died after durable retry claim/,
  );

  assert.deepEqual(client.state.dispatches, []);
  assert.deepEqual(client.state.pr.labels.map(label => label.name), ['pi:mr-created']);
  assert.ok(client.state.comments.some(item => String(item.body).includes(retryMarker)));

  const reconciler = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconciler, /const RECOVERY_GRACE_MS = 10 \* 60 \* 1000/);
  assert.match(reconciler, /workflowFile\(needsFix \? 'repair' : 'reviewer'\)/);
  assert.match(reconciler, /add: needsFix \? REVIEW_CHANGES_REQUESTED : 'unreviewed'/);
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
  assert.doesNotMatch(review, /recover_failed_review:/);
  assert.match(
    review,
    /name: Fail job after independent review infrastructure failure[\s\S]*?workflow_run recovery owns the bounded retry/,
  );
  assert.ok(
    review.indexOf('name: Load and guard PR') < review.indexOf('name: Record review run identity') &&
      review.indexOf('name: Record review run identity') < review.indexOf('name: Create review worktree') &&
      review.indexOf('name: Create review worktree') < review.indexOf('name: Run independent review'),
    'durable run identity must be recorded immediately after the PR head is loaded and before review setup',
  );
  assert.match(review, /id: record/);
  assert.match(review, /\.pi\/default-model/);
  assert.match(review, /PI_MODEL_CHOICE: \$\{\{ inputs\.model \|\| 'default' \}\}/);
  assert.doesNotMatch(review, /vars\.PI_MODEL/);
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
  const reconciler = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconciler, /const RECOVERY_GRACE_MS = 10 \* 60 \* 1000/);
  assert.match(reconciler, /labels\.has\(REVIEW_PASSED\)[\s\S]*?mergeGateRecoveryNeeded = true/);
  assert.match(reconciler, /const needsFix = labels\.has\(REVIEW_CHANGES_REQUESTED\);[\s\S]*?workflowFile\(needsFix \? 'repair' : 'reviewer'\)/);
  assert.match(reconciler, /add: needsFix \? REVIEW_CHANGES_REQUESTED : 'unreviewed'/);
});


test('a swift review run keeps its catalog model through the durable record and retry', async () => {
  const client = fakeClient();
  const recorded = await recordReviewRun({
    prNumber: 7, reviewedHead: 'head-1', runId: '601', runAttempt: 1,
    runUrl: 'https://github.test/runs/601', model: 'swift',
  }, client);
  assert.deepEqual(recorded, { status: 'recorded', reviewedHead: 'head-1', model: 'swift' });
  await markReviewStarted({ prNumber: 7, reviewedHead: 'head-1', runId: '601', runAttempt: 1 }, client);
  const result = await recoverReviewWorkflowRun({
    displayTitle: '🔬 Review PR #7', runId: '601', runAttempt: 1, outcome: 'cancelled',
    runUrl: 'https://github.test/runs/601',
  }, client);
  assert.deepEqual(result, { status: 'retry-dispatched' });
  assert.deepEqual(client.state.dispatches, [{ workflow: 'pi-pr-review.yml', inputs: { pr_number: '7', model: 'swift' } }]);
});

test('a model alias outside the catalog is recorded as default, never passed through', async () => {
  const client = fakeClient();
  const recorded = await recordReviewRun({
    prNumber: 7, reviewedHead: 'head-1', runId: '602', runAttempt: 1, model: 'not-a-model',
  }, client);
  assert.deepEqual(recorded, { status: 'recorded', reviewedHead: 'head-1', model: 'default' });
});
