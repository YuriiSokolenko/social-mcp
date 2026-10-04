import test from 'node:test';
import assert from 'node:assert/strict';

import { applyReview, invalidateReview, recoverReviewFailure } from '../scripts/pi-common/review-state.mjs';

function fakeClient({ head = 'head-1', labels = ['pi:mr-created', 'review:passed'], dispatchError = null } = {}) {
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
