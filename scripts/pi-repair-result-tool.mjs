import { spawnSync } from 'node:child_process';
import { registerSubmitNudge, terminalResult } from './pi-common/terminal-result.mjs';

import { forbiddenAgentPaths } from './pi-common/agent-change-policy.mjs';
import { runProductChecks } from './pi-common/product-checks.mjs';

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', env: process.env });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(output || `${command} failed with exit code ${result.status}`);
  return { status: result.status ?? 1, output };
}

function conflicts() {
  return run('git', ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })
    .output.split('\n').map(item => item.trim()).filter(Boolean);
}

function mergeInProgress() {
  return run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true }).status === 0;
}

function integrateLatestDev() {
  run('git', ['config', 'user.name', 'social-mcp-pi']);
  run('git', ['config', 'user.email', 'social-mcp-pi@users.noreply.github.com']);

  if (mergeInProgress()) {
    const unresolved = conflicts();
    if (unresolved.length) {
      run('git', ['add', '-A']);
      const remaining = conflicts();
      if (remaining.length) throw new Error(`Merge conflicts are still unresolved: ${remaining.join(', ')}`);
    }
    run('git', ['diff', '--check']);
    run('git', ['commit', '--no-edit']);
    return;
  }

  run('git', ['fetch', 'origin', 'dev']);
  const merge = run('git', ['merge', '--no-edit', 'origin/dev'], { allowFailure: true });
  if (merge.status !== 0) {
    const unresolved = conflicts();
    if (unresolved.length) {
      throw new Error(
        `PR conflicts with current dev. Resolve these files in this same repair session, run relevant tests, then call submit_repair again: ${unresolved.join(', ')}`,
      );
    }
    throw new Error(merge.output || 'Failed to merge latest dev');
  }
}

export default function (pi) {
  let submitted = false;

  pi.registerTool({
    name: 'submit_repair',
    label: 'Sync, validate, and submit PR repair',
    description: 'Integrate current dev and validate the repaired PR. If conflicts or checks fail, fix them in this same session and retry.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      integrateLatestDev();
      const base = run('git', ['merge-base', 'origin/dev', 'HEAD']).output;
      const forbidden = forbiddenAgentPaths(base);
      if (forbidden.length) throw new Error(`Agent changes to CI/control-plane files are forbidden: ${forbidden.join(', ')}`);
      runProductChecks();
      submitted = true;
      return terminalResult('Current dev is integrated and git diff --check, pytest, and Ruff all pass. Repair is complete; stop now.', undefined);
    },
  });

  registerSubmitNudge(pi, {
    isSubmitted: () => submitted,
    customType: 'pi-repair-result-nudge',
    content: 'Before finishing, call submit_repair. If it reports merge conflicts or failing checks, fix them in this same session and retry until it succeeds.',
  });
}
