import fs from 'node:fs';
import { Type } from 'typebox';

import { integrateLatestDev, validateFinalProductTree } from './pi-common/finalize-product-tree.mjs';
import { runGit as git } from './pi-common/git.mjs';
import { registerTerminalTool } from './pi-common/terminal-tool.mjs';

const lines = (text) => text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const clean = (value) => typeof value === 'string' ? value.trim() : '';

function restoredWork() {
  if (process.env.PI_RESUME_ACTIVE != null) return process.env.PI_RESUME_ACTIVE === 'true';
  const patch = process.env.PI_RESUME_PATCH;
  return Boolean(patch && fs.existsSync(patch) && fs.statSync(patch).size > 0);
}

function issueContext() {
  const file = process.env.PI_ISSUE_CONTEXT;
  if (!file || !fs.existsSync(file)) throw new Error('PI_ISSUE_CONTEXT is required for implementer submission');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export default function (pi) {
  registerTerminalTool(pi, {
    label: 'Sync, validate, and submit implementation result',
    description: 'TERMINAL ACTION. Preserve current implementation changes, merge latest dev into them without resetting/checking them out, then run authoritative final validation. For restored work call submit_result with {} immediately. For fresh already-satisfied work call submit_result with {already_satisfied:true, changes:[]} and trusted runtime code derives publication metadata from the issue context. If authoritative current-code evidence proves the issue requirements conflict with each other or with an explicit no-behavior-change constraint so no compliant mutation exists, call submit_result with {blocked_reason:"..."} from a clean worktree. Fresh changed work must include title, summary, changes, security_notes, and limitations on the first call; metadata is preflight-validated before dev integration or expensive checks. On failure, fix only the reported problem with structural_edit/safe_edit/edit/write as appropriate and retry.',
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: 'Required for fresh changed work.' })),
      summary: Type.Optional(Type.String({ description: 'Required for fresh changed work.' })),
      changes: Type.Optional(Type.Array(Type.String(), { description: 'Required for fresh changed work; list concrete repository changes.' })),
      already_satisfied: Type.Optional(Type.Boolean()),
      security_notes: Type.Optional(Type.String({ description: 'Required for fresh changed work, including when there are no security-relevant changes.' })),
      limitations: Type.Optional(Type.String({ description: 'Required for fresh changed work, including when there are no known limitations.' })),
      blocked_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'Fresh work only: concrete contradiction between authoritative current code and issue requirements/constraints that makes a compliant mutation impossible.' })),
    }),
    customType: 'implementer-result',
    nudgeText: 'ACTION REQUIRED. The next response must call a productive tool; do not answer with prose-only reasoning. For restored work call submit_result({}) now. For fresh work call structural_edit/safe_edit/edit/write now when a change is required, submit_result({already_satisfied:true, changes:[]}) when latest dev already contains the exact requested end state, or submit_result({blocked_reason:"..."}) when authoritative current-code evidence proves the written requirements/constraints are mutually incompatible and no compliant mutation exists. If exactly one concrete missing fact blocks safe action, call need_more_evidence once, gather exactly one fact, then act.',
    nudgeRepeatWhile: () => ['action_required', 'recovery_action_required'].includes(process.env.PI_PRODUCTIVE_STATE ?? ''),
    nudgeMaxCount: 3,
    successText: 'SUCCESS. Latest dev is integrated and final checks pass. Implementation result recorded. Stop now.',
    execute: async (params) => {
      const restored = restoredWork();
      const alreadySatisfied = params.already_satisfied === true;
      const blockedReason = clean(params.blocked_reason);
      if (restored && alreadySatisfied) throw new Error('Restored work cannot use already_satisfied');
      if (restored && blockedReason) throw new Error('Restored work cannot use blocked_reason');
      if (alreadySatisfied && blockedReason) throw new Error('already_satisfied and blocked_reason are mutually exclusive');

      if (blockedReason) {
        const dirty = lines(git(['status', '--porcelain', '--untracked-files=all']).out);
        if (dirty.length) {
          throw new Error('blocked_reason requires a clean worktree; rollback or resolve repository mutations before reporting a blocked task');
        }
        const context = issueContext();
        const issue = process.env.PI_ISSUE || process.env.ISSUE || context.number || '';
        const data = {
          title: clean(context.title),
          summary: `Implementation${issue ? ` for issue #${issue}` : ''} is blocked by a concrete contradiction in the requested requirements or constraints.`,
          changes: [],
          already_satisfied: false,
          blocked: true,
          blocked_reason: blockedReason,
          security_notes: 'No repository change was made because the task is blocked pending human clarification.',
          limitations: 'Human clarification is required before implementation can continue safely.',
        };
        if (!data.title) throw new Error('Blocked work requires the issue title from PI_ISSUE_CONTEXT');
        const target = process.env.PI_IMPLEMENTER_RESULT_FILE;
        if (!target) throw new Error('PI_IMPLEMENTER_RESULT_FILE is not configured');
        fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        return { data };
      }

      const freshChangedMetadata = !restored && !alreadySatisfied
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
      validateFinalProductTree();

      const changedPaths = lines(git(['diff', '--name-only', 'origin/dev']).out);
      const hasDiff = changedPaths.length > 0;
      let data;

      if (restored) {
        const context = issueContext();
        const issue = process.env.PI_ISSUE || process.env.ISSUE || context.number || '';
        data = hasDiff
          ? {
              title: clean(context.title),
              summary: `Restored implementation${issue ? ` for issue #${issue}` : ''} was validated against latest dev.`,
              changes: changedPaths,
              already_satisfied: false,
              security_notes: 'No additional security notes were supplied for restored work.',
              limitations: 'No additional limitations were supplied for restored work.',
            }
          : {
              title: clean(context.title),
              summary: `Latest dev already contains the replayed saved implementation${issue ? ` for issue #${issue}` : ''}; no duplicate implementation is required.`,
              changes: [],
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
          already_satisfied: true,
          security_notes: 'No repository change was required.',
          limitations: 'No implementation PR is created for an already-satisfied issue.',
        };
      } else {
        data = {
          ...freshChangedMetadata,
          changes: Array.isArray(params.changes) ? params.changes.map(clean).filter(Boolean) : [],
          already_satisfied: false,
        };
      }

      if (!data.title || !data.summary) throw new Error('title and summary are required');
      if (data.already_satisfied && hasDiff) throw new Error('already_satisfied requires zero diff against latest dev');
      if (data.already_satisfied && data.changes.length) throw new Error('already_satisfied requires changes: []');
      if (!data.already_satisfied && !data.changes.length) throw new Error('at least one concrete change is required');

      const target = process.env.PI_IMPLEMENTER_RESULT_FILE;
      if (!target) throw new Error('PI_IMPLEMENTER_RESULT_FILE is not configured');
      fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      return { data };
    },
  });
}
