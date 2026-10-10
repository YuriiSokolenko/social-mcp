import { pathToFileURL } from 'node:url';

import { githubClient } from './pi-common/github-api.mjs';
import { controlPlanePaths } from './pi-common/control-plane-policy.mjs';
import { closingIssueNumber } from './pi-common/pr-guard.mjs';
import { REVIEW_CHANGES_REQUESTED, REVIEW_PASSED, withoutReviewLabels, withReviewVerdict } from './pi-common/pr-labels.mjs';
import { baseBranch, projectConfig, workflowFile } from './pi-common/project-config.mjs';
import { PIPELINE_LABELS } from './pi-common/state-machine.mjs';

const { api, raw, pages, repo, loadPullRequest, loadIssue, replaceLabels, comment, dispatchWorkflow, workflowRuns } = githubClient();

/** CI step names whose failure PR Fix may repair (`.agent-harness.json` checks.ciRepairableSteps). */
export const productCiSteps = () => new Set(projectConfig().checks.ciRepairableSteps);

export function infraRetryEndpoint(run) {
  return run?.conclusion === 'failure' ? 'rerun-failed-jobs' : 'rerun';
}

export function linkedIssueNumber(pr, repository) {
  return pr.draft ? null : closingIssueNumber(pr, repository);
}

export function issueNumber(pr, repository) {
  return pr.state === 'open' ? linkedIssueNumber(pr, repository) : null;
}

export function allowedFiles(files, changedCount) {
  const paths = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  return files.length === changedCount && controlPlanePaths(paths).length === 0;
}

export function failedProductCiSteps(jobs) {
  return jobs.flatMap(job => job.steps ?? [])
    .filter(step => step?.conclusion === 'failure' && productCiSteps().has(step.name))
    .map(step => step.name);
}

export function prCiVerdict(runs, headSha, jobs = []) {
  const matching = runs
    .filter(run => run?.event === 'pull_request' && run?.head_sha === headSha)
    .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
  if (!matching.length) return { state: 'pending', run: null };

  const run = matching[0];
  if (run.status !== 'completed') return { state: 'pending', run };
  if (run.conclusion === 'success') {
    // A workflow-level success can still represent a required workflow that
    // scheduled no jobs (for example, action_required with an empty run).
    // Require trusted job metadata to show at least one successful job.
    return jobs.some(job => job?.conclusion === 'success')
      ? { state: 'success', run }
      : { state: 'infra_failure', run };
  }

  // A failed workflow is repairable only when trusted Actions metadata shows
  // that a product check itself failed. Cancellation, timeout, runner/setup
  // failures, and failures before product checks execute are infrastructure.
  const failedProductSteps = run.conclusion === 'failure' ? failedProductCiSteps(jobs) : [];
  return {
    state: failedProductSteps.length ? 'code_failure' : 'infra_failure',
    run,
    failedProductSteps,
  };
}

export function devCiVerdict(runs, headSha) {
  const matching = runs
    .filter(run => ['push', 'workflow_dispatch'].includes(run?.event) && run?.head_sha === headSha)
    .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
  if (!matching.length) return { state: 'pending', run: null };

  const run = matching[0];
  if (run.status !== 'completed') return { state: 'pending', run };
  return { state: run.conclusion === 'success' ? 'success' : 'failed', run };
}

async function loadDevCiVerdict() {
  const ref = await api(`/git/ref/heads/${encodeURIComponent(baseBranch())}`);
  const sha = ref?.object?.sha;
  if (!sha) throw new Error(`Cannot resolve current ${baseBranch()} HEAD`);

  const workflow = workflowFile('ci');
  const runs = await workflowRuns(
    `/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(baseBranch())}&head_sha=${encodeURIComponent(sha)}`,
  );
  return { sha, ...devCiVerdict(runs, sha) };
}

async function loadPrCiVerdict(headSha) {
  const workflow = workflowFile('ci');
  const runs = await workflowRuns(
    `/actions/workflows/${encodeURIComponent(workflow)}/runs?event=pull_request&head_sha=${encodeURIComponent(headSha)}`,
  );
  const initial = prCiVerdict(runs, headSha);
  if (initial.state === 'pending' || initial.state === 'code_failure') return initial;

  try {
    const jobsData = await api(`/actions/runs/${initial.run.id}/jobs?per_page=100`);
    return prCiVerdict(runs, headSha, jobsData.jobs ?? []);
  } catch (error) {
    console.warn(`Cannot load CI jobs for run ${initial.run.id}; treating it as infrastructure: ${error.message}`);
    return { ...initial, metadataError: error.message };
  }
}

async function processInfraFailure(pr, prLabels, sha, ci) {
  const conclusion = ci.run?.conclusion ?? 'unknown';
  const runId = ci.run?.id;
  const runAttempt = Number(ci.run?.run_attempt ?? 1);
  const runUrl = ci.run?.html_url ? ` Run: ${ci.run.html_url}` : '';
  const comments = await pages(`/issues/${pr.number}/comments`);

  const retryMarker = `<!-- merge-gate:ci-infra-retry:${pr.number}:${sha}:${runId} -->`;
  if (runAttempt <= 1) {
    if (comments.some(item => (item.body ?? '').includes(retryMarker))) {
      console.log(`#${pr.number}: infrastructure CI retry already requested for run ${runId}; checking the next PR`);
      return;
    }

    const retryAction = infraRetryEndpoint(ci.run);
    try {
      const response = await raw(`/actions/runs/${runId}/${retryAction}`, 'POST');
      if (!response.ok) throw new Error(`POST /actions/runs/${runId}/${retryAction}: ${response.status} ${await response.text()}`);
      try {
        await comment(
          pr.number,
          `Merge Gate classified CI for reviewed HEAD ${sha} as an infrastructure failure (${conclusion}), so PR Fix will not run. CI retry was requested once.${runUrl}\n\n${retryMarker}`,
        );
      } catch (error) {
        console.warn(`#${pr.number}: CI retry succeeded but diagnostic comment failed: ${error.message}`);
      }
      console.log(`#${pr.number}: infrastructure CI ${conclusion} for ${sha}; requested bounded retry of run ${runId}, checking the next PR`);
    } catch (error) {
      const nextLabels = [...prLabels];
      if (!nextLabels.includes(PIPELINE_LABELS.needsHuman)) nextLabels.push(PIPELINE_LABELS.needsHuman);
      await replaceLabels(pr.number, nextLabels);
      const marker = `<!-- merge-gate:ci-infra-retry-failed:${pr.number}:${sha}:${runId} -->`;
      if (!comments.some(item => (item.body ?? '').includes(marker))) {
        await comment(
          pr.number,
          `Merge Gate could not request the bounded CI retry for run ${runId}: ${error.message}. Human infrastructure recovery is required.\n\n${marker}`,
        );
      }
      console.log(`#${pr.number}: infrastructure retry request failed; marked ${PIPELINE_LABELS.needsHuman}, checking the next PR`);
    }
    return;
  }

  const marker = `<!-- merge-gate:ci-infra-exhausted:${pr.number}:${sha}:${runId} -->`;
  const nextLabels = [...prLabels];
  if (!nextLabels.includes(PIPELINE_LABELS.needsHuman)) nextLabels.push(PIPELINE_LABELS.needsHuman);
  await replaceLabels(pr.number, nextLabels);
  if (!comments.some(item => (item.body ?? '').includes(marker))) {
    await comment(
      pr.number,
      `Merge Gate classified CI for reviewed HEAD ${sha} as an infrastructure failure (${conclusion}) after the single automatic retry. PR Fix was not dispatched; human infrastructure recovery is required.${runUrl}\n\n${marker}`,
    );
  }
  console.log(`#${pr.number}: infrastructure CI failure persisted after bounded retry; marked ${PIPELINE_LABELS.needsHuman}, checking the next PR`);
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
  if (ci.state === 'infra_failure') {
    await processInfraFailure(pr, [...prLabels], sha, ci);
    return;
  }
  if (ci.state === 'code_failure') {
    const conclusion = ci.run?.conclusion ?? 'failure';
    const runId = ci.run?.id ?? 'unknown';
    const marker = `<!-- merge-gate:ci-failure:${pr.number}:${sha}:${runId} -->`;
    const runUrl = ci.run?.html_url ? ` Run: ${ci.run.html_url}` : '';
    const failedChecks = ci.failedProductSteps?.length ? ` Failed product checks: ${ci.failedProductSteps.join(', ')}.` : '';

    // The label is the durable ownership transfer. If dispatch fails, Reconciler
    // sees review:changes-requested and restarts PR Fix after its recovery grace.
    await replaceLabels(pr.number, withReviewVerdict([...prLabels], REVIEW_CHANGES_REQUESTED));
    let dispatched = false;
    try {
      await dispatchWorkflow(workflowFile('repair'), { pr_number: String(pr.number) });
      dispatched = true;
    } catch (error) {
      console.error(`#${pr.number}: PR Fix dispatch failed after ownership transfer; Reconciler will recover it: ${error.message}`);
    }

    try {
      const comments = await pages(`/issues/${pr.number}/comments`);
      if (!comments.some(item => (item.body ?? '').includes(marker))) {
        await comment(
          pr.number,
          dispatched
            ? `Merge Gate blocked this PR because CI for the reviewed HEAD ${sha} failed a product check.${failedChecks}${runUrl} Review PASS is invalidated and PR Fix now owns repair.\n\n${marker}`
            : `Merge Gate blocked this PR because CI for the reviewed HEAD ${sha} failed a product check.${failedChecks}${runUrl} Review PASS is invalidated; PR Fix dispatch failed and Reconciler owns recovery.\n\n${marker}`,
        );
      }
    } catch (error) {
      console.warn(`#${pr.number}: code-failure diagnostic comment failed: ${error.message}`);
    }
    console.log(
      `#${pr.number}: PR CI ${conclusion} for ${sha}; assigned ${REVIEW_CHANGES_REQUESTED}, ${dispatched ? 'dispatched PR Fix' : 'deferred repair to Reconciler'}, checking the next PR`,
    );
    return;
  }

  const devCi = await loadDevCiVerdict();
  if (devCi.state !== 'success') {
    console.log(`#${pr.number}: waiting for green ${baseBranch()} CI for ${devCi.sha}; current state=${devCi.state}`);
    return 'blocked';
  }

  try {
    const merged = await api(`/pulls/${pr.number}/merge`, 'PUT', { sha, merge_method: 'squash' });
    if (!merged.merged) throw new Error(`merge API did not confirm merge`);
    await dispatchWorkflow(workflowFile('ci'));
    console.log(`#${pr.number}: merged ${sha} after green PR CI; dispatched explicit ${baseBranch()} CI for the merged result`);
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
