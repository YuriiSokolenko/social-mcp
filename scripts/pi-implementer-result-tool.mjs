import { writeFileSync } from 'node:fs';
import { Type } from 'typebox';

import { integrateLatestDev, validateFinalProductTree } from './pi-common/finalize-product-tree.mjs';
import { runGit as git } from './pi-common/git.mjs';
import { registerTerminalTool } from './pi-common/terminal-tool.mjs';

export default function (pi) {
  registerTerminalTool(pi, {
    label: 'Sync, validate, and submit implementation result',
    description: 'TERMINAL ACTION. Integrate latest dev and run the authoritative final validation. On failure, fix only the reported problem and retry.',
    parameters: Type.Object({
      title: Type.String(),
      summary: Type.String(),
      changes: Type.Array(Type.String()),
      already_satisfied: Type.Optional(Type.Boolean()),
      security_notes: Type.String(),
      limitations: Type.String(),
    }),
    customType: 'implementer-result',
    nudgeText: 'Repository state is authoritative. If the exact requested end state already exists in latest dev, do not duplicate it or deliberate further. Call submit_result immediately with already_satisfied: true and changes: []. Otherwise implement the smallest real diff, then call submit_result.',
    successText: 'SUCCESS. Latest dev is integrated and final checks pass. Implementation result recorded. Stop now.',
    execute: async (params) => {
      integrateLatestDev({
        conflictMessage: files => `Latest dev conflicts with the implementation. Resolve these files and retry submit_result: ${files.join(', ')}`,
      });
      validateFinalProductTree();

      const alreadySatisfied = params.already_satisfied === true;
      const hasDiff = git(['diff', '--quiet', 'origin/dev'], { allowFailure: true }).status !== 0;
      const data = {
        title: params.title.trim(),
        summary: params.summary.trim(),
        changes: params.changes.map(item => item.trim()).filter(Boolean),
        already_satisfied: alreadySatisfied,
        security_notes: params.security_notes.trim(),
        limitations: params.limitations.trim(),
      };
      if (!data.title || !data.summary) throw new Error('title and summary are required');
      if (alreadySatisfied && hasDiff) throw new Error('already_satisfied requires zero diff against latest dev');
      if (alreadySatisfied && data.changes.length) throw new Error('already_satisfied requires changes: []');
      if (!alreadySatisfied && !data.changes.length) throw new Error('at least one concrete change is required');

      const target = process.env.PI_IMPLEMENTER_RESULT_FILE;
      if (!target) throw new Error('PI_IMPLEMENTER_RESULT_FILE is not configured');
      writeFileSync(target, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      return { data };
    },
  });
}
