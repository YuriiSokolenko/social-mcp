import { Type } from 'typebox';

import { registerTerminalTool } from './pi-common/terminal-tool.mjs';
import { validateReviewResult } from './pi-review-result.mjs';

export default function (pi) {
  registerTerminalTool(pi, {
    label: 'Submit review result',
    description: 'Submit the final PR review verdict as the last action.',
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal('PASS'), Type.Literal('CHANGES_REQUESTED')]),
      summary: Type.String({ description: 'Complete review comment' }),
    }),
    customType: 'review-result',
    nudgeText: 'You finished without calling submit_result. Call it now with the final review verdict.',
    successText: 'Review result recorded. Stop now.',
    execute: async (params) => ({
      data: validateReviewResult({ verdict: params.verdict, text: params.summary }),
    }),
  });
}
