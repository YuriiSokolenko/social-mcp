import { controlPlanePaths } from './control-plane-policy.mjs';
import { runGit as git } from './git.mjs';

/**
 * Return every path changed by an agent, including committed, staged,
 * unstaged and untracked files. Security checks must not inspect only HEAD.
 */
function lines(args, cwd = process.cwd()) {
  return git(args, { cwd }).out.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

export function changedAgentPaths(base, cwd = process.cwd()) {
  const paths = new Set([
    ...lines(['diff','--name-only',base,'HEAD'], cwd),
    ...lines(['diff','--name-only'], cwd),
    ...lines(['diff','--cached','--name-only'], cwd),
    ...lines(['ls-files','--others','--exclude-standard'], cwd),
  ]);
  return [...paths];
}

export function forbiddenAgentPaths(base, cwd = process.cwd()) {
  return controlPlanePaths(changedAgentPaths(base, cwd));
}
