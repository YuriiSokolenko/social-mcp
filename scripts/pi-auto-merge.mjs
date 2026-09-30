import { pathToFileURL } from 'node:url';

import { githubClient } from './pi-common/github-api.mjs';
import { controlPlanePaths } from './pi-common/control-plane-policy.mjs';
import { REVIEW_CHANGES_REQUESTED, REVIEW_PASSED, withoutReviewLabels, withReviewVerdict } from './pi-common/pr-labels.mjs';
import { baseBranch, parseIssueBranch, workflowFile } from './pi-common/project-config.mjs';
import { PIPELINE_LABELS } from './pi-common/state-machine.mjs';

const { api, pages, repo, loadPullRequest, loadIssue, replaceLabels, comment, dispatchWorkflow, workflowRuns } = githubClient();

export function linkedIssueNumber(pr, repository) {
  const number = parseIssueBranch(pr.head?.ref ?? '');
  if (pr.draft || pr.base?.ref !== baseBranch() ||
      pr.base?.repo?.full_name !== repository || pr.head?.repo?.full_name !== repository || number === null) return null;
  if (!Number.isSafeInteger(number) || !new RegExp(`\\b(?:closes|fixes|resolves)\\s+#${number}\\b`, 'i').test(pr.body ?? '')) return null;
  return number;
}

export function issueNumber(pr, repository) {
  return pr.state === 'open' ? linkedIssueNumber(pr, repository) : null;
}

export function allowedFiles(files, changedCount) {
  const paths = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  return files.length === changedCount && controlPlanePaths(paths).length === 0;
}

export function prCiVerdict(runs, headSha) {
  const matching = runs
    .filter(run => run?.event === 'pull_request' && run?.head_sha === headSha)
    .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
  if (!matching.length) return { state: 'pending', run: null };

  const run = matching[0];
  if (run.status !== 'completed') return { state: 'pending', run };
  return { state: run.conclusion === 'success' ? 'success' : 'failed', run };
}

async function loadPrCiVerdict(headSha) {
  const workflow = workflowFile('ci');
  const runs = await workflowRuns(
    `/actions/workflows/${encodeURIComponent(workflow)}/runs?event=pull_request&head_sha=${encodeURIComponent(headSha)}`,
  );
  return prCiVerdict(runs, headSha);
}

async function processPR(prSummary) {
  const pr = await loadPullRequest(prSummary.number);
  const issue = issueNumber(pr, repo);
  if (!issue) return;

  const prLabels = new Set((pr.labels ?? []).map(label => label.name));
  if (prLabels.has(PIPELINE_LABELS.needsHuman)) {
    console.log(`#${pr.number}: PR requires human attention; automation skipped`);
    return;
  }

  const issueData = await loadIssue(issue);
  const labels = new Set(issueData.labels.map(label => label.name));
  if (issueData.state !== 'open' || !labels.has(PIPELINE_LABELS.pr) || labels.has(PIPELINE_LABELS.needsHuman)) {
    console.log(`#${pr.number}: issue #${issue} is not ready for merge`);
    return;
  }

  if (!prLabels.has(REVIEW_PASSED)) {
    console.log(`#${pr.number}: waiting for independent review PASS`);
    return;
  }

  const files = await pages(`/pulls/${pr.number}/files`);
  if (!allowedFiles(files, pr.changed_files)) {
    console.log(`#${pr.number}: changed control files or incomplete file list; human review required`);
    const nextLabels = withoutReviewLabels([...prLabels]);
    if (!nextLabels.includes(PIPELINE_LABELS.needsHuman)) nextLabels.push(PIPELINE_LABELS.needsHuman);
    await replaceLabels(pr.number, nextLabels);
    const marker = `<!-- merge-gate:unsafe-pr:${pr.number} -->`;
    const comments = await pages(`/issues/${issue}/comments`);
    if (!comments.some(comment => (comment.body ?? '').includes(marker))) {
      await comment(issue, `Merge Gate stopped PR #${pr.number}: it changes CI/control-plane files or the changed-file list was incomplete. Human review is required.\n\n${marker}`);
    }
    return;
  }

  // Reviewer and CI must both validate the exact PR HEAD that will be merged.
  // The gate reads the current HEAD directly from GitHub; no SHA is transported
  // between workflows and no synthetic dev+PR integration commit is created.
  const sha = pr.head.sha;
  const fresh = await loadPullRequest(pr.number);
  if (fresh.state !== 'open' || fresh.head.sha !== sha) {
    console.log(`#${pr.number}: PR changed before merge; next gate run will reconsider it`);
    return;
  }

  const ci = await loadPrCiVerdict(sha);
  if (ci.state === 'pending') {
    console.log(`#${pr.number}: waiting for green PR CI for ${sha}; checking the next PR`);
    return;
  }
  if (ci.state === 'failed') {
    const conclusion = ci.run?.conclusion ?? 'failure';
    const runId = ci.run?.id ?? 'unknown';
    const marker = `<!-- merge-gate:ci-failure:${pr.number}:${sha}:${runId} -->`;
    const comments = await pages(`/issues/${pr.number}/comments`);
    if (!comments.some(item => (item.body ?? '').includes(marker))) {
      const runUrl = ci.run?.html_url ? ` Run: ${ci.run.html_url}` : '';
      await comment(
        pr.number,
        `Merge Gate blocked this PR because CI for the reviewed HEAD ${sha} completed with ${conclusion}.${runUrl} Review PASS is invalidated and PR Fix now owns repair.\n\n${marker}`,
      );
    }
    await replaceLabels(pr.number, withReviewVerdict([...prLabels], REVIEW_CHANGES_REQUESTED));
    await dispatchWorkflow(workflowFile('repair'), { pr_number: String(pr.number) });
    console.log(
      `#${pr.number}: PR CI ${conclusion} for ${sha}; assigned ${REVIEW_CHANGES_REQUESTED}, dispatched PR Fix, checking the next PR`,
    );
    return;
  }

  try {
    const merged = await api(`/pulls/${pr.number}/merge`, 'PUT', { sha, merge_method: 'squash' });
    if (!merged.merged) throw new Error(`merge API did not confirm merge`);
    console.log(`#${pr.number}: merged ${sha} after green PR CI; dev push CI now validates the merged result`);
    return true;
  } catch (error) {
    if (!/merge conflicts/i.test(error.message)) throw error;

    const marker = `<!-- merge-gate:conflict-pr:${pr.number}:${sha} -->`;
    const comments = await pages(`/issues/${issue}/comments`);
    if (!comments.some(comment => (comment.body ?? '').includes(marker))) {
      await comment(issue, `Merge Gate found that PR #${pr.number} conflicts with current dev. The approved HEAD can no longer be merged unchanged, so the old review is invalidated and PR Fix will integrate current dev, resolve conflicts, validate the result, and send the new HEAD through Reviewer again.\n\n${marker}`);
    }

    const nextLabels = withReviewVerdict([...prLabels], REVIEW_CHANGES_REQUESTED);
    await replaceLabels(pr.number, nextLabels);
    await dispatchWorkflow(workflowFile('repair'), { pr_number: String(pr.number) });
    console.log(`#${pr.number}: merge conflict; assigned ${REVIEW_CHANGES_REQUESTED} ownership and dispatched PR Fix`);
    return 'blocked';
  }
}

export async function main() {
  const prs = await pages(`/pulls?state=open&base=${encodeURIComponent(baseBranch())}`);
  for (const pr of prs) {
    try {
      if (await processPR(pr)) break;
    } catch (error) {
      console.error(`#${pr.number}: ${error.message}`);
      process.exitCode = 1;
      break;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
