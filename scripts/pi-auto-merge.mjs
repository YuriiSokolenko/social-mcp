import { pathToFileURL } from 'node:url';
import { childNumbers, parentOf } from './pi-architect.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const apiRoot = `https://api.github.com/repos/${repo}`;
const reviewContext = 'social-mcp/pi-review';
const ciMarker = 'social-mcp/merge-ci-dispatched';
const reviewMarker = 'social-mcp/merge-review-dispatched';
const conflictMarker = 'social-mcp/merge-conflict-fix-dispatched';

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
  return statuses.find(status => status.context === context)?.state ?? null;
}

export function latestCI(runs, sha, branch) {
  // A direct push already starts CI for normal branch updates. Reuse that run instead of
  // dispatching a duplicate workflow for the same SHA. pull_request runs stay excluded
  // because bot-authored PR runs may be action_required and cannot satisfy the merge gate.
  return runs.filter(run => run.head_sha === sha && run.head_branch === branch &&
    ['push', 'workflow_dispatch'].includes(run.event))
    .sort((a, b) => b.id - a.id)[0] ?? null;
}

export function allowedFiles(files, changedCount) {
  return files.length === changedCount &&
    files.every(file => [file.filename, file.previous_filename].filter(Boolean).every(name =>
      !name.startsWith('.github/workflows/') && !/^scripts\/pi-[^/]+\.(?:mjs|sh)$/.test(name)));
}

export function needsCIDispatch(ci, marker) {
  return !ci;
}

export function shouldDeferBranchUpdate(pr) {
  // review:running: a reviewer is actively reading this exact head; don't move it under them.
  // review:changes-requested: Pi PR Fix was just dispatched for this exact head and may still be
  // starting up. Updating the branch here raced Pi PR Fix in practice: auto-merge dispatched a
  // second, duplicate review for the merged head while the fix job kept working, wasting a full
  // reviewer run. Wait for the fix cycle to either push a new head (which re-triggers review) or
  // finish with no changes (leaving review:changes-requested for a person to look at).
  return pr.labels?.some(label => ['review:running', 'review:changes-requested'].includes(label.name)) ?? false;
}

async function mark(sha, context, state, description) {
  return api(`/statuses/${sha}`, 'POST', { context, state, description: description.slice(0, 140) });
}

async function trigger(pr, sha, statuses, runs) {
  const currentReview = latestStatus(statuses, reviewContext);
  if (!currentReview && !latestStatus(statuses, reviewMarker)) {
    await api('/actions/workflows/pi-pr-review.yml/dispatches', 'POST', { ref: 'dev', inputs: { pr_number: String(pr.number), pr_title: pr.title } });
    await mark(sha, reviewMarker, 'success', `Review dispatch requested for PR #${pr.number}`);
  }
  const ci = latestCI(runs, sha, pr.head.ref);
  if (needsCIDispatch(ci, latestStatus(statuses, ciMarker))) {
    await api('/actions/workflows/ci.yml/dispatches', 'POST', { ref: 'dev', inputs: { target_sha: sha, target_ref: pr.head.ref, pr_number: String(pr.number), pr_title: `${pr.head.ref} @ ${sha.slice(0, 12)}` } });
    await mark(sha, ciMarker, 'success', `CI dispatch requested for PR #${pr.number}`);
  }
}

export async function finishArchitectParents(childNumber, issueApi = api) {
  const visited = new Set();
  while (childNumber && !visited.has(childNumber)) {
    visited.add(childNumber);
    const child = await issueApi(`/issues/${childNumber}`);
    const parentNumber = parentOf(child.body);
    if (!parentNumber || visited.has(parentNumber)) return;
    const parent = await issueApi(`/issues/${parentNumber}`);
    if (!parent.labels.some(label => label.name === 'architect:epic')) return;
    const numbers = childNumbers(parent.body);
    if (!numbers.includes(childNumber)) return;
    const siblings = await Promise.all(numbers.map(number => issueApi(`/issues/${number}`)));
    if (!siblings.every(issue => issue.state === 'closed' && issue.state_reason === 'completed')) return;
    if (parent.state === 'open') {
      await issueApi(`/issues/${parentNumber}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
      console.log(`Architect parent #${parentNumber}: all child issues completed`);
    } else if (parent.state_reason !== 'completed') {
      return;
    }
    childNumber = parentNumber;
  }
}

async function finalizeMergedPR(pr, issue) {
  const current = await api(`/issues/${issue}`);
  const labels = new Set(current.labels.map(label => label.name));
  // Keep this label until both closure and dispatch succeed, so a later run
  // can finish an interrupted merge without dispatching unfinished work.
  if (!labels.has('pi:mr-created')) return;
  if (current.state === 'open') {
    await api(`/issues/${issue}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
    console.log(`#${pr.number}: completed issue #${issue} after merge into dev`);
  } else if (current.state_reason !== 'completed') {
    return;
  }
  await finishArchitectParents(issue);
  await api('/actions/workflows/pi-dispatcher.yml/dispatches', 'POST', { ref: 'dev', inputs: { source: `merged PR #${pr.number} · ${pr.title}` } });
  await api(`/issues/${issue}/labels/pi%3Amr-created`, 'DELETE');
  console.log(`#${pr.number}: dispatcher started`);
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
  const [base, comparison, statusData, ciData] = await Promise.all([
    api('/git/ref/heads/dev'),
    api(`/compare/dev...${sha}`),
    api(`/commits/${sha}/statuses?per_page=100`),
    api(`/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`),
  ]);
  if (comparison.behind_by > 0) {
    if (shouldDeferBranchUpdate(pr)) {
      console.log(`#${pr.number}: dev moved during review; waiting for the review to finish before updating the branch`);
      return;
    }
    if (pr.mergeable === false && pr.mergeable_state === 'dirty') {
      if (latestStatus(statusData, conflictMarker)) {
        console.log(`#${pr.number}: merge conflict; repair already dispatched for ${sha.slice(0, 12)}`);
        return;
      }
      await api('/actions/workflows/pi-pr-fix.yml/dispatches', 'POST', { ref: 'dev', inputs: { pr_number: String(pr.number), pr_title: pr.title, reason: 'conflict' } });
      await mark(sha, conflictMarker, 'success', `Conflict repair dispatched for PR #${pr.number}`);
      console.log(`#${pr.number}: merge conflict with dev; dispatched Pi conflict repair`);
      return;
    }
    await api(`/pulls/${pr.number}/update-branch`, 'PUT', { expected_head_sha: sha });
    // A branch update made with GITHUB_TOKEN may not start another gate run.
    // Wake the gate after this run exits so it can dispatch checks for the new SHA.
    await api('/actions/workflows/pi-auto-merge.yml/dispatches', 'POST', { ref: 'dev' });
    console.log(`#${pr.number}: updated branch; queued checks for new SHA`);
    return;
  }
  if (comparison.status !== 'ahead' || comparison.behind_by !== 0) {
    console.log(`#${pr.number}: head is not ahead of current dev`);
    return;
  }

  const statuses = statusData;
  const runs = ciData.workflow_runs ?? [];
  await trigger(pr, sha, statuses, runs);
  const ci = latestCI(runs, sha, pr.head.ref);
  const review = latestStatus(statuses, reviewContext);
  if (ci?.status !== 'completed' || ci.conclusion !== 'success' || review !== 'success' ||
      !pr.labels.some(label => label.name === 'review:passed')) {
    console.log(`#${pr.number}: waiting for CI and SHA-bound review (${sha.slice(0, 12)})`);
    return;
  }
  // Re-read mutable state immediately before the merge; the merge API also rejects a moved head.
  const fresh = await api(`/pulls/${pr.number}`);
  const freshBase = await api('/git/ref/heads/dev');
  if (fresh.head.sha !== sha || freshBase.object.sha !== base.object.sha ||
      fresh.mergeable !== true || !fresh.labels.some(label => label.name === 'review:passed')) {
    console.log(`#${pr.number}: head, dev, review label or mergeability changed`);
    return;
  }
  const merged = await api(`/pulls/${pr.number}/merge`, 'PUT', { sha, merge_method: 'squash' });
  if (!merged.merged) throw new Error(`#${pr.number}: merge API did not confirm merge`);
  console.log(`#${pr.number}: merged ${sha}`);
  await finalizeMergedPR(pr, issue);
}

export async function main() {
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  // Recover a merge interrupted after GitHub accepted it but before the
  // linked issue was completed or the dispatcher was started.
  const mergedPRs = await pages('/pulls?state=closed&base=dev');
  for (const pr of mergedPRs) {
    if (!pr.merged_at || !pr.labels?.some(label => label.name === 'review:passed')) continue;
    const issue = linkedIssueNumber(pr, repo);
    if (!issue) continue;
    try { await finalizeMergedPR(pr, issue); }
    catch (error) { console.error(`#${pr.number}: ${error.message}`); process.exitCode = 1; }
  }
  // Global concurrency prevents two runs from merging against the same base in parallel.
  const prs = await pages('/pulls?state=open&base=dev');
  for (const pr of prs) {
    try { await processPR(pr); }
    catch (error) { console.error(`#${pr.number}: ${error.message}`); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
