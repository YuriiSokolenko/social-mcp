import { Type } from 'typebox';

import { registerTerminalTool } from './pi-common/terminal-tool.mjs';
import { validateReviewResult } from './pi-review-result.mjs';

export default function (pi) {
  const CriterionEvidence = Type.Object({
    criterion: Type.String({
      maxLength: 500,
      description: 'One material acceptance criterion, quoted or paraphrased narrowly enough to identify it.',
    }),
    status: Type.Union([
      Type.Literal('ESTABLISHED'),
      Type.Literal('ASSUMPTION'),
    ]),
    evidence: Type.Array(Type.String({ maxLength: 1000 }), {
      minItems: 1,
      maxItems: 4,
      description: 'Concrete code, trusted-test, or counterexample evidence. Do not use a generic "tests pass" claim.',
    }),
    assumption: Type.Optional(Type.String({
      maxLength: 1000,
      description: 'Required for ASSUMPTION. Omit for ESTABLISHED; if supplied there, runtime ignores it.',
    })),
  });

  registerTerminalTool(pi, {
    label: 'Submit review result',
    description: 'Submit the final PR review verdict as the last action. PASS requires one compact structured evidence entry for every material acceptance criterion; CHANGES_REQUESTED may omit criterion evidence for blockers outside the acceptance criteria.',
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal('PASS'), Type.Literal('CHANGES_REQUESTED')]),
      summary: Type.String({
        maxLength: 12000,
        description: 'Concise overall review comment. Structured criterion evidence is supplied separately.',
      }),
      criteria_evidence: Type.Optional(Type.Array(CriterionEvidence, {
        maxItems: 30,
        description: 'Required and non-empty for PASS. For CHANGES_REQUESTED it may be omitted when the blocking defect is not itself an acceptance-criterion finding.',
      })),
    }),
    customType: 'review-result',
    nudgeText: 'You finished without calling submit_result. Call it now. PASS requires structured criteria_evidence; CHANGES_REQUESTED may omit it when the blocking defect is outside the acceptance criteria.',
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
