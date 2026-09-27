import { Type } from 'typebox';
import { registerSubmitNudge, terminalResult } from './pi-common/terminal-result.mjs';
import { validateTriage } from './pi-triage.mjs';

// Same prototype as pi-architect-result-tool.mjs, adapted for the triage
// classification shape. See that file and docs/CI_RULES.md for the rationale.
export default function (pi) {
  let submitted = false;

  pi.registerTool({
    name: 'submit_result',
    label: 'Submit triage result',
    description: 'Submit your final classification of every prepared candidate issue. Call this exactly once, as your last action, instead of writing a TRIAGE_RESULT line.',
    parameters: Type.Object({
      ready: Type.Array(Type.Integer(), { description: 'Candidates ready for dispatcher:ready' }),
      needs_human: Type.Array(Type.Object({
        issue: Type.Integer(),
        comment: Type.String({ description: 'Concrete, specific explanation of what is missing' }),
      })),
      skipped: Type.Array(Type.Object({
        issue: Type.Integer(),
        reason: Type.String(),
      })),
    }),
    async execute(_toolCallId, params) {
      const result = validateTriage(params);
      pi.appendEntry('triage-result', result);
      submitted = true;
      return terminalResult('Result recorded.', undefined);
    },
  });

  registerSubmitNudge(pi, {
    isSubmitted: () => submitted,
    customType: 'pi-result-nudge',
    content: 'You finished without calling submit_result. Call it now, classifying every prepared candidate exactly once.',
  });
}
