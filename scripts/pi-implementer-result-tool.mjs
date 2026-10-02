import fs from 'node:fs';
import { Type } from 'typebox';

import { integrateLatestDev } from './pi-common/finalize-product-tree.mjs';
import { baseRef } from './pi-common/project-config.mjs';
import { runGit as git } from './pi-common/git.mjs';
import { assertImplementerFileSet, writeImplementerResult } from './pi-common/implementer-result.mjs';
import { registerTerminalTool } from './pi-common/terminal-tool.mjs';

const lines = (text) => text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const gitPaths = (text) => text.split('\0').filter(Boolean);
const clean = (value) => typeof value === 'string' ? value.trim() : '';

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

export default function (pi) {
  registerTerminalTool(pi, {
    label: 'Sync and submit implementation candidate',
    description: 'TERMINAL ACTION. Preserve current implementation changes, merge latest dev into them without resetting/checking them out, and record the implementation candidate. The outer stage harness runs authoritative final product validation after this agent exits and will start a focused repair attempt with exact diagnostics if validation fails. For restored or harness validation-repair work call submit_result with {} immediately. For fresh already-satisfied work call submit_result with {already_satisfied:true, changes:[]}. If authoritative current-code evidence proves explicit issue requirements or constraints are mutually incompatible so no compliant mutation exists, call submit_result with {blocked_reason:"..."} from a clean worktree. Fresh changed work must include title, summary, changes, files, security_notes, and limitations on the first call. `changes` is human-readable; `files` is the exact repository-relative changed-file set.',
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: 'Required for fresh changed work.' })),
      summary: Type.Optional(Type.String({ description: 'Required for fresh changed work.' })),
      changes: Type.Optional(Type.Array(Type.String(), { description: 'Required for fresh changed work; list concrete repository changes.' })),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: 'Required for fresh changed work; exact repository-relative paths intended for publication.' })),
      already_satisfied: Type.Optional(Type.Boolean()),
      blocked_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'Fresh work only: concrete contradiction in explicit requirements or constraints that makes a compliant mutation impossible.' })),
      security_notes: Type.Optional(Type.String({ description: 'Required for fresh changed work, including when there are no security-relevant changes.' })),
      limitations: Type.Optional(Type.String({ description: 'Required for fresh changed work, including when there are no known limitations.' })),
    }),
    customType: 'implementer-result',
    nudgeText: 'ACTION REQUIRED. The next response must call a productive tool; do not answer with prose-only reasoning. For restored or harness validation-repair work call submit_result({}) now. For fresh work call structural_edit/safe_edit/edit/write now when a change is required, submit_result({already_satisfied:true, changes:[]}) when latest dev already contains the exact requested end state, or submit_result({blocked_reason:"..."}) when authoritative current-code evidence proves explicit written requirements or constraints are mutually incompatible. If exactly one concrete missing fact blocks safe action, call need_more_evidence once, gather exactly one fact, then act.',
    nudgeRepeatWhile: () => process.env.PI_PRODUCTIVE_STATE === 'action_required',
    nudgeMaxCount: 3,
    successText: 'SUCCESS. Latest dev is integrated and the implementation candidate is recorded. The harness will run authoritative final checks. Stop now.',
    execute: async (params) => {
      const restored = restoredWork();
      const validationRepair = validationRepairWork();
      const runtimeOwnedMetadata = restored || validationRepair;
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
        const changedPaths = gitPaths(git(['diff', '--name-only', '-z', baseRef()]).out);
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

      const freshChangedMetadata = !runtimeOwnedMetadata && !alreadySatisfied
        ? {
            title: clean(params.title),
            summary: clean(params.summary),
            security_notes: clean(params.security_notes),
            limitations: clean(params.limitations),
          }
        : null;
      if (
        freshChangedMetadata &&
        (!freshChangedMetadata.title ||
          !freshChangedMetadata.summary ||
          !freshChangedMetadata.security_notes ||
          !freshChangedMetadata.limitations)
      ) {
        throw new Error('Fresh changed work requires title, summary, security_notes, and limitations');
      }

      integrateLatestDev({
        conflictMessage: files => `Latest dev conflicts with the implementation. Resolve these files and retry submit_result: ${files.join(', ')}`,
      });
      const changedPaths = gitPaths(git(['diff', '--name-only', '-z', baseRef()]).out);
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
          changes: Array.isArray(params.changes) ? params.changes.map(clean).filter(Boolean) : [],
          files: Array.isArray(params.files) ? params.files.map(clean).filter(Boolean) : [],
          already_satisfied: false,
        };
      }

      if (!data.title || !data.summary) throw new Error('title and summary are required');
      if (data.already_satisfied && hasDiff) throw new Error('already_satisfied requires zero diff against latest dev');
      if (data.already_satisfied && data.changes.length) throw new Error('already_satisfied requires changes: []');
      if (data.already_satisfied && data.files.length) throw new Error('already_satisfied requires files: []');
      if (!data.already_satisfied && !data.changes.length) throw new Error('at least one concrete change is required');
      if (!data.already_satisfied && !data.files.length) throw new Error('at least one declared file is required');
      if (!runtimeOwnedMetadata && !data.already_satisfied) {
        assertImplementerFileSet(changedPaths, data.files);
      }

      data = writeImplementerResult(process.env.PI_IMPLEMENTER_RESULT_FILE, data);
      return { data };
    },
  });
}
