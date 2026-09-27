#!/usr/bin/env node
import fs from 'node:fs';

import { githubClient } from './github-api.mjs';
import { controlPlanePaths } from './control-plane-policy.mjs';
import { prLabelNames, withoutReviewLabels } from './pr-labels.mjs';

/**
 * Shared PRE-MODEL gate for PR-based Pi stages.
 *
 * The Reviewer and PR Fix must make the same security decision before any
 * model code runs:
 *   1. the PR still exists, is open, targets dev and comes from this repo;
 *   2. its branch is exactly pi/issue-N;
 *   3. pi:needs-human is a hard stop;
 *   4. the COMPLETE changed-file list contains no protected control-plane path.
 *
 * Keeping this here avoids two independent curl/jq/pagination implementations
 * in workflow YAML. githubClient.pages() is important: checking only the first
 * 100 files would make the security boundary incomplete for large PRs.
 *
 * Output is JSON written to a caller-supplied file. A gated PR is marked
 * pi:needs-human (for control-plane changes) and returns {skip:true}; this is a
 * normal automation stop, not an execution failure.
 */
const { loadPullRequest, replaceLabels, pages, repo } = githubClient();

export async function preparePr(prNumber) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('PR number must be a positive integer');
  const pr = await loadPullRequest(prNumber);
  const branch = pr.head?.ref ?? '';
  const match = /^pi\/issue-([1-9]\d*)$/.exec(branch);
  if (pr.state !== 'open' || pr.base?.ref !== 'dev' ||
      pr.base?.repo?.full_name !== repo || pr.head?.repo?.full_name !== repo || !match) {
    throw new Error(`PR #${prNumber} is not an open same-repository pi/issue-N PR targeting dev`);
  }

  const labels = prLabelNames(pr);
  if (labels.includes('pi:needs-human')) {
    return { skip: true, reason: 'needs-human', pr: prNumber, issue: Number(match[1]), head: pr.head.sha, branch };
  }

  const files = await pages(`/pulls/${prNumber}/files`);
  const paths = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  const forbidden = controlPlanePaths(paths);
  if (forbidden.length) {
    // Remove stale review verdicts and make human ownership durable.
    const next = withoutReviewLabels(labels);
    if (!next.includes('pi:needs-human')) next.push('pi:needs-human');
    await replaceLabels(prNumber, next);
    return {
      skip: true, reason: 'control-plane', pr: prNumber, issue: Number(match[1]),
      head: pr.head.sha, branch, forbidden,
    };
  }

  return { skip: false, pr: prNumber, issue: Number(match[1]), head: pr.head.sha, branch };
}

async function main() {
  const [rawPr, output] = process.argv.slice(2);
  const pr = Number(rawPr);
  if (!output) throw new Error('usage: pr-guard.mjs <pr-number> <output-json>');
  const result = await preparePr(pr);
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(`PR #${pr}: ${result.skip ? `automation skipped (${result.reason})` : 'agent automation allowed'}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
