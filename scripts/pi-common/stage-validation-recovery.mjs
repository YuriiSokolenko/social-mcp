import fs from 'node:fs';

import { validateFinalProductTree } from './finalize-product-tree.mjs';
import { createStageRunResult, createStageRunSpec } from './stage-run-contract.mjs';

const DEFAULT_REPAIR_ATTEMPTS = 1;
const MAX_DIAGNOSTIC_CHARS = 20000;

function validationDiagnostics(error) {
  const text = String(error?.message || error || 'Unknown validation failure').trim();
  if (text.length <= MAX_DIAGNOSTIC_CHARS) return text;
  const half = Math.floor(MAX_DIAGNOSTIC_CHARS / 2);
  return `${text.slice(0, half)}\n... validation diagnostics truncated ...\n${text.slice(-half)}`;
}

export function validationRepairPrompt(error) {
  return `The previous implementation attempt finished and its changes are still present in the current worktree.

The harness then ran the authoritative final product validation and it failed.

Fix only the concrete validation failures below. Do not restart or re-plan the task. Do not run the full product validation suite yourself; finish normally when the reported problems are fixed and the harness will run the authoritative checks again.

Validation diagnostics:
${validationDiagnostics(error)}`;
}

export function createValidationRepairSpec(spec, error, attempt = 1) {
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
    },
    artifacts: spec.artifacts,
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

  let result = await runBackend(spec);
  if (spec.stage !== 'implementer') return result;
  let durationMs = result.durationMs;

  for (let attempt = 0; ; attempt += 1) {
    try {
      validate({ cwd: spec.cwd });
      return createStageRunResult({
        backend: result.backend,
        durationMs,
        artifacts: result.artifacts,
      });
    } catch (error) {
      if (attempt >= maxRepairAttempts) throw error;

      const repairAttempt = attempt + 1;
      console.error(
        `PI_VALIDATION_REPAIR attempt=${repairAttempt}/${maxRepairAttempts}: ${validationDiagnostics(error)}`,
      );

      fs.rmSync(spec.artifacts.terminalResultPath, { force: true });
      const repairSpec = createValidationRepairSpec(spec, error, repairAttempt);
      result = await runBackend(repairSpec);
      durationMs += result.durationMs;
    }
  }
}
