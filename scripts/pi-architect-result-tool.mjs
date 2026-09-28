import { Type } from 'typebox';

import { registerTerminalTool } from './pi-common/terminal-tool.mjs';
import { validatePlan } from './pi-architect.mjs';

export default function (pi) {
  const parent = Number(process.env.PI_ISSUE);
  const Step = Type.Object({
    key: Type.String({ description: 'Unique lowercase slug for this step' }),
    kind: Type.Union([Type.Literal('contract'), Type.Literal('test'), Type.Literal('implementation')]),
    priority: Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2')]),
    title: Type.String(),
    body: Type.String(),
    depends_on: Type.Array(Type.String(), { description: 'Keys of preceding steps only' }),
  });

  registerTerminalTool(pi, {
    label: 'Submit Architect result',
    description: 'Submit the final KEEP/REVISE/SPLIT decision as the last action.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('keep'), Type.Literal('revise'), Type.Literal('split')]),
      reason: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2')])),
      depends_on: Type.Optional(Type.Array(Type.Integer())),
      steps: Type.Optional(Type.Array(Step)),
    }),
    customType: 'architect-result',
    nudgeText: 'You finished without calling submit_result. Call it now with the final Architect decision.',
    successText: 'Architect decision recorded. Stop now.',
    execute: async (params) => ({ data: validatePlan({ ...params, parent_issue: parent }, parent) }),
  });
}
