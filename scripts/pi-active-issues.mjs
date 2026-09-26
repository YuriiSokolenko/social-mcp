#!/usr/bin/env node
import { ISSUE_ACTIVE, PIPELINE_LABELS } from './pi-state-machine.mjs';
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
const issues = [];
for (let page = 1; ; page++) {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`, { headers });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
  const batch = await response.json();
  issues.push(...batch);
  if (batch.length < 100) break;
}
const active = new Set([...ISSUE_ACTIVE, PIPELINE_LABELS.queued]);
for (const issue of issues) {
  if (issue.pull_request) continue;
  if (issue.labels.some(label => active.has(label.name))) console.log(issue.number);
}
