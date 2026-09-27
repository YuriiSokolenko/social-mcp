import { Type } from 'typebox';
import { registerSubmitNudge } from './pi-common/terminal-result.mjs';
import { validateDispatch } from './pi-dispatcher.mjs';

// Same prototype as pi-architect-result-tool.mjs, adapted for the dispatcher's
// classification shape. See that file and docs/CI_RULES.md for the rationale.
export default function (pi) {
  let submitted = false;

  pi.registerTool({
    name: 'submit_result',
    label: 'Submit dispatcher result',
    description: 'Classify every prepared candidate exactly once as IMPLEMENT or ARCHITECT. The workflow owns eligibility, ordering, dependencies and capacity.',
    parameters: Type.Object({
      classifications: Type.Array(Type.Object({
        issue: Type.Integer(),
        decision: Type.Union([Type.Literal('IMPLEMENT'), Type.Literal('ARCHITECT')]),
      })),
    }),
    async execute(_toolCallId, params) {
      const result = validateDispatch(params);
      pi.appendEntry('dispatcher-result', result);
      submitted = true;
      return { content: [{ type: 'text', text: 'Result recorded.' }], details: undefined };
    },
  });

  registerSubmitNudge(pi, {
    isSubmitted: () => submitted,
    customType: 'pi-result-nudge',
    content: 'You finished without calling submit_result. Call it now, classifying every prepared candidate exactly once.',
  });
}
