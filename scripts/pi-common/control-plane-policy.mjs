import { projectConfig } from './project-config.mjs';

/**
 * Single path-security boundary separating product changes from CI control plane.
 *
 * Every trusted publication/review/merge guard must use this policy. Agents
 * are forbidden from changing, reviewing, repairing or auto-merging matching
 * paths. Keeping one matcher prevents a path from being protected in Reviewer
 * but accidentally allowed by Implementer or Merge Gate.
 *
 * WHICH paths are control plane is project configuration (`controlPlane` in
 * `.agent-harness.json`). The harness only owns the rule below: the
 * configuration file itself is always protected, because it defines the
 * boundary and an agent that could edit it could widen its own permissions.
 */

const ALWAYS_PROTECTED = new Set(['.agent-harness.json', '.agent-harness.yml', '.agent-harness.yaml']);

export function isControlPlanePath(path, config = projectConfig().controlPlane) {
  return ALWAYS_PROTECTED.has(path) ||
    config.exact.includes(path) ||
    config.prefixes.some(prefix => path.startsWith(prefix)) ||
    config.patterns.some(pattern => pattern.test(path));
}

export function controlPlanePaths(paths, config = projectConfig().controlPlane) {
  return [...new Set(paths.filter(Boolean).filter(path => isControlPlanePath(path, config)))];
}

if (process.argv[2] === '--stdin') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const forbidden = controlPlanePaths(input.split(/\r?\n/).filter(Boolean));
  if (forbidden.length) {
    console.error(forbidden.join('\n'));
    process.exitCode = 0;
  } else {
    process.exitCode = 1;
  }
}
