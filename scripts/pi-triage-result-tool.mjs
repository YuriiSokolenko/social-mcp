import { Type } from 'typebox';

import { registerTerminalTool } from './pi-common/terminal-tool.mjs';
import { validateTriage } from './pi-triage.mjs';

export default function (pi) {
  registerTerminalTool(pi, {
    label: 'Submit triage result',
    description: 'Submit the final classification of every prepared candidate issue.',
    parameters: Type.Object({
      ready: Type.Array(Type.Integer()),
      needs_human: Type.Array(Type.Object({
        issue: Type.Integer(),
        comment: Type.String(),
      })),
      skipped: Type.Array(Type.Object({
        issue: Type.Integer(),
        reason: Type.String(),
      })),
    }),
    customType: 'triage-result',
    nudgeText: 'You finished without calling submit_result. Classify every prepared candidate and call it now.',
    execute: async (params) => ({ data: validateTriage(params) }),
  });
}
