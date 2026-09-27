#!/usr/bin/env node
import fs from 'node:fs';

import { githubClient } from './github-api.mjs';

const REVIEW = new Set(['review:passed', 'review:changes-requested']);
const labels = pr => (pr.labels ?? []).map(x => x.name);

async function replaceReviewLabels(prNumber, target = null) {
  const { api } = githubClient();
  const pr = await api(`/pulls/${prNumber}`);
  const keep = labels(pr).filter(x => !x.startsWith('review:'));
  const next = target ? [...keep, target] : keep;
  await api(`/issues/${prNumber}/labels`, 'PUT', { labels: next });
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
  const { api } = githubClient();
  const pr = await api(`/pulls/${prNumber}`);
  const currentLabels = labels(pr);
  if (currentLabels.includes('pi:needs-human')) return { status: 'human' };
  if (pr.head.sha !== reviewedHead) {
    await replaceReviewLabels(prNumber);
    return { status: 'stale' };
  }
  const target = verdict === 'PASS' ? 'review:passed' : 'review:changes-requested';
  if (!REVIEW.has(target)) throw new Error(`unsupported review verdict: ${verdict}`);
  const keep = currentLabels.filter(x => !x.startsWith('review:'));
  await api(`/issues/${prNumber}/labels`, 'PUT', { labels: [...keep, target] });
  await api(`/issues/${prNumber}/comments`, 'POST', { body: text });
  return { status: 'applied', verdict };
}

export async function dispatchAfterReview(prNumber, verdict) {
  const { api } = githubClient();
  const workflow = verdict === 'PASS' ? 'pi-auto-merge.yml' : 'pi-pr-fix.yml';
  const body = verdict === 'PASS'
    ? { ref: 'dev' }
    : { ref: 'dev', inputs: { pr_number: String(prNumber) } };
  await api(`/actions/workflows/${workflow}/dispatches`, 'POST', body);
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
