#!/usr/bin/env node
import { childNumbers, parentOf } from './pi-architect.mjs';
import { githubClient } from './github-api.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const start = Number(process.argv[2] ?? process.env.ISSUE);
if (!repo || !token || !Number.isSafeInteger(start)) throw new Error('repository, token and issue number are required');

const { api } = githubClient({ repo, token });

let childNumber = start;
const visited = new Set();
while (childNumber && !visited.has(childNumber)) {
  visited.add(childNumber);
  const child = await api(`/issues/${childNumber}`);
  const parentNumber = parentOf(child.body);
  if (!parentNumber || visited.has(parentNumber)) break;
  const parent = await api(`/issues/${parentNumber}`);
  if (!parent.labels.some(label => label.name === 'architect:epic')) break;
  const numbers = childNumbers(parent.body);
  if (!numbers.includes(childNumber)) break;
  const siblings = await Promise.all(numbers.map(number => api(`/issues/${number}`)));
  if (!siblings.every(issue => issue.state === 'closed' && issue.state_reason === 'completed')) break;
  if (parent.state === 'open') {
    await api(`/issues/${parentNumber}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
    console.log(`Closed completed architect epic #${parentNumber}`);
  } else if (parent.state_reason !== 'completed') break;
  childNumber = parentNumber;
}
