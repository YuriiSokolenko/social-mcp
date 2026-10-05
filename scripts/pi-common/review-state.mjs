#!/usr/bin/env node
import fs from 'node:fs';

import { githubClient } from './github-api.mjs';
import { REVIEW_CHANGES_REQUESTED, REVIEW_PASSED, prLabelNames, withoutReviewLabels, withReviewVerdict } from './pr-labels.mjs';
import { workflowFile } from './project-config.mjs';
import { PIPELINE_LABELS } from './state-machine.mjs';


async function replaceReviewLabels(prNumber, target = null, client = githubClient()) {
  const { loadPullRequest, replaceLabels } = client;
  const pr = await loadPullRequest(prNumber);
  const keep = withoutReviewLabels(pr);
  const next = target ? [...keep, target] : keep;
  await replaceLabels(prNumber, next);
  return pr;
}

/**
 * Clear a verdict after GitHub reports a new PR HEAD. This listener never
 * schedules Reviewer: synchronize invalidates state only; normal ownership or
 * Reconciler recovery is responsible for the next run.
 */
function reviewVerdictMarker(head, verdict, runId = null, runAttempt = null) {
  return runId && runAttempt
    ? `<!-- pi-review:verdict:${head}:${verdict}:run:${runId}:attempt:${runAttempt} -->`
    : `<!-- pi-review:verdict:${head}:${verdict} -->`;
}

function reviewRunMarker(prNumber, reviewedHead, runId, runAttempt, model) {
  return `<!-- pi-review:run:${prNumber}:${reviewedHead}:${runId}:attempt:${runAttempt}:${model} -->`;
}

function reviewFollowupMarker(head, verdict, runId, runAttempt) {
  return `<!-- pi-review:followup:${head}:${verdict}:run:${runId}:attempt:${runAttempt} -->`;
}

function reviewFollowupClaimMarker(head, verdict, runId, runAttempt) {
  return `<!-- pi-review:followup-claim:${head}:${verdict}:run:${runId}:attempt:${runAttempt} -->`;
}

function reviewFollowupFailedMarker(head, verdict, runId, runAttempt) {
  return `<!-- pi-review:followup-failed:${head}:${verdict}:run:${runId}:attempt:${runAttempt} -->`;
}

function reviewFollowupRetryMarker(head, verdict, runId, runAttempt) {
  return `<!-- pi-review:followup-retry:${head}:${verdict}:run:${runId}:attempt:${runAttempt} -->`;
}

function reviewStartMarker(prNumber, reviewedHead, runId, runAttempt) {
  return `<!-- pi-review:start:${prNumber}:${reviewedHead}:${runId}:attempt:${runAttempt} -->`;
}

function requireCommentId(item, context) {
  const id = Number(item?.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`${context}: GitHub comment creation did not return a durable comment id`);
  }
  return id;
}


export function findReviewRunRecord(comments, prNumber, runId, runAttempt) {
  const markerPattern = /<!-- pi-review:run:(\d+):([^:\s]+):([^:\s]+):attempt:(\d+):(default|laguna|qwen) -->/g;
  for (const item of comments) {
    const body = String(item.body ?? '');
    for (const match of body.matchAll(markerPattern)) {
      if (
        Number(match[1]) === Number(prNumber) &&
        match[3] === String(runId) &&
        Number(match[4]) === Number(runAttempt)
      ) {
        return { reviewedHead: match[2], model: match[5] };
      }
    }
  }
  return null;
}

export async function recordReviewRun({
  prNumber, reviewedHead, runId, runAttempt, runUrl, model = 'default',
}, client = githubClient()) {
  const { loadPullRequest, pages, comment } = client;
  const pr = await loadPullRequest(prNumber);
  if (pr.head.sha !== reviewedHead) return { status: 'stale' };

  const safeModel = ['laguna', 'qwen'].includes(model) ? model : 'default';
  const comments = await pages(`/issues/${prNumber}/comments`);
  const existing = findReviewRunRecord(comments, prNumber, runId, runAttempt);
  if (existing) return { status: 'already-recorded', ...existing };

  const marker = reviewRunMarker(prNumber, reviewedHead, runId, runAttempt, safeModel);
  const link = runUrl ? `\n\nRun: ${runUrl}` : '';
  await comment(
    prNumber,
    `Independent review run ${runId} attempt ${runAttempt} recorded for HEAD ${reviewedHead}. This durable marker lets recovery reject obsolete PR heads.${link}\n\n${marker}`,
  );
  return { status: 'recorded', reviewedHead, model: safeModel };
}

export async function markReviewStarted({
  prNumber, reviewedHead, runId, runAttempt,
}, client = githubClient()) {
  const { loadPullRequest, pages, comment } = client;
  const pr = await loadPullRequest(prNumber);
  if (pr.head.sha !== reviewedHead) return { status: 'stale' };

  const comments = await pages(`/issues/${prNumber}/comments`);
  const marker = reviewStartMarker(prNumber, reviewedHead, runId, runAttempt);
  if (comments.some(item => String(item.body ?? '').includes(marker))) {
    return { status: 'already-started' };
  }
  await comment(prNumber, `Independent review execution started.\n\n${marker}`);
  return { status: 'started' };
}

export async function invalidateReview(prNumber, expectedHead = null, client = githubClient()) {
  const { loadPullRequest, replaceLabels, pages } = client;
  const pr = await loadPullRequest(prNumber);
  if (expectedHead && pr.head.sha !== expectedHead) return { status: 'stale-push' };

  const labels = prLabelNames(pr);
  const hasVerdict = labels.includes(REVIEW_PASSED) || labels.includes(REVIEW_CHANGES_REQUESTED);
  if (!hasVerdict) return { status: 'no-verdict' };

  if (expectedHead) {
    const comments = await pages(`/issues/${prNumber}/comments`);
    const markerPrefix = `<!-- pi-review:verdict:${expectedHead}:`;
    if (comments.some(item => String(item.body ?? '').includes(markerPrefix))) {
      return { status: 'current-verdict' };
    }
  }

  await replaceLabels(prNumber, withoutReviewLabels(labels));
  return { status: 'invalidated' };
}

/**
 * Atomically apply a model review against the HEAD it actually reviewed.
 * Human gate and HEAD are re-read immediately before mutation so a verdict
 * cannot race a human takeover or a synchronize event.
 */
export async function applyReview({
  prNumber, reviewedHead, verdict, text, runId = null, runAttempt = null,
}, client = githubClient()) {
  const { loadPullRequest, replaceLabels, comment } = client;
  const pr = await loadPullRequest(prNumber);
  const currentLabels = prLabelNames(pr);
  if (currentLabels.includes(PIPELINE_LABELS.needsHuman)) return { status: 'human' };
  if (pr.head.sha !== reviewedHead) {
    await replaceReviewLabels(prNumber);
    return { status: 'stale' };
  }
  const target = verdict === 'PASS' ? REVIEW_PASSED : REVIEW_CHANGES_REQUESTED;
  await replaceLabels(prNumber, withReviewVerdict(currentLabels, target));
  await comment(prNumber, `${text}\n\n${reviewVerdictMarker(reviewedHead, verdict, runId, runAttempt)}`);
  return { status: 'applied', verdict };
}

export async function dispatchAfterReview(
  prNumber,
  verdict,
  { reviewedHead = null, runId = null, runAttempt = null, requireCurrentVerdict = false } = {},
  client = githubClient(),
) {
  const { dispatchWorkflow, loadPullRequest, pages, comment } = client;
  const workflow = workflowFile(verdict === 'PASS' ? 'mergeGate' : 'repair');
  const inputs = verdict === 'PASS' ? undefined : { pr_number: String(prNumber) };
  const hasDurableReviewIdentity = Boolean(reviewedHead && runId && runAttempt);
  const marker = hasDurableReviewIdentity
    ? reviewFollowupMarker(reviewedHead, verdict, runId, runAttempt)
    : null;
  const claimMarker = hasDurableReviewIdentity
    ? reviewFollowupClaimMarker(reviewedHead, verdict, runId, runAttempt)
    : null;

  const expectedVerdictLabel = verdict === 'PASS' ? REVIEW_PASSED : REVIEW_CHANGES_REQUESTED;
  const beforeClaimPr = await loadPullRequest(prNumber);
  const beforeClaimLabels = prLabelNames(beforeClaimPr);
  if (beforeClaimLabels.includes(PIPELINE_LABELS.needsHuman)) {
    return { status: 'human' };
  }
  if (requireCurrentVerdict && !beforeClaimLabels.includes(expectedVerdictLabel)) {
    return { status: 'superseded-verdict', verdict };
  }

  if (marker && claimMarker) {
    let comments = await pages(`/issues/${prNumber}/comments`);
    if (comments.some(item => String(item.body ?? '').includes(marker))) {
      return { status: 'followup-already-dispatched', verdict };
    }

    const existingClaim = comments.find(item => String(item.body ?? '').includes(claimMarker));
    const failedMarker = reviewFollowupFailedMarker(reviewedHead, verdict, runId, runAttempt);
    const retryMarker = reviewFollowupRetryMarker(reviewedHead, verdict, runId, runAttempt);
    const previousDispatchFailed = comments.some(item => String(item.body ?? '').includes(failedMarker));
    const retryClaimed = comments.some(item => String(item.body ?? '').includes(retryMarker));
    if (existingClaim && (!previousDispatchFailed || retryClaimed)) {
      return { status: 'followup-claimed', verdict };
    }

    const claim = existingClaim ?? await comment(
      prNumber,
      `Review follow-up for ${verdict} claimed for dispatch. If this handoff is interrupted, ordinary PR reconciliation owns recovery.\n\n${claimMarker}`,
    );
    const claimId = requireCommentId(claim, 'review follow-up claim');

    try {
      // Re-read after claiming. Concurrent recoveries may both have observed no
      // claim; only the oldest durable claim is allowed to perform the dispatch.
      comments = await pages(`/issues/${prNumber}/comments`);
      const claims = comments
        .filter(item => String(item.body ?? '').includes(claimMarker))
        .filter(item => Number.isSafeInteger(Number(item.id)))
        .sort((a, b) => Number(a.id) - Number(b.id));
      if (!claims.length || Number(claims[0].id) !== claimId) {
        return { status: 'followup-claimed', verdict };
      }

      if (existingClaim && previousDispatchFailed) {
        const retryClaim = await comment(
          prNumber,
          `Retrying the previously failed review follow-up dispatch once; further recovery is delegated to the ordinary PR reconciler.\n\n${retryMarker}`,
        );
        const retryClaimId = requireCommentId(retryClaim, 'review follow-up retry claim');
        comments = await pages(`/issues/${prNumber}/comments`);
        const retryClaims = comments
          .filter(item => String(item.body ?? '').includes(retryMarker))
          .filter(item => Number.isSafeInteger(Number(item.id)))
          .sort((a, b) => Number(a.id) - Number(b.id));
        if (!retryClaims.length || Number(retryClaims[0].id) !== retryClaimId) {
          return { status: 'followup-claimed', verdict };
        }
      }

      const currentPr = await loadPullRequest(prNumber);
      const currentLabels = prLabelNames(currentPr);
      if (currentLabels.includes(PIPELINE_LABELS.needsHuman)) {
        return { status: 'human' };
      }
      if (requireCurrentVerdict && !currentLabels.includes(expectedVerdictLabel)) {
        return { status: 'superseded-verdict', verdict };
      }
    } catch (error) {
      try {
        await comment(
          prNumber,
          `Review follow-up preparation for ${verdict} failed before dispatch (${error.message}). Recovery may retry this claimed handoff.\n\n${failedMarker}`,
        );
      } catch {
        // A runner death or a second GitHub API failure can still prevent
        // failure bookkeeping. The verdict label remains the Reconciler fallback.
      }
      throw error;
    }
  }

  try {
    await dispatchWorkflow(workflow, inputs);
  } catch (error) {
    if (hasDurableReviewIdentity) {
      const failedMarker = reviewFollowupFailedMarker(reviewedHead, verdict, runId, runAttempt);
      try {
        await comment(
          prNumber,
          `Review follow-up dispatch for ${verdict} failed (${error.message}). Workflow-run recovery may retry this claimed handoff.\n\n${failedMarker}`,
        );
      } catch {
        // The verdict label remains durable. If even failure bookkeeping is
        // unavailable, the ordinary PR reconciler is the final recovery path.
      }
    }
    throw error;
  }
  if (marker) {
    try {
      await comment(
        prNumber,
        `Review follow-up for ${verdict} was dispatched successfully.\n\n${marker}`,
      );
    } catch {
      // Dispatch already succeeded. Do not turn a bookkeeping-comment failure
      // into a failed review that can dispatch the same follow-up again.
      return { status: 'followup-dispatched-unconfirmed', verdict };
    }
  }
  return { status: 'followup-dispatched', verdict };
}

/**
 * Recover a failed independent review without inventing a review verdict.
 * The first failed run is retried once; a repeated failure or a failed retry
 * request is transferred to a human. A run for an outdated PR head is ignored.
 */
export async function recoverReviewFailure({
  prNumber, reviewedHead, runId, runAttempt, outcome, runUrl, model = 'default',
}, client = githubClient()) {
  const { loadPullRequest, replaceLabels, pages, comment, dispatchWorkflow } = client;
  if (!['failure', 'cancelled', 'timed_out'].includes(outcome)) {
    return { status: 'ignored', reason: 'non-infrastructure-outcome' };
  }

  const pr = await loadPullRequest(prNumber);
  const comments = await pages(`/issues/${prNumber}/comments`);
  const record = findReviewRunRecord(comments, prNumber, runId, runAttempt);
  let effectiveHead = reviewedHead;
  let effectiveModel = model;
  if (!effectiveHead) {
    if (!record) return { status: 'missing-run-head' };
    effectiveHead = record.reviewedHead;
  }
  if (!['laguna', 'qwen'].includes(effectiveModel)) {
    if (!record || !['laguna', 'qwen'].includes(record.model)) {
      return { status: 'missing-run-model' };
    }
    effectiveModel = record.model;
  }
  if (pr.head.sha !== effectiveHead) return { status: 'stale' };
  const labels = prLabelNames(pr);
  if (labels.includes(PIPELINE_LABELS.needsHuman)) return { status: 'human' };

  const passMarker = reviewVerdictMarker(effectiveHead, 'PASS', runId, runAttempt);
  const changesMarker = reviewVerdictMarker(effectiveHead, 'CHANGES_REQUESTED', runId, runAttempt);
  const appliedVerdict = comments.some(item => String(item.body ?? '').includes(passMarker))
    ? 'PASS'
    : comments.some(item => String(item.body ?? '').includes(changesMarker))
      ? 'CHANGES_REQUESTED'
      : null;
  if (appliedVerdict) {
    const currentVerdictLabel = appliedVerdict === 'PASS'
      ? REVIEW_PASSED
      : REVIEW_CHANGES_REQUESTED;
    if (!labels.includes(currentVerdictLabel)) {
      return { status: 'superseded-verdict', verdict: appliedVerdict };
    }
    return dispatchAfterReview(prNumber, appliedVerdict, {
      reviewedHead: effectiveHead,
      runId,
      runAttempt,
      requireCurrentVerdict: true,
    }, client);
  }

  const startMarker = reviewStartMarker(prNumber, effectiveHead, runId, runAttempt);
  if (!comments.some(item => String(item.body ?? '').includes(startMarker))) {
    return {
      status: 'ignored',
      reason: outcome === 'cancelled'
        ? 'cancelled-before-independent-start'
        : 'review-failed-before-independent-start',
    };
  }
  // #391 intentionally treats a cancellation after independent review has
  // actually started as recoverable infrastructure failure, including a
  // controlled/manual mid-flight cancellation. Pre-start cancellations are
  // ignored above so operator cancellation before model work is respected.

  const clearVerdict = withoutReviewLabels(labels);

  const retryPrefix = `<!-- pi-review:failure-retry:${prNumber}:${effectiveHead}:`;
  const retryMarker = `${retryPrefix}${runId}:attempt:${runAttempt} -->`;
  const exhaustedMarker = `<!-- pi-review:failure-exhausted:${prNumber}:${effectiveHead}:${runId}:attempt:${runAttempt} -->`;
  const failedRetryMarker = `<!-- pi-review:failure-retry-request-failed:${prNumber}:${effectiveHead}:${runId}:attempt:${runAttempt} -->`;
  const link = runUrl ? `\n\nRun: ${runUrl}` : '';

  const markHuman = async (marker, message) => {
    await replaceLabels(prNumber, clearVerdict.includes(PIPELINE_LABELS.needsHuman)
      ? clearVerdict
      : [...clearVerdict, PIPELINE_LABELS.needsHuman]);
    if (!comments.some(item => (item.body ?? '').includes(marker))) {
      await comment(prNumber, `${message}${link}\n\n${marker}`);
    }
  };

  if (comments.some(item => (item.body ?? '').includes(retryMarker))) {
    return { status: 'retry-already-requested' };
  }

  const previousFailures = comments.filter(item => (item.body ?? '').includes(retryPrefix)).length;
  if (previousFailures === 0) {
    await replaceLabels(prNumber, clearVerdict);
    // Persist the reason before queuing the retry, so a dispatch failure
    // cannot leave the PR silent or carrying an earlier PASS verdict.
    const retryClaim = await comment(
      prNumber,
      `Independent review ended with ${outcome} for HEAD ${effectiveHead}. This is an infrastructure failure, not a code-review verdict. One automatic retry workflow was queued.${link}\n\n${retryMarker}`,
    );
    const retryClaimId = requireCommentId(retryClaim, 'review retry claim');
    const refreshedComments = await pages(`/issues/${prNumber}/comments`);
    const matchingRetryClaims = refreshedComments
      .filter(item => String(item.body ?? '').includes(retryMarker))
      .filter(item => Number.isSafeInteger(Number(item.id)))
      .sort((a, b) => Number(a.id) - Number(b.id));
    if (
      !matchingRetryClaims.length ||
      Number(matchingRetryClaims[0].id) !== retryClaimId
    ) {
      return { status: 'retry-already-requested' };
    }
    try {
      await dispatchWorkflow(workflowFile('reviewer'), {
        pr_number: String(prNumber),
        model: effectiveModel,
      });
      return { status: 'retry-dispatched' };
    } catch (error) {
      await markHuman(failedRetryMarker,
        `Independent review failed with ${outcome}, and its bounded retry workflow could not be dispatched (${error.message}). Human review recovery is required.`);
      return { status: 'needs-human', reason: 'retry-request-failed' };
    }
  }

  await markHuman(exhaustedMarker,
    `Independent review failed with ${outcome} again after the single automatic retry. No PASS or CHANGES_REQUESTED verdict was applied. Human review recovery is required.`);
  return { status: 'needs-human', reason: 'retry-exhausted' };
}

export async function recoverReviewWorkflowRun({
  displayTitle, runId, runAttempt, outcome, runUrl,
}, client = githubClient()) {
  const match = /^🔬 Review PR #([1-9]\d*)\b/.exec(displayTitle ?? '');
  if (!match) return { status: 'ignored', reason: 'not-review-run' };
  const prNumber = Number(match[1]);
  const normalizedRunId = String(runId);
  const normalizedAttempt = Number(runAttempt);

  const recorded = await recoverReviewFailure({
    prNumber,
    reviewedHead: null,
    runId: normalizedRunId,
    runAttempt: normalizedAttempt,
    outcome,
    runUrl,
    model: 'default',
  }, client);
  if (!['missing-run-head', 'missing-run-model'].includes(recorded.status)) return recorded;

  return {
    status: 'ignored',
    reason: outcome === 'cancelled'
      ? 'cancelled-without-run-marker'
      : 'review-not-started-without-run-marker',
  };
}

async function main() {
  const [cmd, rawPr, a, b, c] = process.argv.slice(2);
  if (cmd === 'recover-workflow-run') {
    const result = await recoverReviewWorkflowRun({
      displayTitle: process.env.REVIEW_RUN_TITLE,
      runId: process.env.REVIEW_RUN_ID,
      runAttempt: process.env.REVIEW_RUN_ATTEMPT,
      outcome: process.env.REVIEW_OUTCOME,
      runUrl: process.env.REVIEW_RUN_URL,
    });
    return process.stdout.write(JSON.stringify(result));
  }

  const prNumber = Number(rawPr);
  if (cmd === 'invalidate') return invalidateReview(prNumber, a);
  if (cmd === 'apply') {
    const result = await applyReview({
      prNumber, reviewedHead: a, verdict: b, text: fs.readFileSync(c, 'utf8'),
      runId: process.env.REVIEW_RUN_ID, runAttempt: process.env.REVIEW_RUN_ATTEMPT,
    });
    return process.stdout.write(JSON.stringify(result));
  }
  if (cmd === 'dispatch') {
    const result = await dispatchAfterReview(prNumber, a, {
      reviewedHead: process.env.HEAD_SHA,
      runId: process.env.REVIEW_RUN_ID,
      runAttempt: process.env.REVIEW_RUN_ATTEMPT,
      requireCurrentVerdict: process.env.REVIEW_REQUIRE_CURRENT_VERDICT === 'true',
    });
    return process.stdout.write(JSON.stringify(result));
  }
  if (cmd === 'record-run') {
    const result = await recordReviewRun({
      prNumber, reviewedHead: a, runId: b, runAttempt: process.env.REVIEW_RUN_ATTEMPT,
      runUrl: process.env.REVIEW_RUN_URL, model: process.env.REVIEW_MODEL,
    });
    return process.stdout.write(JSON.stringify(result));
  }
  if (cmd === 'start-run') {
    const result = await markReviewStarted({
      prNumber, reviewedHead: a, runId: b, runAttempt: process.env.REVIEW_RUN_ATTEMPT,
    });
    return process.stdout.write(JSON.stringify(result));
  }
  if (cmd === 'recover-failure') {
    const result = await recoverReviewFailure({
      prNumber, reviewedHead: a, runId: b, runAttempt: process.env.REVIEW_RUN_ATTEMPT,
      outcome: process.env.REVIEW_OUTCOME, runUrl: process.env.REVIEW_RUN_URL,
      model: process.env.REVIEW_MODEL,
    });
    return process.stdout.write(JSON.stringify(result));
  }
  throw new Error('usage: review-state.mjs invalidate <pr> [expected-head] | apply <pr> <head> <verdict> <text-file> | dispatch <pr> <verdict> | record-run <pr> <head> <run-id> | start-run <pr> <head> <run-id> | recover-failure <pr> <head> <run-id> | recover-workflow-run');
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e);process.exitCode=1;});
