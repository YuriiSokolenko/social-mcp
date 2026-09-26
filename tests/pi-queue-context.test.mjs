import test from 'node:test';
import assert from 'node:assert/strict';
import { readQueueContext, summarizeQueue } from '../scripts/pi-queue-context.mjs';

const repo = 'owner/social-mcp';
const issues = [
  { number: 18, title: 'MCP transport', labels: [{ name: 'pi:mr-created' }] },
  { number: 25, title: 'New feature', labels: [{ name: 'dispatcher:ready' }] },
];
const prs = [{ number: 60, title: 'MCP transport PR', draft: false,
  head: { ref: 'pi/issue-18', sha: 'abc', repo: { full_name: repo } },
  base: { ref: 'dev' }, labels: [{ name: 'review:running' }] }];

test('connects running review to PR and issue without treating queued tasks as completed', () => {
  const runs = [
    { id: 1, path: '.github/workflows/pi-pr-review.yml', display_title: '🔬 Review PR #60 · MCP transport PR', status: 'in_progress', html_url: 'https://example.test/1' },
    { id: 2, path: '.github/workflows/pi-issue-agent.yml', display_title: '🤖 Implement #25 · New feature', status: 'queued' },
    { id: 3, path: '.github/workflows/pi-pr-review.yml', display_title: 'Pi PR Review', status: 'in_progress' },
    { id: 4, path: '.github/workflows/pi-issue-agent.yml', display_title: '🤖 Implement #18 · MCP transport', status: 'completed' },
  ];
  const queue = summarizeQueue(issues, prs, runs, repo);
  assert.deepEqual(queue.open_prs[0].labels, ['review:running']);
  assert.equal(queue.open_prs[0].issue, 18);
  assert.deepEqual(queue.active_runs.map(run => run.issue), [18, 25, null]);
  assert.deepEqual(queue.active_issues.map(issue => issue.number), [18, 25]);
});

test('a failing Actions lookup marks the snapshot partial without blocking open PR context', async () => {
  const api = async endpoint => {
    if (endpoint.includes('in_progress')) throw new Error('GitHub Actions unavailable');
    return { total_count: 0, workflow_runs: [] };
  };
  const queue = await readQueueContext(api, repo, issues, prs);
  assert.equal(queue.runs_incomplete, true);
  assert.equal(queue.open_prs[0].issue, 18);
});
