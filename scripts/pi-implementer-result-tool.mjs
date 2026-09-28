import { writeFileSync } from 'node:fs';
import { Type } from 'typebox';

import { integrateLatestDev, validateFinalProductTree } from './pi-common/finalize-product-tree.mjs';
import { registerTerminalTool } from './pi-common/terminal-tool.mjs';

export default function (pi) {
  registerTerminalTool(pi, {
    label: 'Sync, validate, and submit implementation result',
    description: 'TERMINAL ACTION. Integrate latest dev and run the authoritative final validation. On failure, fix only the reported problem and retry.',
    parameters: Type.Object({
      title: Type.String(),
      summary: Type.String(),
      changes: Type.Array(Type.String()),
      security_notes: Type.String(),
      limitations: Type.String(),
    }),
    customType: 'implementer-result',
    nudgeText: 'Repository state is authoritative. If there is no real diff, implement the task. Finish only with a successful submit_result.',
    successText: 'SUCCESS. Latest dev is integrated and final checks pass. Implementation result recorded. Stop now.',
    execute: async (params) => {
      integrateLatestDev({
        conflictMessage: files => `Latest dev conflicts with the implementation. Resolve these files and retry submit_result: ${files.join(', ')}`,
      });
      validateFinalProductTree();

      const data = {
        title: params.title.trim(),
        summary: params.summary.trim(),
        changes: params.changes.map(item => item.trim()).filter(Boolean),
        security_notes: params.security_notes.trim(),
        limitations: params.limitations.trim(),
      };
      if (!data.title || !data.summary) throw new Error('title and summary are required');
      if (!data.changes.length) throw new Error('at least one concrete change is required');

      const target = process.env.PI_IMPLEMENTER_RESULT_FILE;
      if (!target) throw new Error('PI_IMPLEMENTER_RESULT_FILE is not configured');
      writeFileSync(target, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      return { data };
    },
  });
}
