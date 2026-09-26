#!/usr/bin/env node
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
const active = new Set(['pi:ready','pi:running','pi:mr-created','architect:ready','dispatcher:ready']);
for (const issue of issues) {
  if (issue.pull_request) continue;
  if (issue.labels.some(label => active.has(label.name))) console.log(issue.number);
}
