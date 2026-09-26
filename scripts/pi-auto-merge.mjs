import { pathToFileURL } from 'node:url';

import { githubClient } from './github-api.mjs';

const { api, pages, repo } = githubClient();

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

async function processPR(prSummary) {
  const pr = await api(`/pulls/${prSummary.number}`);
  const issue = issueNumber(pr, repo);
  if (!issue) return;
  const issueData = await api(`/issues/${issue}`);
  const labels = new Set(issueData.labels.map(label => label.name));
  if (issueData.state !== 'open' || !labels.has('pi:mr-created') || labels.has('pi:needs-human')) {
    console.log(`#${pr.number}: issue #${issue} is not ready for merge`);
    return;
  }
  const files = await pages(`/pulls/${pr.number}/files`);
  if (!allowedFiles(files, pr.changed_files)) {
    console.log(`#${pr.number}: changed control files or incomplete file list; human review required`);
    return;
  }

  const sha = pr.head.sha;
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
  const conflictRepair = latestStatus(statuses, `social-mcp/repair-conflict/${base.object.sha.slice(0, 12)}`);
  if (conflict === 'failure') {
    if (!conflictRepair) {
      await api(`/statuses/${sha}`, 'POST', { state: 'pending', context: `social-mcp/repair-conflict/${base.object.sha.slice(0, 12)}`, description: 'Conflict repair dispatched' });
      await api('/actions/workflows/pi-pr-fix.yml/dispatches', 'POST', { ref: 'dev', inputs: { pr_number: String(pr.number), pr_title: pr.title, reason: 'conflict' } });
      console.log(`#${pr.number}: exact integration has a merge conflict; dispatched conflict repair`);
    }
    return;
  }
  const integrationRepair = latestStatus(statuses, `social-mcp/repair-integration/${base.object.sha.slice(0, 12)}`);
  if (integration === 'failure') {
    if (!integrationRepair) {
      await api(`/statuses/${sha}`, 'POST', { state: 'pending', context: `social-mcp/repair-integration/${base.object.sha.slice(0, 12)}`, description: 'Integration repair dispatched' });
      await api('/actions/workflows/pi-pr-fix.yml/dispatches', 'POST', { ref: 'dev', inputs: { pr_number: String(pr.number), pr_title: pr.title, reason: 'integration' } });
      console.log(`#${pr.number}: integration checks failed; dispatched integration repair`);
    }
    return;
  }
  const review = latestStatus(statuses, `social-mcp/pi-review/${base.object.sha.slice(0, 12)}`);
  const reviewRepair = latestStatus(statuses, `social-mcp/repair-review/${base.object.sha.slice(0, 12)}`);
  if (review === 'failure') {
    if (!reviewRepair) {
      await api(`/statuses/${sha}`, 'POST', { state: 'pending', context: `social-mcp/repair-review/${base.object.sha.slice(0, 12)}`, description: 'Review repair dispatched' });
      await api('/actions/workflows/pi-pr-fix.yml/dispatches', 'POST', { ref: 'dev', inputs: { pr_number: String(pr.number), pr_title: pr.title, reason: 'review' } });
      console.log(`#${pr.number}: dispatched review repair for exact pair`);
    }
    return;
  }
  if (integration !== 'success') {
    console.log(`#${pr.number}: waiting for tested integration (dev ${base.object.sha.slice(0, 12)} + PR ${sha.slice(0, 12)})`);
    return;
  }
  if (!review) {
    await api(`/statuses/${sha}`, 'POST', { state: 'pending', context: `social-mcp/pi-review/${base.object.sha.slice(0, 12)}`, description: 'Automated review dispatched' });
    await api('/actions/workflows/pi-pr-review.yml/dispatches', 'POST', { ref: 'dev', inputs: { pr_number: String(pr.number), pr_title: pr.title } });
    console.log(`#${pr.number}: dispatched review for exact pair`);
    return;
  }
  if (review !== 'success') {
    console.log(`#${pr.number}: waiting for exact-pair review`);
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
  // Global concurrency prevents two runs from merging against the same base in parallel.
  const prs = await pages('/pulls?state=open&base=dev');
  for (const pr of prs) {
    try { await processPR(pr); }
    catch (error) { console.error(`#${pr.number}: ${error.message}`); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();