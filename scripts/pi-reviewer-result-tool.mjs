import { Type } from 'typebox';
import { registerSubmitNudge, terminalResult } from './pi-common/terminal-result.mjs';
import { validateReviewResult } from './pi-review-result.mjs';

// Same prototype as pi-architect-result-tool.mjs, adapted for the reviewer's
// verdict shape. `summary` becomes the posted PR review comment, so it should
// be the complete, self-contained write-up (not just a short label). See
// pi-architect-result-tool.mjs and docs/CI_RULES.md for the rationale.
export default function (pi) {
  let submitted = false;

  pi.registerTool({
    name: 'submit_result',
    label: 'Submit review result',
    description: 'Submit your final review verdict for this pull request. Call this exactly once, as your last action, instead of writing a REVIEW_RESULT line.',
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal('PASS'), Type.Literal('CHANGES_REQUESTED')]),
      summary: Type.String({ description: 'The complete review write-up to post as the PR comment: for PASS, a concise summary of what was verified; for CHANGES_REQUESTED, concrete actionable findings' }),
    }),
    async execute(_toolCallId, params) {
      const result = validateReviewResult({ verdict: params.verdict, text: params.summary });
      pi.appendEntry('review-result', result);
      submitted = true;
      return terminalResult('Result recorded. Review is complete; stop now.', undefined);
    },
  });

  registerSubmitNudge(pi, {
    isSubmitted: () => submitted,
    customType: 'pi-result-nudge',
    content: 'You finished without calling submit_result. Call it now with your final verdict.',
  });
}
