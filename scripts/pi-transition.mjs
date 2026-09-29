#!/usr/bin/env node
import fs from 'node:fs';

import { replaceIssueState } from './pi-common/github-state.mjs';
import { ISSUE_STATE_LABELS, isIssueTransitionNoop, validateIssueTransition } from './pi-common/state-machine.mjs';
import { githubClient } from './pi-common/github-api.mjs';

const [kind, action, ...commentParts] = process.argv.slice(2);
const comment = commentParts.join(' ');
const { api, comment: postIssueComment } = githubClient();
const number = process.env.ISSUE;
if (kind !== 'issue' || !action || !number) {
  throw new Error('usage: pi-transition.mjs issue <action> [comment]');
}
const names = item => new Set((item.labels ?? []).map(label => typeof label === 'string' ? label : label.name));

async function load() {
  return api(`/issues/${number}`);
}
async function replaceIssueLabels(expected, target, transition, { complete = false } = {}) {
  await replaceIssueState({
    number,
    expected: { labels: [...expected] },
    target,
    load,
    validateCurrent: current => validateIssueTransition(current, transition),
    patch: async (_number, labels) => api(`/issues/${number}`, 'PATCH',
      complete ? { labels, state: 'closed', state_reason: 'completed' } : { labels }),
  });
}
async function postComment() {
  if (!comment) return;
  await postIssueComment(number, comment);
}
function markTerminalOutput() {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'terminal=true\n');
}
async function mergedImplementationPr() {
  const owner = String(process.env.GITHUB_REPOSITORY ?? '').split('/')[0];
  if (!owner) return null;
  const head = encodeURIComponent(`${owner}:pi/issue-${number}`);
  const prs = await api(`/pulls?state=closed&head=${head}&base=dev&per_page=100`);
  return prs.find(pr => pr.merged_at) ?? null;
}
async function completeFromMergedImplementation(item) {
  if (item.state !== 'open') return null;
  const pr = await mergedImplementationPr();
  if (!pr) return null;
  const labels = [...names(item)].filter(label => !ISSUE_STATE_LABELS.has(label));
  await api(`/issues/${number}`, 'PATCH', { labels, state: 'closed', state_reason: 'completed' });
  markTerminalOutput();
  console.log(`issue #${number}: merged implementation PR #${pr.number} already completed the issue; ignored stale ${action} transition`);
  return pr;
}

const item = await load();
if (isIssueTransitionNoop(item, action)) {
  markTerminalOutput();
  console.log(`issue #${number}: ${action} is a no-op because the issue is already closed`);
} else if (await completeFromMergedImplementation(item)) {
  // Merged implementation ownership is terminal even if an earlier cleanup missed the issue.
} else {
  const expected = names(item);
  const target = validateIssueTransition(item, action);
  await replaceIssueLabels(expected, target, action, { complete: action === 'satisfied' });
  if (action !== 'running') await postComment();
  console.log(`issue #${number}: transitioned to ${target}`);
}
