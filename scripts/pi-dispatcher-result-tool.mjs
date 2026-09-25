import { Type } from 'typebox';
import { validateDispatch } from './pi-dispatcher.mjs';

// Same prototype as pi-architect-result-tool.mjs, adapted for the dispatcher's
// classification shape. See that file and docs/CI_RULES.md for the rationale.
export default function (pi) {
  let submitted = false;
  let nudged = false;

  pi.registerTool({
    name: 'submit_result',
    label: 'Submit dispatcher result',
    description: 'Submit your final classification of every prepared candidate issue. Call this exactly once, as your last action, instead of writing a DISPATCH_RESULT line.',
    parameters: Type.Object({
      issues: Type.Array(Type.Integer(), { description: 'Candidates for pi:ready' }),
      architect: Type.Array(Type.Integer(), { description: 'Candidates to send to Pi Architect' }),
    }),
    async execute(_toolCallId, params) {
      const result = validateDispatch(params);
      pi.appendEntry('dispatcher-result', result);
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
        content: 'You finished without calling submit_result. Call it now, classifying every prepared candidate exactly once.',
        display: true,
      }],
    };
  });
}
