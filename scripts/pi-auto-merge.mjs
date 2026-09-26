import { pathToFileURL } from 'node:url';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const apiRoot = `https://api.github.com/repos/${repo}`;


async function api(path, method = 'GET', body) {
  const response = await fetch(`${apiRoot}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
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

export function linkedIssueNumber(pr, repository) {
  const match = /^pi\/issue-([1-9]\d*)$/.exec(pr.head?.ref ?? '');
  if (pr.draft || pr.base?.ref !== 'dev' ||
      pr.base?.repo?.full_name !== repository || pr.head?.repo?.full_name !== repository || !match) return null;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || !new RegExp(`\\b(?:closes|fixes|resolves)\\s+#${number}\\b`, 'i').test(pr.body ?? '')) return null;
  return number;
}

export function issueNumber(pr, repository) {
  return pr.state === 'open' ? linkedIssueNumber(pr, repository) : null;
}

export function latestStatus(statuses, context) {
  return statuses
    .filter(status => status.context === context)
    .sort((a, b) => new Date(b.updated_at ?? b.created_at ?? 0) - new Date(a.updated_at ?? a.created_at ?? 0))[0]?.state ?? null;
}

export function allowedFiles(files, changedCount) {
  return files.length === changedCount &&
    files.every(file => [file.filename, file.previous_filename].filter(Boolean).every(name =>
      !name.startsWith('.github/workflows/') && !/^scripts\/pi-[^/]+\.(?:mjs|sh)$/.test(name)));
}

async function hasLiveReview(prNumber) {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const data = await api(`/actions/workflows/pi-pr-review.yml/runs?event=workflow_dispatch&branch=dev&status=${status}&per_page=100`);
    if ((data.workflow_runs ?? []).some(run => run.display_title?.startsWith(`🔬 Review PR #${prNumber} ·`) || run.display_title === `🔬 Review PR #${prNumber}`)) return true;
  }
  return false;
}

async function hasLiveRepair(prNumber) {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const data = await api(`/actions/workflows/pi-pr-fix.yml/runs?event=workflow_dispatch&branch=dev&status=${status}&per_page=100`);
    if ((data.workflow_runs ?? []).some(run =>
      run.display_title?.startsWith(`🔧 Repair PR #${prNumber} ·`) || run.display_title === `🔧 Repair PR #${prNumber}`)) return true;
  }
  return false;
}

async function processPR(prSummary) {
  const pr = await api(`/pulls/${prSummary.number}`);
  const issue = issueNumber(pr, repo);
  if (!issue) return;
  const issueData = await api(`/issues/${issue}`);
  const labels = new Set(issueData.labels.map(label => label.name));
  if (issueData.state !== 'open' || !labels.has('pi:mr-created') || labels.has('pi:needs-human') || labels.has('pi:failed')) {
    console.log(`#${pr.number}: issue #${issue} is not ready for merge`);
    return;
  }
  const files = await pages(`/pulls/${pr.number}/files`);
  if (!allowedFiles(files, pr.changed_files)) {
    console.log(`#${pr.number}: changed control files or incomplete file list; human review required`);
    return;
  }

  const sha = pr.head.sha;
  const repairLive = await hasLiveRepair(pr.number);
  const [base, statusData] = await Promise.all([
    api('/git/ref/heads/dev'),
    api(`/commits/${sha}/statuses?per_page=100`),
  ]);
  const statuses = statusData;
  const integrationContext = `social-mcp/integration/${base.object.sha.slice(0, 12)}`;
  const integration = latestStatus(statuses, integrationContext);
  if (!integration) {
    await api('/actions/workflows/ci.yml/dispatches', 'POST', {
      ref: 'dev',
      inputs: { target_sha: sha, target_ref: pr.head.ref, pr_number: String(pr.number), integration_base_sha: base.object.sha },
    });
    console.log(`#${pr.number}: dispatched integration CI for exact pair`);
    return;
  }
  const conflict = latestStatus(statuses, `social-mcp/integration-conflict/${base.object.sha.slice(0, 12)}`);
  if (conflict === 'failure') {
    if (!repairLive) {
      await api('/actions/workflows/pi-pr-fix.yml/dispatches', 'POST', { ref: 'dev', inputs: { pr_number: String(pr.number), pr_title: pr.title, reason: 'conflict' } });
      console.log(`#${pr.number}: exact integration has a merge conflict; dispatched conflict repair`);
    }
    return;
  }
  const review = latestStatus(statuses, `social-mcp/pi-review/${base.object.sha.slice(0, 12)}`);
  if (review === 'failure') {
    if (!repairLive) {
      await api('/actions/workflows/pi-pr-fix.yml/dispatches', 'POST', { ref: 'dev', inputs: { pr_number: String(pr.number), pr_title: pr.title, reason: 'review' } });
      console.log(`#${pr.number}: dispatched review repair for exact pair`);
    }
    return;
  }
  if (integration !== 'success' || review !== 'success') {
    console.log(`#${pr.number}: waiting for tested integration (dev ${base.object.sha.slice(0, 12)} + PR ${sha.slice(0, 12)}) and review`);
    return;
  }
  // Re-read mutable state immediately before the merge; the merge API also rejects a moved head.
  const fresh = await api(`/pulls/${pr.number}`);
  const freshBase = await api('/git/ref/heads/dev');
  if (fresh.head.sha !== sha || freshBase.object.sha !== base.object.sha) {
    console.log(`#${pr.number}: head or dev changed`);
    return;
  }
  const merged = await api(`/pulls/${pr.number}/merge`, 'PUT', { sha, merge_method: 'squash' });
  if (!merged.merged) throw new Error(`#${pr.number}: merge API did not confirm merge`);
  console.log(`#${pr.number}: merged ${sha}; linked issue #${issue} will close via the PR closing keyword`);
}

export async function main() {
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  // Global concurrency prevents two runs from merging against the same base in parallel.
  const prs = await pages('/pulls?state=open&base=dev');
  for (const pr of prs) {
    try { await processPR(pr); }
    catch (error) { console.error(`#${pr.number}: ${error.message}`); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();