export function isControlPlanePath(path) {
  return path.startsWith('.github/workflows/') ||
    /^scripts\/pi-[^/]+\.(?:mjs|sh)$/.test(path) ||
    /^tests\/[^/]+\.test\.mjs$/.test(path) ||
    path === 'tests/test_runner_autoscaler.sh' ||
    path.startsWith('infra/github-runner-autoscaler/');
}

export function controlPlanePaths(paths) {
  return [...new Set(paths.filter(Boolean).filter(isControlPlanePath))];
}
