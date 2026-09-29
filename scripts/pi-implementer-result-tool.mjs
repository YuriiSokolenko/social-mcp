import fs from 'node:fs';
import { Type } from 'typebox';

import { integrateLatestDev, validateFinalProductTree } from './pi-common/finalize-product-tree.mjs';
import { runGit as git } from './pi-common/git.mjs';
import { registerTerminalTool } from './pi-common/terminal-tool.mjs';

const lines = (text) => text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const clean = (value) => typeof value === 'string' ? value.trim() : '';

function restoredWork() {
  const patch = process.env.PI_RESUME_PATCH;
  return Boolean(patch && fs.existsSync(patch) && fs.statSync(patch).size > 0);
}

function issueContext() {
  const file = process.env.PI_ISSUE_CONTEXT;
  if (!file || !fs.existsSync(file)) throw new Error('PI_ISSUE_CONTEXT is required for restored-work submission');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export default function (pi) {
  registerTerminalTool(pi, {
    label: 'Sync, validate, and submit implementation result',
    description: 'TERMINAL ACTION. Preserve current implementation changes, merge latest dev into them without resetting/checking them out, then run authoritative final validation. For restored work call submit_result with {} immediately; trusted runtime code derives publication metadata from the issue context and validated diff. Fresh work supplies normal result metadata. On failure, fix only the reported problem and retry.',
    parameters: Type.Object({
      title: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
      changes: Type.Optional(Type.Array(Type.String())),
      already_satisfied: Type.Optional(Type.Boolean()),
      security_notes: Type.Optional(Type.String()),
      limitations: Type.Optional(Type.String()),
    }),
    customType: 'implementer-result',
    nudgeText: 'Productive action is required now. Do not continue free-form analysis. For restored work call submit_result({}) immediately. For fresh work call edit/write now when a change is required, or submit_result with already_satisfied: true and changes: [] only when latest dev already contains the exact requested end state. If exactly one concrete missing fact blocks a safe action, use need_more_evidence once, gather that one fact, then act.',
    successText: 'SUCCESS. Latest dev is integrated and final checks pass. Implementation result recorded. Stop now.',
    execute: async (params) => {
      integrateLatestDev({
        conflictMessage: files => `Latest dev conflicts with the implementation. Resolve these files and retry submit_result: ${files.join(', ')}`,
      });
      validateFinalProductTree();

      const restored = restoredWork();
      const alreadySatisfied = params.already_satisfied === true;
      if (restored && alreadySatisfied) throw new Error('Restored work cannot use already_satisfied');

      const changedPaths = lines(git(['diff', '--name-only', 'origin/dev']).out);
      const hasDiff = changedPaths.length > 0;
      let data;

      if (restored) {
        const context = issueContext();
        const issue = process.env.PI_ISSUE || process.env.ISSUE || context.number || '';
        data = {
          title: clean(context.title),
          summary: `Restored implementation${issue ? ` for issue #${issue}` : ''} was validated against latest dev.`,
          changes: changedPaths,
          already_satisfied: false,
          security_notes: 'No additional security notes were supplied for restored work.',
          limitations: 'No additional limitations were supplied for restored work.',
        };
      } else {
        data = {
          title: clean(params.title),
          summary: clean(params.summary),
          changes: Array.isArray(params.changes) ? params.changes.map(clean).filter(Boolean) : [],
          already_satisfied: alreadySatisfied,
          security_notes: clean(params.security_notes),
          limitations: clean(params.limitations),
        };
        if (!data.title || !data.summary || !data.security_notes || !data.limitations) {
          throw new Error('Fresh work requires title, summary, security_notes, and limitations');
        }
      }

      if (!data.title || !data.summary) throw new Error('title and summary are required');
      if (alreadySatisfied && hasDiff) throw new Error('already_satisfied requires zero diff against latest dev');
      if (alreadySatisfied && data.changes.length) throw new Error('already_satisfied requires changes: []');
      if (!alreadySatisfied && !data.changes.length) throw new Error('at least one concrete change is required');

      const target = process.env.PI_IMPLEMENTER_RESULT_FILE;
      if (!target) throw new Error('PI_IMPLEMENTER_RESULT_FILE is not configured');
      fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      return { data };
    },
  });
}
