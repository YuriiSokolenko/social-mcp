import { writeFileSync } from 'node:fs';
import { Type } from 'typebox';

import { integrateLatestDev, validateFinalProductTree } from './pi-common/finalize-product-tree.mjs';
import { registerSubmitNudge, terminalResult } from './pi-common/terminal-result.mjs';

export default function (pi) {
  let submitted = false;

  pi.registerTool({
    name: 'submit_result',
    label: 'Sync, validate, and submit implementation result',
    description: 'TERMINAL ACTION. Integrate latest dev and run the authoritative final diff, pytest, and Ruff validation. On success the implementation is complete: do not call tools or produce another recap. On conflict/failure, fix only the reported problem and retry.',
    parameters: Type.Object({
      title: Type.String({ description: 'Concise conventional PR title describing the actual implementation' }),
      summary: Type.String({ description: 'Self-contained 1-3 sentence summary of what was implemented and why' }),
      changes: Type.Array(Type.String(), { description: 'Concrete user-visible or architectural changes made by this implementation' }),
      security_notes: Type.String({ description: 'Security-relevant behavior or empty string when none' }),
      limitations: Type.String({ description: 'Known limitations or empty string when none' }),
    }),
    async execute(_toolCallId, params) {
      integrateLatestDev({
        conflictMessage: (files) => `Latest dev conflicts with the implementation. Resolve these files in the current working tree, run the relevant tests, then call submit_result again: ${files.join(', ')}`,
      });
      validateFinalProductTree();

      const result = {
        title: params.title.trim(),
        summary: params.summary.trim(),
        changes: params.changes.map((item) => item.trim()).filter(Boolean),
        security_notes: params.security_notes.trim(),
        limitations: params.limitations.trim(),
      };
      if (!result.title || !result.summary) throw new Error('title and summary are required');
      if (!result.changes.length) throw new Error('at least one concrete change is required');
      const path = process.env.PI_IMPLEMENTER_RESULT_FILE;
      if (!path) throw new Error('PI_IMPLEMENTER_RESULT_FILE is not configured');
      writeFileSync(path, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      pi.appendEntry('implementer-result', result);
      submitted = true;
      return terminalResult(
        'SUCCESS. Latest dev is integrated and final git diff --check, pytest, and Ruff all pass. Implementation result recorded. Stop now; do not call more tools or produce another recap.',
        undefined,
      );
    },
  });

  registerSubmitNudge(pi, {
    isSubmitted: () => submitted,
    customType: 'pi-result-nudge',
    content: 'Before finishing, call submit_result. It will integrate latest dev and validate the final tree. If it reports merge conflicts or failing checks, fix them in this same session and call submit_result again until it succeeds.',
  });
}
