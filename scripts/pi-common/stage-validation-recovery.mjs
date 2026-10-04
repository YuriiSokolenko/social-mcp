import fs from 'node:fs';

import { validateFinalProductTree } from './finalize-product-tree.mjs';
import { IMPLEMENTER_OUTCOMES, readImplementerResult } from './implementer-result.mjs';
import { createStageRunResult, createStageRunSpec } from './stage-run-contract.mjs';
import { assertSuccessfulTerminalReceipt } from './terminal-receipt.mjs';
import { mutationCleanupHints } from './mutation-journal.mjs';
import { readPreparedImplementation } from './implementation-planner.mjs';
import { computeCandidateRevision } from './candidate-revision.mjs';

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

const REPAIR_HANDOFF_MAX_ITEMS = 20;
const REPAIR_HANDOFF_MAX_TEXT = 4000;

function boundedText(value, max = REPAIR_HANDOFF_MAX_TEXT) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function boundedStrings(value, { maxItems = REPAIR_HANDOFF_MAX_ITEMS, maxChars = 500 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string' && item.trim())
    .slice(0, maxItems)
    .map(item => boundedText(item, maxChars));
}

function acceptedScopeFacts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = list => {
    const valid = (Array.isArray(list) ? list : [])
      .filter(item => item && typeof item === 'object' && typeof item.path === 'string');
    return {
      items: valid.slice(0, REPAIR_HANDOFF_MAX_ITEMS).map(item => ({
        path: boundedText(item.path, 1000),
        rationale: boundedText(item.rationale, 500),
      })),
      total: valid.length,
      truncated: valid.length > REPAIR_HANDOFF_MAX_ITEMS,
    };
  };
  const accepted = entries(value.accepted);
  const temporary = entries(value.temporary);
  const baselineRaw = (Array.isArray(value.baseline) ? value.baseline : [])
    .filter(item => typeof item === 'string' && item.trim());
  return {
    schema_version: Number.isSafeInteger(value.schema_version) ? value.schema_version : null,
    accepted: accepted.items,
    accepted_total: accepted.total,
    accepted_truncated: accepted.truncated,
    temporary: temporary.items,
    temporary_total: temporary.total,
    temporary_truncated: temporary.truncated,
    baseline: boundedStrings(baselineRaw, { maxItems: REPAIR_HANDOFF_MAX_ITEMS, maxChars: 1000 }),
    baseline_total: baselineRaw.length,
    baseline_truncated: baselineRaw.length > REPAIR_HANDOFF_MAX_ITEMS,
  };
}

function preparedFacts(spec) {
  const target = `${spec?.artifacts?.terminalResultPath ?? ''}.prepared-implementation.json`;
  const prepared = readPreparedImplementation(target);
  if (!prepared) return null;
  const layout = prepared.layoutHint && typeof prepared.layoutHint === 'object'
    ? Object.fromEntries([
        ...['sourceRoot', 'sourceDirectory', 'sourceTarget', 'sourceConvention', 'testDirectory', 'testTarget', 'testConvention']
          .filter(key => typeof prepared.layoutHint[key] === 'string' && prepared.layoutHint[key])
          .map(key => [key, boundedText(prepared.layoutHint[key], 1000)]),
        ...(typeof prepared.layoutHint.testTargetRequired === 'boolean'
          ? [['testTargetRequired', prepared.layoutHint.testTargetRequired]]
          : []),
      ])
    : null;
  return {
    status: prepared.status,
    plan: boundedStrings(prepared.plan, { maxItems: 8, maxChars: 240 }),
    complexity: prepared.complexity ?? null,
    evidence_budget: Number.isSafeInteger(prepared.evidenceBudget) ? prepared.evidenceBudget : null,
    large_mutation: prepared.largeMutation === true,
    reason: boundedText(prepared.reason, 300),
    layout_hint: layout && Object.keys(layout).length ? layout : null,
  };
}

function repairChangedFiles(spec, terminalReceipt, implementerResult) {
  const fallback = Array.isArray(implementerResult?.files) ? implementerResult.files : [];
  const base = terminalReceipt?.candidateRevision?.base_commit ??
    terminalReceipt?.receipt?.candidate_revision?.base_commit ??
    null;
  if (spec?.cwd && base) {
    try {
      return computeCandidateRevision({ cwd: spec.cwd, base }).files;
    } catch {
      // The receipt-bound result remains a safe bounded fallback if git state
      // cannot be re-read while constructing diagnostics.
    }
  }
  return fallback;
}

export function validationRepairHandoff(spec, error, {
  implementerResult = null,
  terminalReceipt = null,
  acceptedScope = null,
} = {}) {
  const rawFiles = repairChangedFiles(spec, terminalReceipt, implementerResult)
    .filter(item => typeof item === 'string' && item.trim());
  const files = boundedStrings(
    rawFiles,
    { maxItems: REPAIR_HANDOFF_MAX_ITEMS, maxChars: 1000 },
  ).sort();
  const rawChanges = Array.isArray(implementerResult?.changes)
    ? implementerResult.changes.filter(item => typeof item === 'string' && item.trim())
    : [];
  const completion = implementerResult
    ? {
        outcome: implementerResult.outcome ?? null,
        title: boundedText(implementerResult.title, 500),
        summary: boundedText(implementerResult.summary, 1200),
        changes: boundedStrings(rawChanges, { maxItems: REPAIR_HANDOFF_MAX_ITEMS, maxChars: 500 }),
        changes_total: rawChanges.length,
        changes_truncated: rawChanges.length > REPAIR_HANDOFF_MAX_ITEMS,
        session_id: terminalReceipt?.receipt?.session_id ?? null,
        candidate_revision: terminalReceipt?.receipt?.candidate_revision?.digest ?? null,
      }
    : null;
  return {
    schema_version: 1,
    validation_failure: validationDiagnostics(error),
    changed_files: files,
    changed_files_total: rawFiles.length,
    changed_files_truncated: rawFiles.length > REPAIR_HANDOFF_MAX_ITEMS,
    accepted_mutation_scope: acceptedScopeFacts(acceptedScope),
    completion,
    prepared_implementation: preparedFacts(spec),
  };
}

export function validationRepairPrompt(error, handoff = null) {
  const handoffText = handoff
    ? `\n\nRuntime repair handoff (bounded metadata. Fields with *_truncated=true are incomplete tails: trust the included entries, but rediscover only the omitted tail if validation requires it. Untruncated fields are authoritative and must not be rediscovered):\n${JSON.stringify(handoff, null, 2)}`
    : `\n\nValidation diagnostics:\n${validationDiagnostics(error)}`;
  return `The previous implementation attempt finished and its changes are still present in the current worktree.

The harness then ran the authoritative final product validation and it failed.

Fix only the concrete validation failures below. Do not restart or re-plan the task. Do not run the full product validation suite yourself; finish normally when the reported problems are fixed and the harness will run the authoritative checks again.${handoffText}`;
}

export function createValidationRepairSpec(
  spec,
  error,
  attempt = 1,
  acceptedScope = null,
  implementerResult = null,
  terminalReceipt = null,
) {
  const handoff = validationRepairHandoff(spec, error, {
    implementerResult,
    terminalReceipt,
    acceptedScope,
  });
  return createStageRunSpec({
    stage: spec.stage,
    cwd: spec.cwd,
    prompt: validationRepairPrompt(error, handoff),
    model: spec.model,
    environment: {
      ...spec.environment,
      PI_VALIDATION_REPAIR: 'true',
      PI_VALIDATION_REPAIR_ATTEMPT: String(attempt),
      PI_CALL: 'repair',
      PI_VALIDATION_REPAIR_HANDOFF: JSON.stringify(handoff),
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
    const terminalReceipt = assertAttemptTerminalReceipt(currentSpec);
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
      const repairSpec = createValidationRepairSpec(
        spec,
        actionableError,
        repairAttempt,
        acceptedScope,
        implementerResult,
        terminalReceipt,
      );
      currentSpec = repairSpec;
      result = await runBackendAttempt(currentSpec, runBackend);
      durationMs += result.durationMs;
    }
  }
}
