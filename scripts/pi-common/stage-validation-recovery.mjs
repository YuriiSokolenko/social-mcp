import fs from 'node:fs';

import { validateFinalProductTree } from './finalize-product-tree.mjs';
import { IMPLEMENTER_OUTCOMES, readImplementerResult } from './implementer-result.mjs';
import { createStageRunResult, createStageRunSpec } from './stage-run-contract.mjs';
import { assertSuccessfulTerminalReceipt } from './terminal-receipt.mjs';
import { mutationCleanupHints } from './mutation-journal.mjs';

const DEFAULT_REPAIR_ATTEMPTS = 1;
const MAX_DIAGNOSTIC_CHARS = 20000;

function validationDiagnostics(error) {
  const text = String(error?.message || error || 'Unknown validation failure').trim();
  if (text.length <= MAX_DIAGNOSTIC_CHARS) return text;
  const half = Math.floor(MAX_DIAGNOSTIC_CHARS / 2);
  return `${text.slice(0, half)}\n... validation diagnostics truncated ...\n${text.slice(-half)}`;
}

function validationFailurePaths(error) {
  try {
    const parsed = JSON.parse(String(error?.message ?? ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return [...new Set([
      ...(Array.isArray(parsed.unexpected_paths) ? parsed.unexpected_paths : []),
      ...(Array.isArray(parsed.temporary_paths) ? parsed.temporary_paths : []),
    ].filter(item => typeof item === 'string' && item))];
  } catch {
    return [];
  }
}

export function validationErrorWithMutationCleanup(error, spec, implementerResult = null) {
  const paths = validationFailurePaths(error);
  if (!paths.length || !spec?.cwd) return error;
  const hints = mutationCleanupHints(spec.cwd, paths, spec.environment ?? process.env);
  if (!hints.length) return error;

  const cleanupPaths = new Set(hints.map(item => item.path));
  const expectedFiles = Array.isArray(implementerResult?.files)
    ? implementerResult.files.filter(file => !cleanupPaths.has(file))
    : [];
  const calls = hints.map(hint =>
    `undo_mutation({mutation_id:"${hint.mutation_id}",expected_files:${JSON.stringify(expectedFiles)},reason:"Remove accidental mutation reported by final validation"})`
  );
  const enriched = new Error(
    `${String(error?.message ?? error)}\nTargeted mutation cleanup available: ${calls.join(' or ')}`,
  );
  enriched.code = error?.code;
  return enriched;
}

export function validationRepairPrompt(error) {
  return `The previous implementation attempt finished and its changes are still present in the current worktree.

The harness then ran the authoritative final product validation and it failed.

Fix only the concrete validation failures below. Do not restart or re-plan the task. Do not run the full product validation suite yourself; finish normally when the reported problems are fixed and the harness will run the authoritative checks again.

Validation diagnostics:
${validationDiagnostics(error)}`;
}

export function createValidationRepairSpec(spec, error, attempt = 1, acceptedScope = null) {
  return createStageRunSpec({
    stage: spec.stage,
    cwd: spec.cwd,
    prompt: validationRepairPrompt(error),
    model: spec.model,
    environment: {
      ...spec.environment,
      PI_VALIDATION_REPAIR: 'true',
      PI_VALIDATION_REPAIR_ATTEMPT: String(attempt),
      PI_CALL: 'repair',
      ...(acceptedScope ? { PI_ACCEPTED_MUTATION_SCOPE_STATE: JSON.stringify(acceptedScope) } : {}),
    },
    artifacts: spec.artifacts,
  });
}

function clearRuntimeFailure(spec) {
  const failureFile = String(spec?.environment?.PI_RUNTIME_FAILURE_FILE ?? '').trim();
  if (failureFile) fs.rmSync(failureFile, { force: true });
}

async function runBackendAttempt(spec, runBackend) {
  clearRuntimeFailure(spec);
  return runBackend(spec);
}

function shouldBindTerminalReceipt(spec) {
  return Boolean(
    spec.stage === 'implementer' &&
    spec.environment.PI_IMPLEMENTER_RESULT_FILE &&
    spec.environment.PI_VALIDATION_RUN_ID
  );
}

function assertAttemptTerminalReceipt(spec) {
  if (!shouldBindTerminalReceipt(spec)) return null;
  return assertSuccessfulTerminalReceipt({
    cwd: spec.cwd,
    resultFile: spec.environment.PI_IMPLEMENTER_RESULT_FILE,
    env: { ...spec.environment, PI_TERMINAL_RESULT_FILE: spec.artifacts.terminalResultPath },
  });
}

export async function runStageWithValidationRecovery(
  spec,
  runBackend,
  {
    maxRepairAttempts = DEFAULT_REPAIR_ATTEMPTS,
    validate = validateFinalProductTree,
  } = {},
) {
  if (typeof runBackend !== 'function') throw new Error('runBackend is required');
  if (typeof validate !== 'function') throw new Error('validate is required');

  let currentSpec = spec;
  let result = await runBackendAttempt(currentSpec, runBackend);
  if (spec.stage !== 'implementer') return result;
  let durationMs = result.durationMs;

  for (let attempt = 0; ; attempt += 1) {
    assertAttemptTerminalReceipt(currentSpec);
    const implementerResult = readImplementerResult(spec.environment.PI_IMPLEMENTER_RESULT_FILE);
    if (
      implementerResult &&
      implementerResult.outcome !== IMPLEMENTER_OUTCOMES.changed
    ) {
      return createStageRunResult({
        backend: result.backend,
        durationMs,
        artifacts: result.artifacts,
      });
    }

    try {
      validate({
        cwd: spec.cwd,
        ledgerPath: spec.environment.PI_VALIDATION_LEDGER_FILE,
        backend: result.backend,
        env: spec.environment,
        enforceAcceptedScope: true,
      });
      // checks.final may apply a trusted deterministic safe fix. Such a byte
      // change invalidates the pre-validation submission. This assertion is
      // intentionally inside the try: a mismatch throws into the repair branch
      // below, which runs one focused validation-repair/resubmit attempt.
      assertAttemptTerminalReceipt(currentSpec);
      return createStageRunResult({
        backend: result.backend,
        durationMs,
        artifacts: result.artifacts,
      });
    } catch (error) {
      const actionableError = validationErrorWithMutationCleanup(error, spec, implementerResult);
      if (attempt >= maxRepairAttempts) throw actionableError;

      const repairAttempt = attempt + 1;
      console.error(
        `PI_VALIDATION_REPAIR attempt=${repairAttempt}/${maxRepairAttempts}: ${validationDiagnostics(actionableError)}`,
      );

      fs.rmSync(spec.artifacts.terminalResultPath, { force: true });
      const acceptedScope = implementerResult?.scope_enforcement === 'predeclared'
        ? implementerResult.accepted_scope
        : null;
      const repairSpec = createValidationRepairSpec(spec, actionableError, repairAttempt, acceptedScope);
      currentSpec = repairSpec;
      result = await runBackendAttempt(currentSpec, runBackend);
      durationMs += result.durationMs;
    }
  }
}
