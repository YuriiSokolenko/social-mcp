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
