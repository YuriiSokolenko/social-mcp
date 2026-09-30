#!/usr/bin/env node
import fs from 'node:fs';

import { githubClient } from './github-api.mjs';
import { REVIEW_CHANGES_REQUESTED, REVIEW_PASSED, prLabelNames, withoutReviewLabels, withReviewVerdict } from './pr-labels.mjs';
import { workflowFile } from './project-config.mjs';
import { PIPELINE_LABELS } from './state-machine.mjs';


async function replaceReviewLabels(prNumber, target = null) {
  const { loadPullRequest, replaceLabels } = githubClient();
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
export async function invalidateReview(prNumber) {
  await replaceReviewLabels(prNumber);
}

/**
 * Atomically apply a model review against the HEAD it actually reviewed.
 * Human gate and HEAD are re-read immediately before mutation so a verdict
 * cannot race a human takeover or a synchronize event.
 */
export async function applyReview({ prNumber, reviewedHead, verdict, text }) {
  const { loadPullRequest, replaceLabels, comment } = githubClient();
  const pr = await loadPullRequest(prNumber);
  const currentLabels = prLabelNames(pr);
  if (currentLabels.includes(PIPELINE_LABELS.needsHuman)) return { status: 'human' };
  if (pr.head.sha !== reviewedHead) {
    await replaceReviewLabels(prNumber);
    return { status: 'stale' };
  }
  const target = verdict === 'PASS' ? REVIEW_PASSED : REVIEW_CHANGES_REQUESTED;
  await replaceLabels(prNumber, withReviewVerdict(currentLabels, target));
  await comment(prNumber, text);
  return { status: 'applied', verdict };
}

export async function dispatchAfterReview(prNumber, verdict) {
  const { dispatchWorkflow } = githubClient();
  const workflow = workflowFile(verdict === 'PASS' ? 'mergeGate' : 'repair');
  const inputs = verdict === 'PASS' ? undefined : { pr_number: String(prNumber) };
  await dispatchWorkflow(workflow, inputs);
}

async function main() {
  const [cmd, rawPr, a, b, c] = process.argv.slice(2);
  const prNumber = Number(rawPr);
  if (cmd === 'invalidate') return invalidateReview(prNumber);
  if (cmd === 'apply') {
    const result = await applyReview({ prNumber, reviewedHead: a, verdict: b, text: fs.readFileSync(c, 'utf8') });
    return process.stdout.write(JSON.stringify(result));
  }
  if (cmd === 'dispatch') return dispatchAfterReview(prNumber, a);
  throw new Error('usage: review-state.mjs invalidate <pr> | apply <pr> <head> <verdict> <text-file> | dispatch <pr> <verdict>');
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e);process.exitCode=1;});
