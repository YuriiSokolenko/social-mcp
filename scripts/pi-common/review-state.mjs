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
function reviewVerdictMarker(head, verdict) {
  return `<!-- pi-review:verdict:${head}:${verdict} -->`;
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
export async function applyReview({ prNumber, reviewedHead, verdict, text }, client = githubClient()) {
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
  await comment(prNumber, `${text}\n\n${reviewVerdictMarker(reviewedHead, verdict)}`);
  return { status: 'applied', verdict };
}

export async function dispatchAfterReview(prNumber, verdict) {
  const { dispatchWorkflow } = githubClient();
  const workflow = workflowFile(verdict === 'PASS' ? 'mergeGate' : 'repair');
  const inputs = verdict === 'PASS' ? undefined : { pr_number: String(prNumber) };
  await dispatchWorkflow(workflow, inputs);
}

/**
 * Recover a failed independent review without inventing a review verdict.
 * The first failed run is retried once; a repeated failure or a failed retry
 * request is transferred to a human. A run for an outdated PR head is ignored.
 */
export async function recoverReviewFailure({ prNumber, reviewedHead, runId, outcome, runUrl, model = 'default' }, client = githubClient()) {
  const { loadPullRequest, replaceLabels, pages, comment, dispatchWorkflow } = client;
  const pr = await loadPullRequest(prNumber);
  if (pr.head.sha !== reviewedHead) return { status: 'stale' };

  const labels = prLabelNames(pr);
  const clearVerdict = withoutReviewLabels(labels);
  if (labels.includes(PIPELINE_LABELS.needsHuman)) return { status: 'human' };

  const comments = await pages(`/issues/${prNumber}/comments`);
  const retryPrefix = `<!-- pi-review:failure-retry:${prNumber}:${reviewedHead}:`;
  const retryMarker = `${retryPrefix}${runId} -->`;
  const exhaustedMarker = `<!-- pi-review:failure-exhausted:${prNumber}:${reviewedHead}:${runId} -->`;
  const failedRetryMarker = `<!-- pi-review:failure-retry-request-failed:${prNumber}:${reviewedHead}:${runId} -->`;
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
      `Independent review ended with ${outcome} for HEAD ${reviewedHead}. This is an infrastructure failure, not a code-review verdict. One automatic retry workflow was queued.${link}\n\n${retryMarker}`,
    );
    try {
      await dispatchWorkflow(workflowFile('reviewer'), {
        pr_number: String(prNumber),
        model: ['laguna', 'qwen'].includes(model) ? model : 'default',
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

async function main() {
  const [cmd, rawPr, a, b, c] = process.argv.slice(2);
  const prNumber = Number(rawPr);
  if (cmd === 'invalidate') return invalidateReview(prNumber, a);
  if (cmd === 'apply') {
    const result = await applyReview({ prNumber, reviewedHead: a, verdict: b, text: fs.readFileSync(c, 'utf8') });
    return process.stdout.write(JSON.stringify(result));
  }
  if (cmd === 'dispatch') return dispatchAfterReview(prNumber, a);
  if (cmd === 'recover-failure') {
    const result = await recoverReviewFailure({
      prNumber, reviewedHead: a, runId: b,
      outcome: process.env.REVIEW_OUTCOME, runUrl: process.env.REVIEW_RUN_URL,
      model: process.env.REVIEW_MODEL,
    });
    return process.stdout.write(JSON.stringify(result));
  }
  throw new Error('usage: review-state.mjs invalidate <pr> [expected-head] | apply <pr> <head> <verdict> <text-file> | dispatch <pr> <verdict> | recover-failure <pr> <head> <run-id>');
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e);process.exitCode=1;});
