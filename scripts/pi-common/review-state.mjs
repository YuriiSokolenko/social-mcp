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
    `Independent review run ${runId} attempt ${runAttempt} started for HEAD ${reviewedHead}. This durable marker lets recovery reject obsolete PR heads.${link}\n\n${marker}`,
  );
  return { status: 'recorded', reviewedHead, model: safeModel };
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
  { reviewedHead = null, runId = null, runAttempt = null } = {},
  client = githubClient(),
) {
  const { dispatchWorkflow, pages, comment } = client;
  const workflow = workflowFile(verdict === 'PASS' ? 'mergeGate' : 'repair');
  const inputs = verdict === 'PASS' ? undefined : { pr_number: String(prNumber) };
  const hasDurableReviewIdentity = Boolean(reviewedHead && runId && runAttempt);
  const marker = hasDurableReviewIdentity
    ? reviewFollowupMarker(reviewedHead, verdict, runId, runAttempt)
    : null;

  if (marker) {
    const comments = await pages(`/issues/${prNumber}/comments`);
    if (comments.some(item => String(item.body ?? '').includes(marker))) {
      return { status: 'followup-already-dispatched', verdict };
    }
  }

  await dispatchWorkflow(workflow, inputs);
  if (marker) {
    await comment(
      prNumber,
      `Review follow-up for ${verdict} was dispatched successfully.\n\n${marker}`,
    );
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
  let effectiveHead = reviewedHead;
  let effectiveModel = model;
  if (!effectiveHead) {
    const record = findReviewRunRecord(comments, prNumber, runId, runAttempt);
    if (!record) return { status: 'missing-run-head' };
    effectiveHead = record.reviewedHead;
    if (!['laguna', 'qwen'].includes(effectiveModel)) effectiveModel = record.model;
  }
  if (pr.head.sha !== effectiveHead) return { status: 'stale' };
  const passMarker = reviewVerdictMarker(effectiveHead, 'PASS', runId, runAttempt);
  const changesMarker = reviewVerdictMarker(effectiveHead, 'CHANGES_REQUESTED', runId, runAttempt);
  const appliedVerdict = comments.some(item => String(item.body ?? '').includes(passMarker))
    ? 'PASS'
    : comments.some(item => String(item.body ?? '').includes(changesMarker))
      ? 'CHANGES_REQUESTED'
      : null;
  if (appliedVerdict) {
    return dispatchAfterReview(prNumber, appliedVerdict, {
      reviewedHead: effectiveHead,
      runId,
      runAttempt,
    }, client);
  }

  const labels = prLabelNames(pr);
  const clearVerdict = withoutReviewLabels(labels);
  if (labels.includes(PIPELINE_LABELS.needsHuman)) return { status: 'human' };

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
    await comment(
      prNumber,
      `Independent review ended with ${outcome} for HEAD ${effectiveHead}. This is an infrastructure failure, not a code-review verdict. One automatic retry workflow was queued.${link}\n\n${retryMarker}`,
    );
    try {
      await dispatchWorkflow(workflowFile('reviewer'), {
        pr_number: String(prNumber),
        model: ['laguna', 'qwen'].includes(effectiveModel) ? effectiveModel : 'default',
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

async function gateUnresolvedReviewFailure({
  prNumber, runId, runAttempt, outcome, runUrl, reason,
}, client = githubClient()) {
  const { loadPullRequest, replaceLabels, pages, comment } = client;
  const pr = await loadPullRequest(prNumber);
  const labels = prLabelNames(pr);
  const comments = await pages(`/issues/${prNumber}/comments`);
  const currentVerdictPrefix = `<!-- pi-review:verdict:${pr.head.sha}:`;
  if (comments.some(item => String(item.body ?? '').includes(currentVerdictPrefix))) {
    return { status: 'current-verdict' };
  }

  const clearVerdict = withoutReviewLabels(labels);
  const nextLabels = clearVerdict.includes(PIPELINE_LABELS.needsHuman)
    ? clearVerdict
    : [...clearVerdict, PIPELINE_LABELS.needsHuman];
  if (
    labels.includes(REVIEW_PASSED) ||
    labels.includes(REVIEW_CHANGES_REQUESTED) ||
    !labels.includes(PIPELINE_LABELS.needsHuman)
  ) {
    await replaceLabels(prNumber, nextLabels);
  }

  const marker = `<!-- pi-review:failure-unresolved:${prNumber}:${runId}:attempt:${runAttempt} -->`;
  if (!comments.some(item => String(item.body ?? '').includes(marker))) {
    const link = runUrl ? `\n\nRun: ${runUrl}` : '';
    await comment(
      prNumber,
      `Independent review workflow ended with ${outcome}, but recovery could not prove the exact reviewed HEAD and model (${reason}). No automated verdict or retry was applied; human recovery is required.${link}\n\n${marker}`,
    );
  }
  return { status: 'needs-human', reason };
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
  if (recorded.status !== 'missing-run-head') return recorded;

  if (outcome === 'cancelled') {
    return { status: 'ignored', reason: 'cancelled-without-run-marker' };
  }

  return gateUnresolvedReviewFailure({
    prNumber,
    runId: normalizedRunId,
    runAttempt: normalizedAttempt,
    outcome,
    runUrl,
    reason: 'missing-run-marker',
  }, client);
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
  if (cmd === 'recover-failure') {
    const result = await recoverReviewFailure({
      prNumber, reviewedHead: a, runId: b, runAttempt: process.env.REVIEW_RUN_ATTEMPT,
      outcome: process.env.REVIEW_OUTCOME, runUrl: process.env.REVIEW_RUN_URL,
      model: process.env.REVIEW_MODEL,
    });
    return process.stdout.write(JSON.stringify(result));
  }
  throw new Error('usage: review-state.mjs invalidate <pr> [expected-head] | apply <pr> <head> <verdict> <text-file> | dispatch <pr> <verdict> | record-run <pr> <head> <run-id> | recover-failure <pr> <head> <run-id> | recover-workflow-run');
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e);process.exitCode=1;});
