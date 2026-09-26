#!/usr/bin/env node
import fs from 'node:fs';

const repo = process.env.GITHUB_REPOSITORY ?? process.env.REPO;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const issueNumber = Number(process.argv[2] ?? process.env.PI_ISSUE ?? process.env.ISSUE);
if (!repo || !token || !Number.isSafeInteger(issueNumber)) throw new Error('repository, token and issue number are required');

const root = `https://api.github.com/repos/${repo}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28' };
async function api(path) {
  const response = await fetch(root + path, { headers });
  if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${await response.text()}`);
  return response.json();
}
async function pages(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}
const issue = await api(`/issues/${issueNumber}`);
const prs = await pages('/pulls?state=all&base=dev');
const pr = prs.find(item => item.head.repo?.full_name === repo && item.head.ref === `pi/issue-${issueNumber}`) ?? null;
let ci = null;
let statuses = [];
if (pr) {
  const [runs, statusRows] = await Promise.all([
    api(`/actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&per_page=30`),
    api(`/commits/${pr.head.sha}/statuses?per_page=100`),
  ]);
  ci = (runs.workflow_runs ?? []).filter(run => ['push', 'workflow_dispatch'].includes(run.event))
    .sort((a, b) => b.id - a.id)[0] ?? null;
  statuses = statusRows;
}
const labelNames = issue.labels.map(label => label.name);
const review = statuses.find(status => status.context === 'social-mcp/pi-review')?.state ?? null;
const stage = issue.state === 'closed' && issue.state_reason === 'completed' ? 'COMPLETED'
  : labelNames.includes('pi:mr-created') ? (review === 'success' ? (ci?.conclusion === 'success' ? 'MERGE GATE' : 'CI') : 'REVIEW')
  : labelNames.includes('pi:running') ? 'IMPLEMENTING'
  : labelNames.includes('pi:ready') ? 'READY'
  : labelNames.includes('architect:ready') ? 'ARCHITECTING'
  : labelNames.includes('dispatcher:ready') ? 'DISPATCHABLE'
  : labelNames.includes('architect:epic') ? 'EPIC'
  : labelNames.find(x => ['pi:blocked','pi:failed','pi:needs-human','pi:cancelled'].includes(x)) ?? 'BACKLOG';

const lines = [
  `## Issue #${issueNumber} pipeline`,
  '',
  `**${issue.title}**`,
  '',
  `Stage: **${stage}** · Issue: **${issue.state}${issue.state_reason ? `/${issue.state_reason}` : ''}**`,
  '',
  '| Step | State | Details |',
  '| --- | --- | --- |',
  `| Dispatch | ${labelNames.includes('dispatcher:ready') ? 'queued' : '—'} | labels: ${labelNames.join(', ') || 'none'} |`,
  `| Implement | ${labelNames.includes('pi:running') ? 'running' : labelNames.includes('pi:mr-created') || issue.state === 'closed' ? 'done' : '—'} | branch: \`pi/issue-${issueNumber}\` |`,
  `| Pull request | ${pr ? pr.state : '—'} | ${pr ? `#${pr.number} · ${pr.title} · \`${pr.head.sha.slice(0,12)}\`` : 'not created'} |`,
  `| Review | ${review ?? '—'} | ${pr?.labels?.map(x => x.name).filter(x => x.startsWith('review:')).join(', ') || 'no review label'} |`,
  `| CI | ${ci ? `${ci.status}/${ci.conclusion ?? 'pending'}` : '—'} | ${ci ? `run #${ci.run_number}` : 'no SHA-bound CI run'} |`,
  `| Merge | ${pr?.merged_at ? 'merged' : stage === 'MERGE GATE' ? 'ready for gate' : '—'} | ${pr?.merged_at ?? ''} |`,
  '',
];
const output = lines.join('\n');
console.log(output);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, output + '\n');
