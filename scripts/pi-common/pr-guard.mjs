#!/usr/bin/env node
import fs from 'node:fs';

import { githubClient } from './github-api.mjs';
import { controlPlanePaths } from './control-plane-policy.mjs';
import { prLabelNames, withoutReviewLabels } from './pr-labels.mjs';
import { baseBranch, issueBranchPrefix, parseIssueBranch } from './project-config.mjs';
import { PIPELINE_LABELS } from './state-machine.mjs';

/**
 * Shared PRE-MODEL gate for PR-based Pi stages.
 *
 * The Reviewer and PR Fix must make the same security decision before any
 * model code runs:
 *   1. the PR still exists and comes from this repo; closed/merged PRs are a normal skip, while open PRs must target dev;
 *   2. its branch is exactly <issue branch prefix>N;
 *   3. the needs-human label is a hard stop;
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
const { loadPullRequest, loadIssue, replaceLabels, pages, repo } = githubClient();

/**
 * The issue a same-repository `<issue branch prefix>N` PR into the base branch
 * explicitly closes (`closes|fixes|resolves #N` in its body), otherwise null.
 * Shared by Merge Gate (open PRs) and post-merge finalization (merged PRs).
 */
export function closingIssueNumber(pr, repository) {
  const number = parseIssueBranch(pr.head?.ref ?? '');
  if (pr.base?.ref !== baseBranch() || pr.base?.repo?.full_name !== repository ||
      pr.head?.repo?.full_name !== repository || !Number.isSafeInteger(number)) return null;
  return new RegExp(`\\b(?:closes|fixes|resolves)\\s+#${number}\\b`, 'i').test(pr.body ?? '') ? number : null;
}

export async function preparePr(prNumber) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('PR number must be a positive integer');
  const pr = await loadPullRequest(prNumber);
  const branch = pr.head?.ref ?? '';
  const issueNumber = parseIssueBranch(branch);
  if (pr.head?.repo?.full_name !== repo || issueNumber === null) {
    throw new Error(`PR #${prNumber} is not a same-repository ${issueBranchPrefix()}N PR`);
  }

  if (pr.state !== 'open') {
    return {
      skip: true,
      reason: pr.merged ? 'merged' : 'closed',
      pr: prNumber,
      issue: issueNumber,
      head: pr.head.sha,
      branch,
    };
  }
  if (pr.base?.ref !== baseBranch() || pr.base?.repo?.full_name !== repo) {
    throw new Error(`PR #${prNumber} is not an open same-repository ${issueBranchPrefix()}N PR targeting ${baseBranch()}`);
  }
  const labels = prLabelNames(pr);
  if (labels.includes(PIPELINE_LABELS.needsHuman)) {
    return { skip: true, reason: 'needs-human', pr: prNumber, issue: issueNumber, head: pr.head.sha, branch };
  }

  const files = await pages(`/pulls/${prNumber}/files`);
  const paths = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  const forbidden = controlPlanePaths(paths);
  if (forbidden.length) {
    // Remove stale review verdicts and make human ownership durable.
    const next = withoutReviewLabels(labels);
    if (!next.includes(PIPELINE_LABELS.needsHuman)) next.push(PIPELINE_LABELS.needsHuman);
    await replaceLabels(prNumber, next);
    return {
      skip: true, reason: 'control-plane', pr: prNumber, issue: issueNumber,
      head: pr.head.sha, branch, forbidden,
    };
  }

  const issue = await loadIssue(issueNumber);
  return {
    skip: false,
    pr: prNumber,
    issue: issueNumber,
    head: pr.head.sha,
    branch,
    review: {
      issue: {
        number: issueNumber,
        title: issue.title ?? '',
        body: issue.body ?? '',
      },
      pullRequest: {
        number: prNumber,
        title: pr.title ?? '',
        base: pr.base?.ref ?? '',
        head: branch,
      },
      changedFiles: files.map(file => ({
        filename: file.filename,
        status: file.status ?? '',
        previousFilename: file.previous_filename ?? null,
      })),
    },
  };
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
