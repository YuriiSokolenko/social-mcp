import { spawnSync } from 'node:child_process';

/**
 * Run the deterministic checks that validate PRODUCT CODE before a Pi stage
 * publishes or approves a result.
 *
 * Why this is shared:
 * Implementer, Reviewer and PR Fix used to carry separate copies of the same
 * git/pytest/Ruff contract. Separate copies drift and make workflow YAML large.
 *
 * What is intentionally NOT here:
 * CI/control-plane contracts (Node workflow tests, autoscaler tests, workflow
 * self-tests). Only ci.yml owns those. Product agents must never recursively
 * validate or modify the CI control plane.
 */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
}

export function runProductChecks() {
  // Catch whitespace/conflict-marker style patch corruption cheaply first.
  run('git', ['diff', '--check']);
  // Full Python regression suite is intentionally retained: it is fast in this
  // repository and protects unrelated product behavior before publication.
  run('pytest', []);
  // Static/lint validation is part of the product contract.
  run('ruff', ['check', '.']);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runProductChecks();
}
