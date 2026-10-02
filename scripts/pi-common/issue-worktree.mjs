#!/usr/bin/env node
import { runGit as git } from './git.mjs';
import { baseBranch, baseRef, checkpointBranch, issueBranch as issueBranchName } from './project-config.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { resolveRunArtifactId } from './validation-ledger.mjs';

/**
 * Prepare and clean the isolated Implementer worktree.
 *
 * WHY: worktree creation/resume used to be a large shell block in YAML. This
 * helper makes the resume rule explicit and testable: every attempt starts from
 * the current remote default branch, then replays saved issue work as a patch. A checkpoint is
 * preferred over the published issue branch because it may contain newer work.
 *
 * IMPORTANT: saved work is CONTENT only. It is never treated as a base branch
 * or as authoritative pipeline state. If 3-way apply leaves conflicts, the live
 * Implementer resolves them against current dev.
 */

export function issueWorktreePatchPath(tempDir, env = process.env) {
  if (!tempDir) throw new Error('tempDir is required');
  return path.join(tempDir, `pi-resume-${resolveRunArtifactId(env)}.patch`);
}

export function prepareIssueWorktree({ issue, jobDir, tempDir }, env = process.env) {
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('issue must be a positive integer');
  if (!jobDir || !tempDir) throw new Error('jobDir and tempDir are required');
  fs.rmSync(jobDir, { recursive: true, force: true });
  git(['fetch', 'origin', baseBranch()]);
  const start = git(['rev-parse', baseRef()]).out;
  const checkpoint = checkpointBranch(issue);
  const issueBranch = issueBranchName(issue);
  const remoteSha = (ref) => git(['ls-remote', 'origin', `refs/heads/${ref}`]).out.split(/\s+/)[0] ?? '';
  const checkpointExpected = remoteSha(checkpoint);
  const issueBranchExpected = remoteSha(issueBranch);

  let resumeRef = '';
  if (checkpointExpected) {
    git(['fetch', 'origin', `${checkpoint}:refs/remotes/origin/${checkpoint}`]);
    resumeRef = `refs/remotes/origin/${checkpoint}`;
  } else if (issueBranchExpected) {
    git(['fetch', 'origin', `${issueBranch}:refs/remotes/origin/${issueBranch}`]);
    resumeRef = `refs/remotes/origin/${issueBranch}`;
  }

  git(['worktree', 'prune']);
  git(['worktree', 'add', '-B', issueBranch, jobDir, baseRef()]);
  const patch = issueWorktreePatchPath(tempDir, env);
  let resumed = false;
  if (resumeRef) {
    const base = git(['merge-base', baseRef(), resumeRef]).out;
    const diff = git(['diff', '--binary', base, resumeRef]).out;
    fs.writeFileSync(patch, diff ? diff + '\n' : '');
    if (diff) {
      const applied = git(['apply', '--3way', patch], { cwd: jobDir, allowFailure: true });
      if (applied.status !== 0) console.log('Saved work does not apply cleanly to latest dev; conflicts are left for the live Implementer session');
      resumed = git(['diff', '--quiet', baseRef(), '--'], { cwd: jobDir, allowFailure: true }).status !== 0;
      if (!resumed) {
        fs.writeFileSync(patch, '');
        console.log('Saved issue work is already contained in latest dev; treating this attempt as fresh work');
      }
    }
  }
  return { start, checkpointExpected, issueBranchExpected, patch, resumed };
}

export function cleanIssueWorktree({ jobDir, patchFile }) {
  if (jobDir && fs.existsSync(jobDir)) git(['worktree', 'remove', '--force', jobDir], { allowFailure: true });
  if (jobDir) fs.rmSync(jobDir, { recursive: true, force: true });
  if (patchFile) fs.rmSync(patchFile, { force: true });
  git(['worktree', 'prune'], { allowFailure: true });
}

async function main() {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === 'prepare') {
    const result = prepareIssueWorktree({ issue: Number(first), jobDir: second, tempDir: third });
    process.stdout.write(JSON.stringify(result));
    return;
  }
  if (command === 'clean') {
    cleanIssueWorktree({ jobDir: first, patchFile: second });
    return;
  }
  throw new Error('usage: issue-worktree.mjs prepare <issue> <job-dir> <temp-dir> | clean <job-dir> [patch-file]');
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e => { console.error(e); process.exitCode = 1; });
