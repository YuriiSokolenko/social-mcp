import fs from 'node:fs';
import { Type } from 'typebox';

import { integrateLatestDev } from './pi-common/finalize-product-tree.mjs';
import { runGit as git } from './pi-common/git.mjs';
import { registerTerminalTool } from './pi-common/terminal-tool.mjs';

const lines = (text) => text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
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
    description: 'TERMINAL ACTION. Preserve current implementation changes, merge latest dev into them without resetting/checking them out, and record the implementation candidate. The outer stage harness runs authoritative final product validation after this agent exits and will start a focused repair attempt with exact diagnostics if validation fails. For restored or harness validation-repair work call submit_result with {} immediately. For fresh already-satisfied work call submit_result with {already_satisfied:true, changes:[]} and trusted runtime code derives publication metadata from the issue context. Fresh changed work must include title, summary, changes, security_notes, and limitations on the first call.',
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: 'Required for fresh changed work.' })),
      summary: Type.Optional(Type.String({ description: 'Required for fresh changed work.' })),
      changes: Type.Optional(Type.Array(Type.String(), { description: 'Required for fresh changed work; list concrete repository changes.' })),
      already_satisfied: Type.Optional(Type.Boolean()),
      security_notes: Type.Optional(Type.String({ description: 'Required for fresh changed work, including when there are no security-relevant changes.' })),
      limitations: Type.Optional(Type.String({ description: 'Required for fresh changed work, including when there are no known limitations.' })),
    }),
    customType: 'implementer-result',
    nudgeText: 'ACTION REQUIRED. The next response must call a productive tool; do not answer with prose-only reasoning. For restored or harness validation-repair work call submit_result({}) now. For fresh work call structural_edit/safe_edit/edit/write now when a change is required, or submit_result({already_satisfied:true, changes:[]}) when latest dev already contains the exact requested end state. If exactly one concrete missing fact blocks safe action, call need_more_evidence once, gather exactly one fact, then act.',
    nudgeRepeatWhile: () => process.env.PI_PRODUCTIVE_STATE === 'action_required',
    nudgeMaxCount: 3,
    successText: 'SUCCESS. Latest dev is integrated and the implementation candidate is recorded. The harness will run authoritative final checks. Stop now.',
    execute: async (params) => {
      const restored = restoredWork();
      const validationRepair = validationRepairWork();
      const runtimeOwnedMetadata = restored || validationRepair;
      const alreadySatisfied = params.already_satisfied === true;
      if (runtimeOwnedMetadata && alreadySatisfied) {
        throw new Error('Restored or validation-repair work cannot use already_satisfied');
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
      const changedPaths = lines(git(['diff', '--name-only', 'origin/dev']).out);
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
