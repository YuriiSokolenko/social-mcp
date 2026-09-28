#!/usr/bin/env node
import fs from 'node:fs';
import { runGit as git } from './git.mjs';

import { githubClient } from './github-api.mjs';
import { controlPlanePaths } from './control-plane-policy.mjs';
import { prLabelNames, withoutReviewLabels } from './pr-labels.mjs';


/**
 * Publish an already validated PR repair. The PR is re-read immediately before
 * mutation: pi:needs-human is a hard stop and HEAD must still equal the SHA the
 * repair session started from. The exact-ref lease is the final race guard.
 */
export async function publishRepair({ prNumber, issue, cwd, headRef, expectedHead, token }) {
  const { loadPullRequest } = githubClient();
  const pr = await loadPullRequest(prNumber);
  const labels = prLabelNames(pr);
  if (labels.includes('pi:needs-human')) return { published:false, reason:'human' };
  if (pr.head.sha !== expectedHead) throw new Error(`PR #${prNumber} HEAD moved during repair`);

  git(['diff','--check'], { cwd });
  for (const p of ['.venv','.pytest_cache','.ruff_cache','htmlcov','build','dist']) fs.rmSync(`${cwd}/${p}`, { recursive:true, force:true });
  for (const p of ['.coverage','coverage.xml']) fs.rmSync(`${cwd}/${p}`, { force:true });
  git(['config','user.name','social-mcp-pi'],{cwd}); git(['config','user.email','social-mcp-pi@users.noreply.github.com'],{cwd});
  git(['add','-A'],{cwd});
  if (git(['diff','--cached','--quiet'],{cwd,allowFailure:true}).status !== 0) {
    const changed = git(['diff','--cached','--name-only'],{cwd}).out.split(/\r?\n/).filter(Boolean);
    const forbidden = controlPlanePaths(changed);
    if (forbidden.length) throw new Error(`Refusing to publish protected control-plane files: ${forbidden.join(', ')}`);
    git(['commit','-m',`fix: repair issue #${issue}`],{cwd});
  }

  // submit_repair may have created a clean merge commit while integrating
  // current dev. A clean index does not mean the PR HEAD is unchanged.
  const localHead = git(['rev-parse','HEAD'],{cwd}).out;
  if (localHead === expectedHead) return { published:false, needsReview:true, reason:'already-fixed' };

  const remote = git(['ls-remote','origin',`refs/heads/${headRef}`],{cwd}).out.split(/\s+/)[0] ?? '';
  if (remote !== expectedHead) throw new Error('PR head moved; refusing stale push');
  git(['push',`--force-with-lease=refs/heads/${headRef}:${expectedHead}`,'origin',`${localHead}:refs/heads/${headRef}`],{cwd,token});
  return { published:true, needsReview:true, head:localHead };
}

/**
 * Successful repair owns the handoff back to Reviewer. Only after the new HEAD
 * exists do we clear the old review verdict and dispatch exactly one fresh
 * Reviewer run.
 */
export async function handoffToReviewer(prNumber) {
  const { loadPullRequest, replaceLabels, dispatchWorkflow } = githubClient();
  const pr = await loadPullRequest(prNumber);
  const labels = withoutReviewLabels(pr);
  await replaceLabels(prNumber, labels);
  await dispatchWorkflow('pi-pr-review.yml', { pr_number: String(prNumber) });
}
async function main(){
 const [cmd,...a]=process.argv.slice(2);
 if(cmd==='publish') return console.log(JSON.stringify(await publishRepair({prNumber:Number(a[0]),issue:Number(a[1]),cwd:a[2],headRef:a[3],expectedHead:a[4],token:process.env.GH_TOKEN??process.env.GITHUB_TOKEN})));
 if(cmd==='review') return handoffToReviewer(Number(a[0]));
 throw new Error('usage: repair-publication.mjs publish <pr> <issue> <cwd> <head-ref> <expected-head> | review <pr>');
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)main().catch(e=>{console.error(e);process.exitCode=1;});
