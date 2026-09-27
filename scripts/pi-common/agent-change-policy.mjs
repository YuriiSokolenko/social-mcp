import { spawnSync } from 'node:child_process';
import { controlPlanePaths } from './control-plane-policy.mjs';

/**
 * Return every path changed by an agent, including committed, staged,
 * unstaged and untracked files. Security checks must not inspect only HEAD:
 * an agent can leave dangerous edits in the working tree before publication.
 */
function git(args, cwd = process.cwd()) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'git failed').trim());
  return (r.stdout ?? '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

export function changedAgentPaths(base, cwd = process.cwd()) {
  const paths = new Set([
    ...git(['diff','--name-only',base,'HEAD'], cwd),
    ...git(['diff','--name-only'], cwd),
    ...git(['diff','--cached','--name-only'], cwd),
    ...git(['ls-files','--others','--exclude-standard'], cwd),
  ]);
  return [...paths];
}

export function forbiddenAgentPaths(base, cwd = process.cwd()) {
  return controlPlanePaths(changedAgentPaths(base, cwd));
}
