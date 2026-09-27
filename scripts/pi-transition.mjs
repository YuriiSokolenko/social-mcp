#!/usr/bin/env node
import { replaceIssueState } from './pi-common/github-state.mjs';
import { validateIssueTransition } from './pi-common/state-machine.mjs';
import { githubClient } from './pi-common/github-api.mjs';

const [kind, action, ...commentParts] = process.argv.slice(2);
const comment = commentParts.join(' ');
const { api: request } = githubClient();
const api = (path, options = {}) =>
  request(path, options.method ?? 'GET', options.body ? JSON.parse(options.body) : undefined);
const number = process.env.ISSUE;
if (kind !== 'issue' || !action || !number) {
  throw new Error('usage: pi-transition.mjs issue <action> [comment]');
}
const names = item => new Set((item.labels ?? []).map(label => typeof label === 'string' ? label : label.name));

async function load() {
  return api(`/issues/${number}`);
}
async function replaceIssueLabels(expected, target, transition) {
  await replaceIssueState({
    number,
    expected: { labels: [...expected] },
    target,
    load,
    validateCurrent: current => validateIssueTransition(current, transition),
    patch: async (_number, labels) => api(`/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ labels }) }),
  });
}
async function postComment() {
  if (!comment) return;
  await api(`/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body: comment }) });
}

const item = await load();
const expected = names(item);
const target = validateIssueTransition(item, action);
await replaceIssueLabels(expected, target, action);
if (action !== 'running') await postComment();
console.log(`issue #${number}: transitioned to ${target}`);
