#!/usr/bin/env node
import fs from 'node:fs';

import { controlPlanePaths } from './control-plane-policy.mjs';
import { githubClient } from './github-api.mjs';
import { assertImplementerFileSet, IMPLEMENTER_OUTCOMES, readImplementerResult } from './implementer-result.mjs';
import { runGit as git } from './git.mjs';
import { baseBranch, baseRef, checkpointBranch, gitIdentity, issueBranch, projectConfig, workflowFile } from './project-config.mjs';
import { PIPELINE_LABELS } from './state-machine.mjs';
import { computeVerificationState, readValidationLedger, renderValidationSection, VERIFICATION_STATES } from './validation-ledger.mjs';

/**
 * Trusted publication primitives for an Implementer result.
 *
 * WHY: checkpoint, issue-branch push, PR upsert and Reviewer dispatch were large
 * shell/curl blocks embedded in workflow YAML. Publication is control-plane
 * policy and must have one implementation.
 *
 * SAFETY:
 * - checkpoint/issue branch pushes use exact-ref --force-with-lease;
 * - forbidden control-plane paths are checked with the central policy;
 * - credential/runtime files are rejected before checkpoint publication;
 * - PR metadata comes only from the validated submit_result file; missing
 *   terminal metadata is a publication error, never a synthesized success;
 * - GitHub mutations use the shared authenticated API client.
 *
 * This helper never decides whether implementation content is correct. The live
 * Implementer + product-checks own that. This helper publishes an already
 * validated tree.
 */
const lines = (s) => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
const gitPaths = (s) => s.split('\0').filter(Boolean);

const MISSING_OBJECTS = /missing necessary objects/i;
const DEFAULT_PUSH_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]);

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function pushWithMissingObjectRetry(args, {
  cwd,
  token,
  run = git,
  sleep = sleepMs,
  delaysMs = DEFAULT_PUSH_RETRY_DELAYS_MS,
} = {}) {
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    const result = run(args, { cwd, token, allowFailure: true });
    if (result.status === 0) return result;

    const message = [result.err, result.out].filter(Boolean).join('\n');
    const retryable = MISSING_OBJECTS.test(message);
    if (!retryable || attempt === delaysMs.length) {
      throw new Error(message || `git push failed with exit code ${result.status}`);
    }

    sleep(delaysMs[attempt]);
  }
  throw new Error('unreachable push retry state');
}

/**
 * After submit_result succeeds, the remote default branch is an ancestor of HEAD
 * because the finalizer has integrated it. Compare publication content against
 * that integrated base, not the older run-start SHA; otherwise control-plane
 * commits that landed on the base while the agent was running are falsely
 * attributed to the Implementer. Cancelled/pre-submit runs have not necessarily
 * integrated the latest base, so they keep using the run-start commit for
 * checkpoint recovery.
 */
function publicationBase(cwd, startCommit) {
  const integrated = git(['merge-base','--is-ancestor',baseRef(),'HEAD'], { cwd, allowFailure:true }).status === 0;
  return integrated ? baseRef() : startCommit;
}

export function saveCheckpoint({ issue, cwd, startCommit, expectedSha, token }) {
  const { cleanDirectories, cleanFiles } = projectConfig().workspace;
  for (const p of cleanDirectories) fs.rmSync(`${cwd}/${p}`, { recursive: true, force: true });
  for (const p of cleanFiles) fs.rmSync(`${cwd}/${p}`, { force: true });
  const identity = gitIdentity();
  git(['config','user.name',identity.name], { cwd }); git(['config','user.email',identity.email], { cwd });
  if (lines(git(['diff','--name-only','--diff-filter=U'], { cwd }).out).length) return { changed:false, reason:'conflicts' };
  git(['add','-A'], { cwd });
  const staged = lines(git(['diff','--cached','--name-only'], { cwd }).out);
  const sensitive = staged.filter(p => /(^|\/)(\.env(\.|$)|.*\.(db|sqlite3?|pem|key)$|credentials([^/]*$|\/))/.test(p) && !/(^|\/)\.env\.example$/.test(p));
  if (sensitive.length) throw new Error(`Refusing to checkpoint credential/runtime files: ${sensitive.join(', ')}`);
  if (git(['diff','--cached','--quiet'], { cwd, allowFailure:true }).status !== 0) git(['commit','-m',`feat: implement issue #${issue}`], { cwd });
  const base = publicationBase(cwd, startCommit);
  if (git(['diff','--quiet',base,'HEAD'], { cwd, allowFailure:true }).status === 0) return { changed:false, reason:'no-change' };
  const changed = lines(git(['diff','--name-only',base,'HEAD'], { cwd }).out);
  const forbidden = controlPlanePaths(changed);
  if (forbidden.length) throw new Error(`Implementer attempted to modify protected control-plane files: ${forbidden.join(', ')}`);
  const commit = git(['rev-parse','HEAD'], { cwd }).out;
  const ref = `refs/heads/${checkpointBranch(issue)}`;
  git(['push',`--force-with-lease=${ref}:${expectedSha ?? ''}`,'origin',`${commit}:${ref}`], { cwd, token });
  return { changed:true, commit };
}

export function assertPublicationFileSet({ cwd, base, resultFile }) {
  const metadata = readImplementerResult(resultFile);
  if (!metadata || metadata.outcome !== IMPLEMENTER_OUTCOMES.changed) {
    throw new Error('Changed implementation metadata is required before issue-branch publication');
  }
  const changed = gitPaths(git(['diff','--name-only','-z',base,'HEAD'], { cwd }).out);
  assertImplementerFileSet(changed, metadata.files);
  return changed;
}

export function pushIssueBranch({ issue, cwd, startCommit, expectedSha, token, resultFile }) {
  git(['diff','--check'], { cwd });
  const base = publicationBase(cwd, startCommit);
  const changed = assertPublicationFileSet({ cwd, base, resultFile });
  const forbidden = controlPlanePaths(changed);
  if (forbidden.length) throw new Error(`Refusing to publish protected control-plane files: ${forbidden.join(', ')}`);
  const commit = git(['rev-parse','HEAD'], { cwd }).out;
  const ref = `refs/heads/${issueBranch(issue)}`;
  pushWithMissingObjectRetry(
    ['push',`--force-with-lease=${ref}:${expectedSha ?? ''}`,'--set-upstream','origin',`${commit}:${ref}`],
    { cwd, token },
  );
  return { commit };
}

/**
 * Backends whose checks.final execution is actually process-isolated, so a
 * clean result from them can be trusted. Pi's `run_check` runs in a Docker
 * sandbox; its checks.final also runs as plain host code, but the model
 * itself never gets raw shell (every mutation goes through a specific,
 * trusted tool handler), so nothing in that execution tree can survive past
 * the agent session to interfere with checks.final afterward. mini-swe gives
 * the model raw shell with the harness's own environment and has no such
 * isolation: a normally-completed command can still leave a detached
 * background process running after the `mini` CLI itself exits (this is
 * documented upstream mini-swe-agent behavior, not a hypothetical), and nothing
 * today guarantees that process tree is fully torn down before checks.final
 * runs. A survivor could tamper with the real files/output checks.final
 * reads, or forge ledger records -- *including* a forged `backend: 'pi'` on
 * every record, which is exactly why trust must never be decided from the
 * ledger itself. `backend` here must come from a source the implementer's
 * own process tree can never influence: the workflow_dispatch input is fixed
 * by the Actions runner before the job starts and is never routed through
 * $GITHUB_ENV, so nothing that happens during the run -- including a
 * compromised process writing to $GITHUB_ENV -- can alter it. A ledger
 * record's own `backend` field remains useful as display/diagnostic
 * provenance (which backend produced which line), just never as a trust
 * input.
 */
const SANDBOXED_BACKENDS = new Set(['pi']);

export function isUnsandboxedBackend(backend) {
  return !SANDBOXED_BACKENDS.has(backend);
}

/**
 * Pure: given a PR's current labels, the ledger-derived verification state,
 * and whether the harness-known execution backend for this run is
 * unsandboxed, returns the label set `upsertPullRequest` should apply, or
 * `null` if no label change is needed. This is a durable, control-plane
 * gate, not PR-body prose: `pi:needs-human` on the PR is a hard stop already
 * honored by the shared PR-guard (Reviewer/PR Fix) and by Merge Gate, so a
 * PR that is not both fully verified AND executed by a sandboxed backend can
 * never reach an effective review PASS or a merge. Once set, it is only ever
 * added here, never removed -- exactly like every other `pi:needs-human`
 * producer in this codebase (pr-guard.mjs, pi-auto-merge.mjs): clearing it
 * is a human action.
 */
export function nextLabelsForVerification(currentLabels, verificationState, unsandboxedBackend = false) {
  const names = (currentLabels ?? []).map(label => typeof label === 'string' ? label : label.name);
  const trusted = verificationState === VERIFICATION_STATES.VERIFIED && !unsandboxedBackend;
  if (trusted || names.includes(PIPELINE_LABELS.needsHuman)) {
    return null;
  }
  return [...names, PIPELINE_LABELS.needsHuman];
}

export async function upsertPullRequest({ issue, resultFile, owner, ledgerFile, backend }) {
  const { api, replaceLabels } = githubClient();
  const existing = await api(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${issueBranch(issue)}`)}&base=${encodeURIComponent(baseBranch())}`);
  const metadata = readImplementerResult(resultFile);
  if (!metadata || metadata.outcome !== IMPLEMENTER_OUTCOMES.changed) {
    throw new Error('Changed implementer result metadata is required before PR publication');
  }
  const changes = metadata.changes.map(x=>`- ${x}`).join('\n');
  const { records: ledgerRecords, corrupted: ledgerCorrupted } = readValidationLedger(ledgerFile);
  const verificationState = computeVerificationState(ledgerRecords, { corrupted: ledgerCorrupted });
  const unsandboxedBackend = isUnsandboxedBackend(backend);
  const tests = [
    renderValidationSection(ledgerRecords, { corrupted: ledgerCorrupted }),
    `- The merged result is validated by the normal CI run on ${baseBranch()} after merge.`,
  ].join('\n');
  const body = `## Summary\n${metadata.summary}\n\n## Changes\n${changes}\n\n## Security\n${metadata.security_notes || 'No special security impact identified.'}\n\n## Validation\n${tests}\n\n## Known limitations\n${metadata.limitations || 'None identified.'}\n\nCloses #${issue}\n`;
  if (existing[0]) {
    const pr = await api(`/pulls/${existing[0].number}`,'PATCH',{title:metadata.title,body});
    const nextLabels = nextLabelsForVerification(existing[0].labels, verificationState, unsandboxedBackend);
    if (nextLabels) await replaceLabels(pr.number, nextLabels);
    return { number:pr.number, url:pr.html_url, verification_state: verificationState };
  }
  const pr = await api('/pulls','POST',{title:metadata.title,head:issueBranch(issue),base:baseBranch(),body});
  const nextLabels = nextLabelsForVerification([], verificationState, unsandboxedBackend);
  if (nextLabels) await replaceLabels(pr.number, nextLabels);
  return { number:pr.number, url:pr.html_url, verification_state: verificationState };
}

export async function dispatchReviewer(prNumber) {
  const { dispatchWorkflow } = githubClient();
  await dispatchWorkflow(workflowFile('reviewer'), { pr_number: String(prNumber) });
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'checkpoint') return console.log(JSON.stringify(saveCheckpoint({issue:Number(a[0]),cwd:a[1],startCommit:a[2],expectedSha:a[3],token:process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN})));
  if (cmd === 'push') return console.log(JSON.stringify(pushIssueBranch({issue:Number(a[0]),cwd:a[1],startCommit:a[2],expectedSha:a[3],resultFile:a[4],token:process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN})));
  if (cmd === 'pr') return console.log(JSON.stringify(await upsertPullRequest({issue:Number(a[0]),resultFile:a[1],owner:a[2],ledgerFile:a[3],backend:a[4]})));
  if (cmd === 'review') return dispatchReviewer(Number(a[0]));
  throw new Error('unknown publication command');
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e);process.exitCode=1;});
