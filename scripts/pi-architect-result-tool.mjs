import { Type } from 'typebox';
import { registerSubmitNudge, terminalResult } from './pi-common/terminal-result.mjs';
import { validatePlan } from './pi-architect.mjs';

// Architect uses the same explicit terminal-result contract as every other
// model-driven stage. Free-text result markers are not pipeline state.
export default function (pi) {
  const parent = Number(process.env.PI_ISSUE);
  let submitted = false;

  const Step = Type.Object({
    key: Type.String({ description: 'Unique lowercase slug for this step' }),
    kind: Type.Union([Type.Literal('contract'), Type.Literal('test'), Type.Literal('implementation')]),
    priority: Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2')]),
    title: Type.String(),
    body: Type.String(),
    depends_on: Type.Array(Type.String(), { description: 'Keys of preceding steps only' }),
  });

  pi.registerTool({
    name: 'submit_result',
    label: 'Submit Architect result',
    description: 'Submit your final Architect decision for the current issue. Call this exactly once, as your last action, instead of writing an ARCHITECT_RESULT line.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('keep'), Type.Literal('revise'), Type.Literal('split')]),
      reason: Type.Optional(Type.String({ description: 'Required for keep/revise: a concrete, specific reason' })),
      title: Type.Optional(Type.String({ description: 'Required for revise' })),
      body: Type.Optional(Type.String({ description: 'Required for revise' })),
      priority: Type.Optional(Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2')])),
      depends_on: Type.Optional(Type.Array(Type.Integer(), { description: 'Required for revise' })),
      steps: Type.Optional(Type.Array(Step, { description: 'Required for split: 2-6 steps' })),
    }),
    async execute(_toolCallId, params) {
      const plan = validatePlan({ ...params, parent_issue: parent }, parent);
      pi.appendEntry('architect-result', plan);
      submitted = true;
      return terminalResult('Result recorded. Architect decision is complete; stop now.', undefined);
    },
  });

  registerSubmitNudge(pi, {
    isSubmitted: () => submitted,
    customType: 'pi-result-nudge',
    content: 'You finished without calling submit_result. Call it now with your final decision.',
  });
}
