#!/usr/bin/env node
import { inspectIssueState, inspectPrState, safeRemovals } from './pi-state-machine.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const apply = process.argv.includes('--apply');
if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');

const base = `https://api.github.com/repos/${repo}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28' };

async function api(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { ...headers, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
async function pages(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}
async function removeLabel(number, label) {
  const response = await fetch(`${base}/issues/${number}/labels/${encodeURIComponent(label)}`, {
    method: 'DELETE', headers,
  });
  if (![200, 204, 404].includes(response.status)) {
    throw new Error(`Cannot remove ${label} from #${number}: ${response.status} ${await response.text()}`);
  }
}

const [allIssues, prs] = await Promise.all([pages('/issues?state=all'), pages('/pulls?state=all')]);
const issues = allIssues.filter(item => !item.pull_request);
const openPiPrIssues = new Set(prs.filter(pr => pr.state === 'open' && pr.base.ref === 'dev' &&
  pr.head.repo?.full_name === repo).map(pr => Number(pr.head.ref.match(/^pi\/issue-(\d+)$/)?.[1])).filter(Number.isSafeInteger));

const report = [];
for (const issue of issues) {
  const findings = inspectIssueState(issue, { hasOpenPiPr: openPiPrIssues.has(issue.number) });
  if (!findings.length) continue;
  const removals = safeRemovals(findings);
  if (apply) for (const label of removals) await removeLabel(issue.number, label);
  report.push({ type: 'issue', number: issue.number, title: issue.title, findings, removals });
}
for (const pr of prs) {
  const findings = inspectPrState(pr);
  if (!findings.length) continue;
  const removals = safeRemovals(findings);
  if (apply) for (const label of removals) await removeLabel(pr.number, label);
  report.push({ type: 'pr', number: pr.number, title: pr.title, findings, removals });
}

console.log(`Pipeline reconciler: ${report.length} object(s) need attention; mode=${apply ? 'apply-safe-repairs' : 'audit'}`);
for (const item of report) {
  console.log(`${item.type.toUpperCase()} #${item.number} ${item.title}`);
  for (const finding of item.findings) console.log(`  - ${finding.severity}: ${finding.code}${finding.labels ? ` [${finding.labels.join(', ')}]` : ''}`);
  if (apply && item.removals.length) console.log(`  repaired: removed ${item.removals.join(', ')}`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import('node:fs');
  const lines = ['## Pipeline reconciliation', '', `Mode: **${apply ? 'safe repair' : 'audit'}** · Findings: **${report.length}**`, ''];
  for (const item of report) lines.push(`- **${item.type} #${item.number}** — ${item.findings.map(x => x.code).join(', ')}${item.removals.length ? `; safe removals: ${item.removals.join(', ')}` : ''}`);
  if (!report.length) lines.push('No inconsistent pipeline state found.');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
