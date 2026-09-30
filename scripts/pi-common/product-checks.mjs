import { runProcess } from './process.mjs';
import { ruffArgs } from './run-check.mjs';

/**
 * Run the deterministic checks that validate PRODUCT CODE before a Pi stage
 * publishes or approves a result. Every subprocess has a real deadline so a
 * wedged test runner cannot consume the whole workflow timeout.
 */
function run(command, args, cwd) {
  const result = runProcess(command, args, {
    cwd,
    timeoutSeconds: Number(process.env.PI_PRODUCT_CHECK_TIMEOUT_SECONDS ?? 900),
  });
  if (result.out) process.stdout.write(`${result.out}\n`);
  if (result.err) process.stderr.write(`${result.err}\n`);
}

export function runProductChecks({ cwd } = {}) {
  run('git', ['diff', '--check'], cwd);
  run('pytest', [], cwd);
  run('ruff', ruffArgs(['.']), cwd);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runProductChecks();
}
