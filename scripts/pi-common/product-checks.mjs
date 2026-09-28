import { runProcess } from './process.mjs';

/**
 * Run the deterministic checks that validate PRODUCT CODE before a Pi stage
 * publishes or approves a result. Every subprocess has a real deadline so a
 * wedged test runner cannot consume the whole workflow timeout.
 */
function run(command, args) {
  runProcess(command, args, {
    stdio: 'inherit',
    timeoutSeconds: Number(process.env.PI_PRODUCT_CHECK_TIMEOUT_SECONDS ?? 900),
  });
}

export function runProductChecks() {
  run('git', ['diff', '--check']);
  run('pytest', []);
  run('ruff', ['check', '.']);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runProductChecks();
}
