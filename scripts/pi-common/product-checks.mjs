import path from 'node:path';
import fs from 'node:fs';

import { runProcess } from './process.mjs';
import { baseRef, expandCommand, projectConfig } from './project-config.mjs';
import { ruffArgs } from './ruff-spec.mjs';
import { appendCheckRecord, FINAL_PIPELINE_COMPLETE_SOURCE } from './validation-ledger.mjs';

/**
 * Run the deterministic checks that validate PRODUCT CODE before a Pi stage
 * publishes or approves a result. Every subprocess has a real deadline so a
 * wedged test runner cannot consume the whole workflow timeout.
 */
function run(command, args, cwd, { allowFailure = false } = {}) {
  try {
    return runProcess(command, args, {
      cwd,
      allowFailure,
      timeoutSeconds: Number(process.env.PI_PRODUCT_CHECK_TIMEOUT_SECONDS ?? 900),
    });
  } catch (error) {
    throw new Error(`check: ${command} could not run: ${error.message}`, { cause: error });
  }
}

function summarizedOutput(result) {
  const output = [result.out, result.err].filter(Boolean).join('\n');
  if (output.length <= 16000) return output;
  return `${output.slice(0, 8000)}\n... output truncated ...\n${output.slice(-8000)}`;
}

function formatRuffDiagnostics(output, root) {
  let diagnostics;
  try {
    diagnostics = JSON.parse(output);
  } catch {
    return output.slice(-8000) || 'Ruff returned an unreadable diagnostic result';
  }
  if (!Array.isArray(diagnostics)) return output;
  const formatted = diagnostics.slice(0, 40).map(item => {
    const location = item.location
      ? `${item.location.row ?? '?'}:${item.location.column ?? '?'}`
      : '?:?';
    const filename = item.filename && path.isAbsolute(item.filename)
      ? path.relative(root, item.filename)
      : item.filename ?? '<unknown>';
    const repair = item.fix?.applicability === 'unsafe'
      ? 'unsafe fix available'
      : item.fix?.applicability === 'safe'
        ? 'safe fix available'
        : 'no automatic fix available';
    return `ruff: ${filename}:${location}: ${item.code ?? 'unknown'}: ${item.message ?? 'lint failure'} (${repair})`;
  });
  if (diagnostics.length > formatted.length) {
    formatted.push(`... ${diagnostics.length - formatted.length} additional Ruff diagnostic(s) omitted`);
  }
  return formatted.join('\n');
}

function changedPythonPaths(root) {
  const commands = [
    ['diff', '--name-only', '-z', '--diff-filter=ACMRT', `${baseRef()}...HEAD`],
    ['diff', '--name-only', '-z', '--diff-filter=ACMRT'],
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ];
  const paths = new Set();
  for (const args of commands) {
    const result = run('git', args, root, { allowFailure: true });
    if (result.status !== 0) throw new Error(`check: git ${args[0]} failed: ${result.err || result.out}`);
    for (const filename of result.out.split('\0').filter(Boolean)) {
      if (/\.pyi?$/.test(filename) && fs.existsSync(path.join(root, filename))) paths.add(filename);
    }
  }
  return [...paths].sort();
}

export function runRuffCheck(cwd = process.cwd()) {
  const root = fs.realpathSync(path.resolve(cwd));
  // Ruff's default --fix mode applies only safe fixes. Run it before the
  // authoritative check so mechanical style/metadata fixes do not consume an
  // LLM repair attempt. Both invocations pin the repository config explicitly.
  const fixPaths = changedPythonPaths(root);
  if (fixPaths.length) run('ruff', ruffArgs(root, fixPaths, { fix: true }), root, { allowFailure: true });

  const check = run('ruff', ruffArgs(root, ['.'], { json: true }), root, { allowFailure: true });
  if (check.status !== 0) {
    throw new Error(`check: Ruff\n${formatRuffDiagnostics(check.out || check.err, root)}`);
  }
}

function finalCheckKind(step) {
  return step.builtin === 'ruff' ? 'ruff' : step.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

function recordFinalCheck(ledgerPath, step, status, backend, error) {
  if (!ledgerPath) return;
  appendCheckRecord(ledgerPath, {
    kind: finalCheckKind(step),
    scope: { whole_repo: true },
    status,
    exit_code: null,
    source: 'checks_final',
    stage: 'implementer',
    backend,
    run_id: `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}`,
    summary: status === 'pass' ? 'Check passed' : String(error?.message ?? '').slice(0, 400),
    infrastructure: status === 'infra_error' ? { component: 'check_command', code: 'PRODUCT_CHECK_SPAWN_ERROR' } : null,
  });
}

/**
 * Final checks come from `checks.final` in the project config: fixed argv
 * commands run in order, plus the `ruff` builtin (which owns the pinned-config,
 * autofix-then-verify behavior above and is not expressible as plain argv).
 *
 * Every step is recorded into the validation ledger (when `ledgerPath` is
 * given) so PR/job "Validation" text can be rendered from what actually ran
 * rather than restated as a static claim. A step is never skipped or its
 * result withheld from the ledger just because an earlier step failed: the
 * remaining steps are recorded `not_run` before rethrowing. A single step's
 * own `pass` record is not proof the whole pipeline ran -- only after every
 * step has completed without error is a dedicated completion marker
 * appended, so a process that dies partway through (e.g. after Ruff passes
 * but before `pytest` runs) cannot be read back as "final checks ran."
 *
 * `backend` identifies which implementer backend produced these records
 * ('pi' or 'mini-swe') -- this function is shared by both, via
 * `runStageWithValidationRecovery`, and the ledger must carry the real
 * provenance rather than assume it is always Pi.
 */
export function runProductChecks({ cwd, ledgerPath, backend = 'pi' } = {}) {
  const root = cwd ?? process.cwd();
  const steps = projectConfig().checks.final;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    try {
      if (step.builtin === 'ruff') {
        runRuffCheck(cwd);
      } else {
        const { command, args } = expandCommand(step, root);
        const result = run(command, args, cwd, { allowFailure: true });
        if (result.status !== 0) {
          const output = summarizedOutput(result);
          throw new Error(`check: ${step.name}\n${output || `${command} exited with code ${result.status}`}`);
        }
        if (result.out) process.stdout.write(`${result.out}\n`);
        if (result.err) process.stderr.write(`${result.err}\n`);
      }
      recordFinalCheck(ledgerPath, step, 'pass', backend);
    } catch (error) {
      const infra = /could not run:/.test(error.message);
      recordFinalCheck(ledgerPath, step, infra ? 'infra_error' : 'fail', backend, error);
      for (const remaining of steps.slice(i + 1)) recordFinalCheck(ledgerPath, remaining, 'not_run', backend);
      throw error;
    }
  }
  if (ledgerPath) {
    appendCheckRecord(ledgerPath, {
      kind: 'checks_final',
      scope: { whole_repo: true },
      status: 'pass',
      source: FINAL_PIPELINE_COMPLETE_SOURCE,
      stage: 'implementer',
      backend,
      run_id: `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}`,
      summary: 'All checks.final steps completed',
    });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runProductChecks();
}
