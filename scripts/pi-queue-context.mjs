import { ISSUE_ACTIVE, PIPELINE_LABELS } from './pi-state-machine.mjs';
const phases = new Map([
  ['pi-issue-agent.yml', 'implementation'],
  ['pi-pr-review.yml', 'review'],
  ['pi-pr-fix.yml', 'repair'],
  ['pi-architect.yml', 'architect'],
  ['pi-dispatcher.yml', 'dispatcher'],
]);
const statuses = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

export function summarizeQueue(issues, prs, runs, repo) {
  const openPrs = prs.filter(pr => pr.base?.ref === 'dev').map(pr => {
    const branch = pr.head?.repo?.full_name === repo ? pr.head.ref : '';
    const issue = /^pi\/issue-([1-9]\d*)$/.exec(branch);
    return {
      number: pr.number, issue: issue ? Number(issue[1]) : null,
      title: pr.title, draft: pr.draft, head: pr.head?.sha,
      labels: (pr.labels ?? []).map(label => label.name),
    };
  });
  const prByNumber = new Map(openPrs.map(pr => [pr.number, pr]));
  const activeRuns = runs.flatMap(run => {
    const filename = run.path?.split('/').pop();
    const phase = phases.get(filename);
    if (!phase || !statuses.includes(run.status)) return [];
    const title = run.display_title ?? '';
    const task = /^(?:🤖 Implement|🏗 Architect) #([1-9]\d+)(?:\s|·|$)/u.exec(title);
    const review = /^(?:🔬 Review|🔧 Repair) PR #([1-9]\d+)(?:\s|·|$)/u.exec(title);
    const pr = review ? prByNumber.get(Number(review[1])) : null;
    return [{ id: run.id, phase, status: run.status,
      issue: task ? Number(task[1]) : pr?.issue ?? null,
      pr: review ? Number(review[1]) : null,
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
