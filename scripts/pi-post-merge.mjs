#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { githubClient } from './pi-common/github-api.mjs';
import { closingIssueNumber } from './pi-common/pr-guard.mjs';
import { checkpointBranch, issueBranch } from './pi-common/project-config.mjs';
import { ISSUE_STATE_LABELS } from './pi-common/state-machine.mjs';

export { closingIssueNumber as linkedIssueNumber };

export async function finalizeMergedPush(sha, client = githubClient()) {
  const { api, repo, loadIssue, updateIssue, deleteRef } = client;
  const prs = await api(`/commits/${sha}/pulls`);
  const pr = prs.find(item => item.merged_at && item.merge_commit_sha === sha);
  if (!pr) {
    console.log(`${sha}: no merged Pi PR associated with this dev push; nothing to finalize`);
    return null;
  }

  const issueNumber = closingIssueNumber(pr, repo);
  if (!issueNumber) {
    console.log(`#${pr.number}: merged PR is not a valid Pi issue PR; nothing to finalize`);
    return null;
  }

  const issue = await loadIssue(issueNumber);
  if (issue.state === 'open') {
    const labels = (issue.labels ?? [])
      .map(label => typeof label === 'string' ? label : label.name)
      .filter(label => !ISSUE_STATE_LABELS.has(label));
    await updateIssue(issueNumber, { state: 'closed', state_reason: 'completed', labels });
  }

  await deleteRef(`heads/${issueBranch(issueNumber)}`);
  await deleteRef(`heads/${checkpointBranch(issueNumber)}`);
  console.log(`#${issueNumber}: green dev CI confirmed merged PR #${pr.number}; issue closed and Pi refs cleaned`);
  return { issue: issueNumber, pr: pr.number };
}

async function main() {
  const sha = process.argv[2] ?? process.env.GITHUB_SHA;
  if (!sha) throw new Error('usage: pi-post-merge.mjs <dev-sha>');
  await finalizeMergedPush(sha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
