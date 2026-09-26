#!/usr/bin/env node
import { replaceIssueState, replaceReviewState } from './pi-github-state.mjs';
import { validateIssueTransition, validateReviewTransition } from './pi-state-machine.mjs';

const [kind, action, ...commentParts] = process.argv.slice(2);
const comment = commentParts.join(' ');
const repo = process.env.REPO;
const token = process.env.GH_TOKEN;
const number = kind === 'issue' ? process.env.ISSUE : process.env.PR;
const headSha = process.env.HEAD_SHA ?? '';
if (!['issue', 'review'].includes(kind) || !action || !repo || !token || !number) {
  throw new Error('usage: pi-transition.mjs <issue|review> <action> [comment]');
}
const base = `https://api.github.com/repos/${repo}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28' };
async function api(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { ...headers,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
const names = item => new Set((item.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
async function load() {
  return api(kind === 'issue' ? `/issues/${number}` : `/pulls/${number}`);
}
async function replaceLabels(expected, target, kind) {
  const replace = kind === 'issue' ? replaceIssueState : replaceReviewState;
  await replace({
    number,
    expected: { labels: [...expected] },
    target,
    load,
    patch: async (_number, labels) => api(`/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ labels }) }),
  });
}
async function postComment() {
  if (!comment) return;
  await api(`/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body: comment }) });
}
async function markCommit(state, description) {
  if (!headSha) return;
  await api(`/statuses/${headSha}`, { method: 'POST', body: JSON.stringify({
    state, context: 'social-mcp/pi-review', description,
  }) });
}

const item = await load();
const expected = names(item);
if (kind === 'issue') {
  const target = validateIssueTransition(item, action);
  await replaceLabels(expected, target, 'issue');
  if (action !== 'running') await postComment();
  console.log(`issue #${number}: transitioned to ${target}`);
} else {
  const target = validateReviewTransition(item, action);
  await replaceLabels(expected, target, 'review');
  const statuses = {
    running: ['pending', 'Automated review is running'],
    passed: ['success', 'Automated review and deterministic checks passed'],
    'changes-requested': ['failure', 'Automated review requested changes or checks failed'],
    stale: ['pending', 'Review base changed; waiting for refreshed branch'],
    failed: ['error', 'Automated review workflow failed'],
  };
  const [state, description] = statuses[action];
  await markCommit(state, description);
  if (action !== 'stale') await postComment();
  console.log(`review #${number}: transitioned to ${target}`);
}
