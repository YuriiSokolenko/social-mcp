import { Type } from 'typebox';

import { registerTerminalTool } from './pi-common/terminal-tool.mjs';
import { validateReviewResult } from './pi-review-result.mjs';

export default function (pi) {
  const CriterionEvidence = Type.Object({
    criterion: Type.String({
      description: 'One material acceptance criterion, quoted or paraphrased narrowly enough to identify it.',
    }),
    status: Type.Union([
      Type.Literal('ESTABLISHED'),
      Type.Literal('ASSUMPTION'),
    ]),
    evidence: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 4,
      description: 'Concrete code, trusted-test, or counterexample evidence. Do not use a generic "tests pass" claim.',
    }),
    assumption: Type.Optional(Type.String({
      description: 'Required only for ASSUMPTION: the unresolved policy interpretation or compatibility choice.',
    })),
  });

  registerTerminalTool(pi, {
    label: 'Submit review result',
    description: 'Submit the final PR review verdict as the last action, with one compact structured evidence entry for every material acceptance criterion.',
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal('PASS'), Type.Literal('CHANGES_REQUESTED')]),
      summary: Type.String({ description: 'Concise overall review comment. Structured criterion evidence is supplied separately.' }),
      criteria_evidence: Type.Array(CriterionEvidence, {
        minItems: 1,
        maxItems: 30,
        description: 'One entry per material acceptance criterion. Use ESTABLISHED when evidence proves the behavior; use ASSUMPTION only when issue wording leaves genuine policy latitude.',
      }),
    }),
    customType: 'review-result',
    nudgeText: 'You finished without calling submit_result. Call it now with the final verdict and structured criteria_evidence.',
    successText: 'Review result recorded. Stop now.',
    execute: async (params) => ({
      data: validateReviewResult({
        verdict: params.verdict,
        text: params.summary,
        criteria_evidence: params.criteria_evidence,
      }),
    }),
  });
}
