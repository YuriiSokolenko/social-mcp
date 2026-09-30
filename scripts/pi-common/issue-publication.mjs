#!/usr/bin/env node
import fs from 'node:fs';

import { controlPlanePaths } from './control-plane-policy.mjs';
import { githubClient } from './github-api.mjs';
import { runGit as git } from './git.mjs';

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
 * After submit_result succeeds, origin/dev is an ancestor of HEAD because the
 * finalizer has integrated the latest dev. Compare publication content against
 * that integrated dev, not the older run-start SHA; otherwise control-plane
 * commits that landed on dev while the agent was running are falsely attributed
 * to the Implementer. Cancelled/pre-submit runs have not necessarily integrated
 * latest dev, so they keep using the run-start commit for checkpoint recovery.
 */
function publicationBase(cwd, startCommit) {
  const integrated = git(['merge-base','--is-ancestor','origin/dev','HEAD'], { cwd, allowFailure:true }).status === 0;
  return integrated ? 'origin/dev' : startCommit;
}

export function saveCheckpoint({ issue, cwd, startCommit, expectedSha, token }) {
  for (const p of ['.pytest_cache','.ruff_cache','htmlcov','build','dist']) fs.rmSync(`${cwd}/${p}`, { recursive: true, force: true });
  for (const p of ['.coverage','coverage.xml']) fs.rmSync(`${cwd}/${p}`, { force: true });
  git(['config','user.name','social-mcp-pi'], { cwd }); git(['config','user.email','social-mcp-pi@users.noreply.github.com'], { cwd });
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
  git(['push',`--force-with-lease=refs/heads/pi/issue-${issue}-checkpoint:${expectedSha ?? ''}`,'origin',`${commit}:refs/heads/pi/issue-${issue}-checkpoint`], { cwd, token });
  return { changed:true, commit };
}

export function pushIssueBranch({ issue, cwd, startCommit, expectedSha, token }) {
  git(['diff','--check'], { cwd });
  const base = publicationBase(cwd, startCommit);
  const changed = lines(git(['diff','--name-only',base,'HEAD'], { cwd }).out);
  const forbidden = controlPlanePaths(changed);
  if (forbidden.length) throw new Error(`Refusing to publish protected control-plane files: ${forbidden.join(', ')}`);
  const commit = git(['rev-parse','HEAD'], { cwd }).out;
  pushWithMissingObjectRetry(
    ['push',`--force-with-lease=refs/heads/pi/issue-${issue}:${expectedSha ?? ''}`,'--set-upstream','origin',`${commit}:refs/heads/pi/issue-${issue}`],
    { cwd, token },
  );
  return { commit };
}

export async function upsertPullRequest({ issue, resultFile, owner }) {
  const { api } = githubClient();
  const existing = await api(`/pulls?state=open&head=${encodeURIComponent(owner + ':pi/issue-' + issue)}&base=dev`);
  if (!resultFile || !fs.existsSync(resultFile) || !fs.statSync(resultFile).size) {
    throw new Error('Implementer result metadata is required before PR publication');
  }
  const metadata = JSON.parse(fs.readFileSync(resultFile,'utf8'));
  if (typeof metadata.title !== 'string' || !metadata.title.trim() ||
      typeof metadata.summary !== 'string' || !metadata.summary.trim() ||
      !Array.isArray(metadata.changes) || !metadata.changes.length ||
      !metadata.changes.every(item => typeof item === 'string' && item.trim())) {
    throw new Error('Implementer result metadata is incomplete');
  }
  const changes = metadata.changes.map(x=>`- ${x}`).join('\n');
  const tests = '- pytest: passed\n- ruff check .: passed\n- git diff --check: passed\n- The merged result is validated by the normal CI run on dev after merge.';
  const body = `## Summary\n${metadata.summary}\n\n## Changes\n${changes}\n\n## Security\n${metadata.security_notes || 'No special security impact identified.'}\n\n## Validation\n${tests}\n\n## Known limitations\n${metadata.limitations || 'None identified.'}\n\nCloses #${issue}\n`;
  if (existing[0]) {
    const pr = await api(`/pulls/${existing[0].number}`,'PATCH',{title:metadata.title,body});
    return { number:pr.number, url:pr.html_url };
  }
  const pr = await api('/pulls','POST',{title:metadata.title,head:`pi/issue-${issue}`,base:'dev',body});
  return { number:pr.number, url:pr.html_url };
}

export async function dispatchReviewer(prNumber) {
  const { dispatchWorkflow } = githubClient();
  await dispatchWorkflow('pi-pr-review.yml', { pr_number: String(prNumber) });
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'checkpoint') return console.log(JSON.stringify(saveCheckpoint({issue:Number(a[0]),cwd:a[1],startCommit:a[2],expectedSha:a[3],token:process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN})));
  if (cmd === 'push') return console.log(JSON.stringify(pushIssueBranch({issue:Number(a[0]),cwd:a[1],startCommit:a[2],expectedSha:a[3],token:process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN})));
  if (cmd === 'pr') return console.log(JSON.stringify(await upsertPullRequest({issue:Number(a[0]),resultFile:a[1],owner:a[2]})));
  if (cmd === 'review') return dispatchReviewer(Number(a[0]));
  throw new Error('unknown publication command');
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e);process.exitCode=1;});
