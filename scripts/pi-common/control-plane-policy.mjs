/**
 * Single path-security boundary separating product changes from CI control plane.
 *
 * Every trusted publication/review/merge guard must use this policy. Pi agents
 * are forbidden from changing, reviewing, repairing or auto-merging matching
 * paths. Keeping one matcher prevents a path from being protected in Reviewer
 * but accidentally allowed by Implementer or Merge Gate.
 *
 * IMPORTANT: scripts/pi-common/** is intentionally protected by scripts/pi-*.
 */

export function isControlPlanePath(path) {
  return path.startsWith('.github/workflows/') ||
    /^scripts\/pi-(?:[^/]+\.(?:mjs|sh)|[^/]+\/)/.test(path) ||
    /^tests\/[^/]+\.test\.mjs$/.test(path) ||
    path === 'tests/test_runner_autoscaler.sh' ||
    path.startsWith('infra/github-runner-autoscaler/');
}

export function controlPlanePaths(paths) {
  return [...new Set(paths.filter(Boolean).filter(isControlPlanePath))];
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
