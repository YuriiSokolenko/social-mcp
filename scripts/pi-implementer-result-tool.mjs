import fs from 'node:fs';
import { Type } from 'typebox';

import { integrateLatestDev } from './pi-common/finalize-product-tree.mjs';
import { baseRef } from './pi-common/project-config.mjs';
import { runGit as git } from './pi-common/git.mjs';
import { assertImplementerFileSet, normalizeImplementerFiles, writeImplementerResult } from './pi-common/implementer-result.mjs';
import { registerTerminalTool } from './pi-common/terminal-tool.mjs';
import { mutationScopeReceipt } from './pi-common/accepted-mutation-scope.mjs';
import { mutationCleanupHints } from './pi-common/mutation-journal.mjs';
import { capabilitySnapshotGuidance } from './pi-common/session-state.mjs';
import { readPreparedImplementation } from './pi-common/implementation-planner.mjs';
import {
  assertCodingBehavioralValidation,
  codingSessionSubmissionReadiness,
} from './pi-common/coding-session-validation.mjs';

const lines = (text) => text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const gitPaths = (text) => text.split('\0').filter(Boolean);
function changedPathsAgainstBase() {
  const tracked = gitPaths(git(['diff', '--no-renames', '--name-only', '-z', baseRef()]).out);
  const untracked = gitPaths(git(['ls-files', '--others', '--exclude-standard', '-z']).out);
  return [...new Set([...tracked, ...untracked])].sort();
}
const clean = (value) => typeof value === 'string' ? value.trim() : '';

function invalidResultPathWithKnownFiles(error, knownChangedFiles) {
  if (error?.code !== 'INVALID_RESULT_PATH') throw error;
  const known = Array.isArray(knownChangedFiles) && knownChangedFiles.length
    ? knownChangedFiles.join(', ')
    : '(none)';
  const enriched = new Error(`${error.message}. Known canonical changed files: ${known}`);
  enriched.code = 'INVALID_RESULT_PATH';
  enriched.path = error.path;
  throw enriched;
}

function normalizeDeclaredFilesWithKnownFiles(declaredFiles, knownChangedFiles) {
  try {
    return normalizeImplementerFiles(declaredFiles);
  } catch (error) {
    invalidResultPathWithKnownFiles(error, knownChangedFiles);
  }
}

function assertFileSetWithMutationRecovery(actualFiles, declaredFiles) {
  const canonicalDeclared = normalizeDeclaredFilesWithKnownFiles(declaredFiles, actualFiles);
  try {
    return assertImplementerFileSet(actualFiles, canonicalDeclared);
  } catch (error) {
    const declared = new Set(canonicalDeclared);
    const unexpected = actualFiles.filter(file => !declared.has(file));
    const hints = mutationCleanupHints(process.cwd(), unexpected, process.env);
    if (!hints.length) throw error;
    const calls = hints.map(hint =>
      `undo_mutation({mutation_id:"${hint.mutation_id}",expected_files:${JSON.stringify([...declared])},reason:"Remove accidental mutation from final candidate"})`
    );
    throw new Error(`${error.message} Targeted cleanup available: ${calls.join(' or ')}`);
  }
}

export const CHANGED_PUBLICATION_FIELDS = Object.freeze([
  'title',
  'summary',
  'changes',
  'files',
  'security_notes',
  'limitations',
]);

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
}

export function missingChangedPublicationFields(params = {}) {
  return CHANGED_PUBLICATION_FIELDS.filter(field => {
    if (field === 'changes' || field === 'files') return normalizeStringArray(params[field]).length === 0;
    return !clean(params[field]);
  });
}

export function validateFreshChangedSubmission(params = {}) {
  const missingFields = missingChangedPublicationFields(params);
  if (missingFields.length) {
    throw new Error(JSON.stringify({
      code: 'missing_publication_fields',
      missing_fields: missingFields,
    }));
  }
  return {
    title: clean(params.title),
    summary: clean(params.summary),
    changes: normalizeStringArray(params.changes),
    files: normalizeStringArray(params.files),
    security_notes: clean(params.security_notes),
    limitations: clean(params.limitations),
  };
}

export function submitResultParameters() {
  // Keep the tool schema as a plain object for local-model/tool-call compatibility.
  // Outcome-specific required fields are enforced synchronously in execute before
  // integration or any publication-side effect.
  return Type.Object({
    title: Type.Optional(Type.String({ description: 'Required for fresh changed work: PR title.' })),
    summary: Type.Optional(Type.String({ description: 'Required for fresh changed work: PR summary.' })),
    changes: Type.Optional(Type.Array(Type.String(), {
      description: 'Required for fresh changed work: concrete repository changes.',
    })),
    files: Type.Optional(Type.Array(Type.String(), {
      description: 'Required for fresh changed work: exact repository-relative changed-file set.',
    })),
    already_satisfied: Type.Optional(Type.Boolean({
      description: 'Set true only when latest dev already contains the requested end state.',
    })),
    blocked_reason: Type.Optional(Type.String({
      maxLength: 1000,
      description: 'Fresh work only: concrete contradiction that makes a compliant mutation impossible.',
    })),
    security_notes: Type.Optional(Type.String({
      description: 'Required for fresh changed work, including an explicit no-impact statement.',
    })),
    limitations: Type.Optional(Type.String({
      description: 'Required for fresh changed work, including an explicit none-known statement.',
    })),
  });
}

function restoredWork() {
  if (process.env.PI_RESUME_ACTIVE != null) return process.env.PI_RESUME_ACTIVE === 'true';
  const patch = process.env.PI_RESUME_PATCH;
  return Boolean(patch && fs.existsSync(patch) && fs.statSync(patch).size > 0);
}

function validationRepairWork() {
  return process.env.PI_VALIDATION_REPAIR === 'true';
}

function issueContext() {
  const file = process.env.PI_ISSUE_CONTEXT;
  if (!file || !fs.existsSync(file)) throw new Error('PI_ISSUE_CONTEXT is required for implementer submission');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertPreparedOutputsForChangedCodingSubmission({
  alreadySatisfied,
  blockedReason,
  runtimeOwnedMetadata,
} = {}) {
  if (
    runtimeOwnedMetadata ||
    alreadySatisfied ||
    blockedReason ||
    !String(process.env.PI_CODING_SESSION ?? '').trim()
  ) {
    return;
  }
  const prepared = readPreparedImplementation(process.env.PI_PREPARED_IMPLEMENTATION_FILE);
  const readiness = codingSessionSubmissionReadiness({
    prepared,
    cwd: process.cwd(),
    resumed: false,
    validationRepair: false,
  });
  if (readiness.ready) return;

  const error = new Error(JSON.stringify({
    code: 'PREPARED_OUTPUTS_REQUIRED',
    message: 'Fresh changed coding-session work cannot submit while required prepared outputs are missing. Create the outputs, or use already_satisfied / blocked_reason only when that terminal outcome is actually true.',
    missing_outputs: readiness.missing_outputs,
  }));
  error.code = 'PREPARED_OUTPUTS_REQUIRED';
  error.missingOutputs = readiness.missing_outputs;
  throw error;
}

const IMPLEMENTER_MUTATION_TOOLS = Object.freeze(['structural_edit', 'safe_edit', 'edit', 'write']);

export function implementerActionNudge(activeToolNames, { restored = false, validationRepair = false } = {}) {
  const names = [...new Set(Array.isArray(activeToolNames) ? activeToolNames : [])];
  const active = new Set(names);
  const parts = [
    'ACTION REQUIRED. The next response must call one currently exposed productive tool; do not answer with prose-only reasoning.',
  ];

  if (active.has('undo_mutation')) {
    parts.push('If submit_result reports a targeted cleanup mutation_id, call undo_mutation with that id and the intended final files, then retry submit_result.');
  }
  if (active.has('submit_result')) {
    parts.push('If submit_result just reported missing publication fields, retry submit_result immediately with exactly those fields; do not call evidence or exploration tools.');
    if (restored || validationRepair) {
      parts.push('For restored or harness validation-repair work call submit_result({}) now.');
    } else {
      parts.push('For fresh already-satisfied work call submit_result({already_satisfied:true, changes:[]}); if authoritative current-code evidence proves explicit written requirements or constraints are mutually incompatible, call submit_result({blocked_reason:"..."}) from a clean worktree.');
    }
  }
  const mutationTools = IMPLEMENTER_MUTATION_TOOLS.filter(name => active.has(name));
  if (mutationTools.length) {
    parts.push(`When a change is required, mutate now with one of the currently exposed mutation tools: ${mutationTools.join(', ')}.`);
  }
  if (active.has('need_more_evidence')) {
    parts.push('If exactly one concrete missing fact blocks safe action, call need_more_evidence once; after the single unlocked evidence action, act.');
  }
  parts.push(capabilitySnapshotGuidance(names));
  return parts.join(' ');
}

export default function (pi) {
  // Snapshot run mode once so the advertised contract and execute path cannot
  // diverge if process.env or the resume patch changes later in the process.
  const restored = restoredWork();
  const validationRepair = validationRepairWork();
  const runtimeOwnedMetadata = restored || validationRepair;

  registerTerminalTool(pi, {
    label: 'Sync and submit implementation candidate',
    description: 'TERMINAL ACTION. Preserve current implementation changes, merge latest dev into them without resetting/checking them out, and record the implementation candidate. The outer stage harness runs authoritative final product validation after this agent exits and will start a focused repair attempt with exact diagnostics if validation fails. For restored or harness validation-repair work call submit_result with {} immediately. For fresh already-satisfied work call submit_result with {already_satisfied:true, changes:[]}. If authoritative current-code evidence proves explicit issue requirements or constraints are mutually incompatible so no compliant mutation exists, call submit_result with {blocked_reason:"..."} from a clean worktree. Fresh changed work must include title, summary, changes, files, security_notes, and limitations on the first call. The runtime validates that complete publication contract before integrating latest dev and returns code=missing_publication_fields with every missing field. `changes` is human-readable; `files` is the exact repository-relative changed-file set.',
    parameters: submitResultParameters(),
    customType: 'implementer-result',
    nudgeText: () => implementerActionNudge(pi.getActiveTools?.() ?? [], { restored, validationRepair }),
    nudgeRepeatWhile: () => process.env.PI_PRODUCTIVE_STATE === 'action_required',
    nudgeMaxCount: 3,
    successText: 'SUCCESS. Latest dev is integrated and the implementation candidate is recorded. The harness will run authoritative final checks. Stop now.',
    execute: async (params) => {
      const alreadySatisfied = params.already_satisfied === true;
      const blockedReason = clean(params.blocked_reason);
      if (runtimeOwnedMetadata && alreadySatisfied) {
        throw new Error('Restored or validation-repair work cannot use already_satisfied');
      }
      if (runtimeOwnedMetadata && blockedReason) {
        throw new Error('Restored or validation-repair work cannot use blocked_reason');
      }
      if (alreadySatisfied && blockedReason) {
        throw new Error('already_satisfied and blocked_reason are mutually exclusive');
      }

      if (blockedReason) {
        integrateLatestDev({
          conflictMessage: files => `Latest dev conflicts while verifying blocked work: ${files.join(', ')}`,
        });
        const changedPaths = changedPathsAgainstBase();
        const dirty = lines(git(['status', '--porcelain', '--untracked-files=all']).out);
        if (changedPaths.length || dirty.length) {
          throw new Error('blocked_reason requires a clean worktree with zero diff against latest dev');
        }

        const context = issueContext();
        const issue = process.env.PI_ISSUE || process.env.ISSUE || context.number || '';
        const data = writeImplementerResult(process.env.PI_IMPLEMENTER_RESULT_FILE, {
          title: clean(context.title),
          summary: `Implementation${issue ? ` for issue #${issue}` : ''} is blocked by a concrete contradiction in the requested requirements or constraints.`,
          changes: [],
          files: [],
          outcome: 'blocked',
          blocked_reason: blockedReason,
          security_notes: 'No repository change was made because the task is blocked pending human clarification.',
          limitations: 'Human clarification is required before implementation can continue safely.',
        });
        return { data, text: 'BLOCKED. Human clarification is required before implementation can continue. Stop now.' };
      }

      assertPreparedOutputsForChangedCodingSubmission({
        alreadySatisfied,
        blockedReason,
        runtimeOwnedMetadata,
      });

      const freshChangedMetadata = !runtimeOwnedMetadata && !alreadySatisfied
        ? validateFreshChangedSubmission(params)
        : null;
      let knownChangedBeforeIntegration = null;
      if (!alreadySatisfied) {
        knownChangedBeforeIntegration = changedPathsAgainstBase();
        if (freshChangedMetadata) {
          freshChangedMetadata.files = normalizeDeclaredFilesWithKnownFiles(
            freshChangedMetadata.files,
            knownChangedBeforeIntegration,
          );
        }
        assertCodingBehavioralValidation({
          changedFiles: knownChangedBeforeIntegration,
          env: process.env,
          cwd: process.cwd(),
        });
      }

      integrateLatestDev({
        conflictMessage: files => `Latest dev conflicts with the implementation. Resolve these files and retry submit_result: ${files.join(', ')}`,
      });
      const changedPaths = changedPathsAgainstBase();
      const hasDiff = changedPaths.length > 0;
      let data;

      if (runtimeOwnedMetadata) {
        const context = issueContext();
        const issue = process.env.PI_ISSUE || process.env.ISSUE || context.number || '';
        const summaryPrefix = validationRepair ? 'Validation-repaired implementation' : 'Restored implementation';
        data = hasDiff
          ? {
              title: clean(context.title),
              summary: `${summaryPrefix}${issue ? ` for issue #${issue}` : ''} was prepared against latest dev.`,
              changes: changedPaths,
              files: changedPaths,
              already_satisfied: false,
              security_notes: 'No additional security notes were supplied for restored work.',
              limitations: 'No additional limitations were supplied for restored work.',
            }
          : {
              title: clean(context.title),
              summary: validationRepair
                ? `Latest dev already contains the validation-repaired implementation${issue ? ` for issue #${issue}` : ''}; no duplicate implementation is required.`
                : `Latest dev already contains the replayed saved implementation${issue ? ` for issue #${issue}` : ''}; no duplicate implementation is required.`,
              changes: [],
              files: [],
              already_satisfied: true,
              security_notes: 'No repository change was required because latest dev already contains the saved implementation.',
              limitations: 'No implementation PR is created for a stale restored branch that is already contained in latest dev.',
            };
      } else if (alreadySatisfied) {
        const context = issueContext();
        const issue = process.env.PI_ISSUE || process.env.ISSUE || context.number || '';
        data = {
          title: clean(context.title),
          summary: `Latest dev already contains the exact requested end state${issue ? ` for issue #${issue}` : ''}; no duplicate implementation is required.`,
          changes: [],
          files: [],
          already_satisfied: true,
          security_notes: 'No repository change was required.',
          limitations: 'No implementation PR is created for an already-satisfied issue.',
        };
      } else {
        data = {
          ...freshChangedMetadata,
          already_satisfied: false,
        };
      }

      if (!data.title || !data.summary) throw new Error('title and summary are required');
      if (data.already_satisfied && hasDiff) throw new Error('already_satisfied requires zero diff against latest dev');
      if (data.already_satisfied && data.changes.length) throw new Error('already_satisfied requires changes: []');
      if (data.already_satisfied && data.files.length) throw new Error('already_satisfied requires files: []');
      // Shared invariant for runtime-owned restored/validation-repair results too.
      if (!data.already_satisfied && !data.changes.length) throw new Error('at least one concrete change is required');
      if (!data.already_satisfied && !data.files.length) throw new Error('at least one declared file is required');
      if (!runtimeOwnedMetadata && !data.already_satisfied) {
        assertFileSetWithMutationRecovery(changedPaths, data.files);
      }

      data = writeImplementerResult(process.env.PI_IMPLEMENTER_RESULT_FILE, {
        ...data,
        scope_enforcement: 'predeclared',
        accepted_scope: mutationScopeReceipt(process.cwd(), process.env),
      });
      return { data };
    },
  });
}
