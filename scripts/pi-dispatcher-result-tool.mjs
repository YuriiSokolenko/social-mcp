import { Type } from 'typebox';

import { registerTerminalTool } from './pi-common/terminal-tool.mjs';
import { validateDispatch } from './pi-dispatcher.mjs';

export default function (pi) {
  registerTerminalTool(pi, {
    label: 'Submit dispatcher result',
    description: 'Classify every prepared candidate exactly once as IMPLEMENT or ARCHITECT.',
    parameters: Type.Object({
      classifications: Type.Array(Type.Object({
        issue: Type.Integer(),
        decision: Type.Union([Type.Literal('IMPLEMENT'), Type.Literal('ARCHITECT')]),
      })),
    }),
    customType: 'dispatcher-result',
    nudgeText: 'You finished without calling submit_result. Classify every prepared candidate and call it now.',
    successText: 'Dispatch classification recorded. Stop now.',
    execute: async (params) => ({ data: validateDispatch(params) }),
  });
}
