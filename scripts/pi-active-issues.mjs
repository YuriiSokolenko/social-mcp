#!/usr/bin/env node
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
});
if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
const issues = await response.json();
const active = new Set(['pi:ready','pi:running','pi:mr-created','architect:ready','dispatcher:ready']);
for (const issue of issues) {
  if (issue.pull_request) continue;
  if (issue.labels.some(label => active.has(label.name))) console.log(issue.number);
}
