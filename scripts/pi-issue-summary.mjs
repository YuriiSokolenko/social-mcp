#!/usr/bin/env node
import fs from 'node:fs';
import { githubClient } from './pi-common/github-api.mjs';
import { baseBranch, issueBranch } from './pi-common/project-config.mjs';
import { PIPELINE_LABELS as L } from './pi-common/state-machine.mjs';

const repo = process.env.GITHUB_REPOSITORY ?? process.env.REPO;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const issueNumber = Number(process.argv[2] ?? process.env.PI_ISSUE ?? process.env.ISSUE);
if (!repo || !token || !Number.isSafeInteger(issueNumber)) throw new Error('repository, token and issue number are required');

const { api, pages } = githubClient({ repo, token });
const issue = await api(`/issues/${issueNumber}`);
const prs = await pages(`/pulls?state=all&base=${encodeURIComponent(baseBranch())}`);
const pr = prs.find(item => item.head.repo?.full_name === repo && item.head.ref === issueBranch(issueNumber)) ?? null;
const labelNames = issue.labels.map(label => label.name);

const stage = issue.state === 'closed' && issue.state_reason === 'completed' ? 'COMPLETED'
  : pr?.merged_at ? 'MERGED / DEV CI'
  : labelNames.includes(L.pr) ? 'READY TO MERGE'
  : labelNames.includes(L.running) ? 'IMPLEMENTING'
  : labelNames.includes(L.ready) ? 'READY'
  : labelNames.includes(L.architectReady) ? 'ARCHITECTING'
  : labelNames.includes(L.queued) ? 'DISPATCHABLE'
  : labelNames.includes(L.epic) ? 'EPIC'
  : labelNames.includes(L.needsHuman) ? 'NEEDS HUMAN' : 'BACKLOG';

const lines = [
  `## Issue #${issueNumber} pipeline`,
  '',
  `**${issue.title}**`,
  '',
  `Stage: **${stage}** · Issue: **${issue.state}${issue.state_reason ? `/${issue.state_reason}` : ''}**`,
  '',
  '| Step | State | Details |',
  '| --- | --- | --- |',
  `| Dispatch | ${labelNames.includes(L.queued) ? 'queued' : '—'} | labels: ${labelNames.join(', ') || 'none'} |`,
  `| Implement | ${labelNames.includes(L.running) ? 'running' : labelNames.includes(L.pr) || issue.state === 'closed' ? 'done' : '—'} | branch: \`${issueBranch(issueNumber)}\` |`,
  `| Pull request | ${pr ? pr.state : '—'} | ${pr ? `#${pr.number} · ${pr.title} · \`${pr.head.sha.slice(0,12)}\`` : 'not created'} |`,
  `| Merge | ${pr?.merged_at ? 'merged' : labelNames.includes(L.pr) ? 'ready' : '—'} | ${pr?.merged_at ?? ''} |`,
  `| Dev CI | ${pr?.merged_at ? 'runs on merged dev push' : 'after merge'} | no pre-merge dev-SHA gate |`,
  '',
];
const output = lines.join('\n');
console.log(output);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, output + '\n');
