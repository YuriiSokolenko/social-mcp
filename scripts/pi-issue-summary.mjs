#!/usr/bin/env node
import fs from 'node:fs';
import { githubClient } from './github-api.mjs';

const repo = process.env.GITHUB_REPOSITORY ?? process.env.REPO;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const issueNumber = Number(process.argv[2] ?? process.env.PI_ISSUE ?? process.env.ISSUE);
if (!repo || !token || !Number.isSafeInteger(issueNumber)) throw new Error('repository, token and issue number are required');

const { api, pages } = githubClient({ repo, token });
const issue = await api(`/issues/${issueNumber}`);
const prs = await pages('/pulls?state=all&base=dev');
const pr = prs.find(item => item.head.repo?.full_name === repo && item.head.ref === `pi/issue-${issueNumber}`) ?? null;
let integration = null;
let statuses = [];
let base = null;
if (pr) {
  [base, statuses] = await Promise.all([
    api('/git/ref/heads/dev'),
    api(`/commits/${pr.head.sha}/statuses?per_page=100`),
  ]);
  const integrationContext = `social-mcp/integration/${base.object.sha.slice(0, 12)}`;
  integration = statuses.filter(status => status.context === integrationContext)
    .sort((a, b) => new Date(b.updated_at ?? b.created_at ?? 0) - new Date(a.updated_at ?? a.created_at ?? 0))[0]?.state ?? null;
}
const labelNames = issue.labels.map(label => label.name);
const reviewContext = `social-mcp/pi-review/${base?.object?.sha?.slice(0, 12) ?? ''}`;
const review = statuses.filter(status => status.context === reviewContext)
  .sort((a, b) => new Date(b.updated_at ?? b.created_at ?? 0) - new Date(a.updated_at ?? a.created_at ?? 0))[0]?.state ?? null;
const stage = issue.state === 'closed' && issue.state_reason === 'completed' ? 'COMPLETED'
  : labelNames.includes('pi:mr-created') ? (integration !== 'success' ? 'CI' : review === 'success' ? 'MERGE GATE' : 'REVIEW')
  : labelNames.includes('pi:running') ? 'IMPLEMENTING'
  : labelNames.includes('pi:ready') ? 'READY'
  : labelNames.includes('architect:ready') ? 'ARCHITECTING'
  : labelNames.includes('dispatcher:ready') ? 'DISPATCHABLE'
  : labelNames.includes('architect:epic') ? 'EPIC'
  : labelNames.includes('pi:needs-human') ? 'NEEDS HUMAN' : 'BACKLOG';

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
  `| Review | ${review ?? '—'} | SHA-bound status |`,
  `| CI | ${integration ?? '—'} | exact dev+PR pair status |`,
  `| Merge | ${pr?.merged_at ? 'merged' : stage === 'MERGE GATE' ? 'ready for gate' : '—'} | ${pr?.merged_at ?? ''} |`,
  '',
];
const output = lines.join('\n');
console.log(output);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, output + '\n');
