import { spawnSync } from 'node:child_process';
import { registerSubmitNudge, terminalResult } from './pi-common/terminal-result.mjs';
import { writeFileSync } from 'node:fs';
import { Type } from 'typebox';

import { forbiddenAgentPaths } from './pi-common/agent-change-policy.mjs';
import { runProductChecks } from './pi-common/product-checks.mjs';

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(output || `${command} failed with exit code ${result.status}`);
  }
  return { status: result.status ?? 1, output };
}

function mergeInProgress() {
  return run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true }).status === 0;
}

function conflictedFiles() {
  const result = run('git', ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true });
  return result.output.split('\n').map((item) => item.trim()).filter(Boolean);
}

function integrateLatestDev() {
  run('git', ['config', 'user.name', 'social-mcp-pi']);
  run('git', ['config', 'user.email', 'social-mcp-pi@users.noreply.github.com']);

  if (mergeInProgress()) {
    const conflicts = conflictedFiles();
    if (conflicts.length) {
      // The agent owns file edits; trusted workflow code owns Git state changes.
      run('git', ['add', '-A']);
      const remaining = conflictedFiles();
      if (remaining.length) {
        throw new Error(`Merge conflicts are still unresolved: ${remaining.join(', ')}`);
      }
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
      throw new Error(
        `Latest dev conflicts with the implementation. Resolve these files in the current working tree, run the relevant tests, then call submit_result again: ${conflicts.join(', ')}`,
      );
    }
    throw new Error(merge.output || 'Failed to merge latest dev');
  }
}

function validateFinalTree() {
  const base = run('git', ['merge-base', 'origin/dev', 'HEAD']).output;
  const forbidden = forbiddenAgentPaths(base);
  if (forbidden.length) throw new Error(`Agent changes to CI/control-plane files are forbidden: ${forbidden.join(', ')}`);
  runProductChecks();
}

export default function (pi) {
  let submitted = false;

  pi.registerTool({
    name: 'submit_result',
    label: 'Sync, validate, and submit implementation result',
    description: 'TERMINAL ACTION. Integrate latest dev and run the authoritative final diff, pytest, and Ruff validation. On success the implementation is complete: do not call tools or produce another recap. On conflict/failure, fix only the reported problem and retry.',
    parameters: Type.Object({
      title: Type.String({ description: 'Concise conventional PR title describing the actual implementation' }),
      summary: Type.String({ description: 'Self-contained 1-3 sentence summary of what was implemented and why' }),
      changes: Type.Array(Type.String(), { description: 'Concrete user-visible or architectural changes made by this implementation' }),
      security_notes: Type.String({ description: 'Security-relevant behavior or empty string when none' }),
      limitations: Type.String({ description: 'Known limitations or empty string when none' }),
    }),
    async execute(_toolCallId, params) {
      integrateLatestDev();
      validateFinalTree();

      const result = {
        title: params.title.trim(),
        summary: params.summary.trim(),
        changes: params.changes.map((item) => item.trim()).filter(Boolean),
        security_notes: params.security_notes.trim(),
        limitations: params.limitations.trim(),
      };
      if (!result.title || !result.summary) throw new Error('title and summary are required');
      if (!result.changes.length) throw new Error('at least one concrete change is required');
      const path = process.env.PI_IMPLEMENTER_RESULT_FILE;
      if (!path) throw new Error('PI_IMPLEMENTER_RESULT_FILE is not configured');
      writeFileSync(path, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      pi.appendEntry('implementer-result', result);
      submitted = true;
      return terminalResult(
        'SUCCESS. Latest dev is integrated and final git diff --check, pytest, and Ruff all pass. Implementation result recorded. Stop now; do not call more tools or produce another recap.',
        undefined,
      );
    },
  });

  registerSubmitNudge(pi, {
    isSubmitted: () => submitted,
    customType: 'pi-result-nudge',
    content: 'Before finishing, call submit_result. It will integrate latest dev and validate the final tree. If it reports merge conflicts or failing checks, fix them in this same session and call submit_result again until it succeeds.',
  });
}
