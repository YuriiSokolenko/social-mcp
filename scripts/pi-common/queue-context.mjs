/**
 * Builds a read-only snapshot of currently active Pi work.
 *
 * WHY: Dispatcher/Architect need the same view of open PRs and active workflow
 * runs without transporting state between workflows. Every caller still makes
 * decisions from fresh GitHub data; this snapshot is context, never authority.
 *
 * Actions lookup failures are surfaced as runs_incomplete rather than hidden.
 */

import { baseBranch, parseIssueBranch, workflowFile } from './project-config.mjs';
import { ISSUE_ACTIVE, PIPELINE_LABELS } from './state-machine.mjs';
const phases = new Map([
  [workflowFile('implementer'), 'implementation'],
  [workflowFile('architect'), 'architect'],
  [workflowFile('dispatcher'), 'dispatcher'],
]);
const statuses = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

export function summarizeQueue(issues, prs, runs, repo) {
  const openPrs = prs.filter(pr => pr.base?.ref === baseBranch()).map(pr => {
    const branch = pr.head?.repo?.full_name === repo ? pr.head.ref : '';
    const issue = parseIssueBranch(branch);
    return {
      number: pr.number, issue,
      title: pr.title, draft: pr.draft, head: pr.head?.sha,
      labels: (pr.labels ?? []).map(label => label.name),
    };
  });
  const activeRuns = runs.flatMap(run => {
    const filename = run.path?.split('/').pop();
    const phase = phases.get(filename);
    if (!phase || !statuses.includes(run.status)) return [];
    const title = run.display_title ?? '';
    const task = /^(?:🤖 Implement|🏗 Architect) #([1-9]\d+)(?:\s|·|$)/u.exec(title);
    return [{ id: run.id, phase, status: run.status,
      issue: task ? Number(task[1]) : null,
      pr: null,
      url: run.html_url }];
  }).sort((a, b) => a.id - b.id);
  const linked = new Set([
    ...openPrs.map(pr => pr.issue).filter(Boolean),
    ...activeRuns.map(run => run.issue).filter(Boolean),
  ]);
  const activeLabels = new Set([...ISSUE_ACTIVE, PIPELINE_LABELS.epic]);
  const activeIssues = issues.filter(issue =>
    linked.has(issue.number) || issue.labels.some(label => activeLabels.has(label.name)))
    .map(issue => ({ number: issue.number, title: issue.title,
      labels: issue.labels.map(label => label.name) }));
  return { captured_at: new Date().toISOString(), active_issues: activeIssues,
    open_prs: openPrs, active_runs: activeRuns };
}

async function runsForStatus(api, status) {
  const runs = [];
  for (let page = 1; ; page++) {
    const data = await api(`/actions/runs?status=${status}&per_page=100&page=${page}`);
    const batch = data?.workflow_runs ?? [];
    runs.push(...batch);
    if (batch.length < 100) return runs;
  }
}

export async function readQueueContext(api, repo, issues, prs) {
  const responses = await Promise.allSettled(statuses.map(status => runsForStatus(api, status)));
  const runs = responses.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  return {
    ...summarizeQueue(issues, prs, runs, repo),
    runs_incomplete: responses.some(result => result.status === 'rejected'),
  };
}
