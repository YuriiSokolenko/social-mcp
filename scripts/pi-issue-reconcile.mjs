#!/usr/bin/env node
import { childNumbers, parentOf } from './pi-architect.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const start = Number(process.argv[2] ?? process.env.ISSUE);
if (!repo || !token || !Number.isSafeInteger(start)) throw new Error('repository, token and issue number are required');

const root = `https://api.github.com/repos/${repo}`;
async function api(path, method = 'GET', body) {
  const response = await fetch(root + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

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
