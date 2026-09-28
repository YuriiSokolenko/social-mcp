#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { githubClient } from './pi-common/github-api.mjs';
import { ISSUE_STATE_LABELS } from './pi-common/state-machine.mjs';

export function linkedIssueNumber(pr, repository) {
  const match = /^pi\/issue-([1-9]\d*)$/.exec(pr.head?.ref ?? '');
  if (pr.base?.ref !== 'dev' || pr.base?.repo?.full_name !== repository ||
      pr.head?.repo?.full_name !== repository || !match) return null;
  const number = Number(match[1]);
  return new RegExp(`\\b(?:closes|fixes|resolves)\\s+#${number}\\b`, 'i').test(pr.body ?? '') ? number : null;
}

export async function finalizeMergedPush(sha, client = githubClient()) {
  const { api, repo, loadIssue, updateIssue, deleteRef } = client;
  const prs = await api(`/commits/${sha}/pulls`);
  const pr = prs.find(item => item.merged_at && item.merge_commit_sha === sha);
  if (!pr) {
    console.log(`${sha}: no merged Pi PR associated with this dev push; nothing to finalize`);
    return null;
  }

  const issueNumber = linkedIssueNumber(pr, repo);
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

  await deleteRef(`heads/pi/issue-${issueNumber}`);
  await deleteRef(`heads/pi/issue-${issueNumber}-checkpoint`);
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
