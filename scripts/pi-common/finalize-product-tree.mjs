import { spawnSync } from 'node:child_process';

import { forbiddenAgentPaths } from './agent-change-policy.mjs';
import { runProductChecks } from './product-checks.mjs';

export function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', env: process.env });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(output || `${command} failed with exit code ${result.status}`);
  return { status: result.status ?? 1, output };
}

function conflictedFiles() {
  return run('git', ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })
    .output.split('\n').map((item) => item.trim()).filter(Boolean);
}

function mergeInProgress() {
  return run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true }).status === 0;
}

export function integrateLatestDev({ conflictMessage, allowConflicts = false }) {
  run('git', ['config', 'user.name', 'social-mcp-pi']);
  run('git', ['config', 'user.email', 'social-mcp-pi@users.noreply.github.com']);

  if (mergeInProgress()) {
    const conflicts = conflictedFiles();
    if (conflicts.length) {
      run('git', ['add', '-A']);
      const remaining = conflictedFiles();
      if (remaining.length) throw new Error(`Merge conflicts are still unresolved: ${remaining.join(', ')}`);
    }
    run('git', ['diff', '--check']);
    run('git', ['commit', '--no-edit']);
    return;
  }

  run('git', ['fetch', 'origin', 'dev']);
  const merge = run('git', ['merge', '--no-edit', 'origin/dev'], { allowFailure: true });
  if (merge.status !== 0) {
    const conflicts = conflictedFiles();
    if (conflicts.length) {
      if (allowConflicts) return { conflicts };
      throw new Error(conflictMessage(conflicts));
    }
    throw new Error(merge.output || 'Failed to merge latest dev');
  }
  return { conflicts: [] };
}

export function validateFinalProductTree() {
  const base = run('git', ['merge-base', 'origin/dev', 'HEAD']).output;
  const forbidden = forbiddenAgentPaths(base);
  if (forbidden.length) throw new Error(`Agent changes to CI/control-plane files are forbidden: ${forbidden.join(', ')}`);
  runProductChecks();
}
