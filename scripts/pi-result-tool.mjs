import { Type } from 'typebox';
import { validatePlan } from './pi-architect.mjs';

// Prototype replacement for the ARCHITECT_RESULT text-line protocol: the
// model calls a real tool instead of writing a marker line, so there is no
// free-text line for the workflow to parse, duplicate, or lose inside
// <think>. `parent_issue` is injected from PI_ISSUE rather than asked of the
// model, removing a whole class of possible mismatch. If the model never
// calls the tool, agent_before_settle asks for exactly one retry before
// giving up, so the workflow's legacy ARCHITECT_RESULT parsing (kept as a
// fallback) still has a chance to see a result. See docs/CI_RULES.md.
export default function (pi) {
  const parent = Number(process.env.PI_ISSUE);
  let submitted = false;
  let nudged = false;

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
      return { content: [{ type: 'text', text: 'Result recorded.' }], details: undefined };
    },
  });

  pi.on('agent_before_settle', () => {
    if (submitted || nudged) return undefined;
    nudged = true;
    return {
      continue: true,
      entries: [{
        type: 'custom_message',
        customType: 'pi-result-nudge',
        content: 'You finished without calling submit_result. Call it now with your final decision.',
        display: true,
      }],
    };
  });
}
