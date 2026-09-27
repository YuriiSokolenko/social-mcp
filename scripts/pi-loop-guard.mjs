import { Type } from 'typebox';

import { LoopGuard } from './pi-common/loop-guard-policy.mjs';

// Runtime execution budget. Implementer runs require an explicit complexity
// declaration from the model before any implementation tool can be used.
// The declaration selects real turn/tool budgets instead of merely asking the
// model in prose to "be brief".
export default function (pi) {
  const guard = new LoopGuard({
    turnLimit: Number(process.env.PI_MAX_TURNS ?? 100),
    repeatThreshold: Number(process.env.PI_MAX_REPEAT_CALLS ?? 3),
    requireComplexity: process.env.PI_REQUIRE_TASK_COMPLEXITY === '1',
    reviewMode: process.env.PI_LOOP_GUARD_MODE === 'review',
    reviewPathsJson: process.env.PI_REVIEW_PATHS,
  });

  pi.registerTool({
    name: 'declare_task_complexity',
    label: 'Declare task complexity',
    description: 'REQUIRED FIRST ACTION. Classify the current task once: trivial for an exact tiny scope with no behavior/design work; normal for ordinary work; complex for broad architectural or multi-part work. This selects the runtime execution budget.',
    parameters: Type.Object({
      complexity: Type.Union([
        Type.Literal('trivial'),
        Type.Literal('normal'),
        Type.Literal('complex'),
      ]),
      reason: Type.String({ description: 'One short sentence explaining the classification' }),
    }),
    async execute(_toolCallId, params) {
      const profile = guard.setComplexity(params.complexity);
      return {
        content: [{
          type: 'text',
          text: `Complexity locked to ${params.complexity}. Runtime budget: soft warning at turn ${profile.softTurns}, hard stop at turn ${profile.hardTurns}, up to ${profile.toolCalls} implementation tool calls. Proceed within that budget.`,
        }],
        details: { complexity: params.complexity, reason: params.reason, ...profile },
      };
    },
  });

  pi.on('turn_start', async (event) => {
    guard.onTurnStart(event.turnIndex);
    const warning = guard.takeSoftWarning();
    if (warning) await pi.sendUserMessage(warning, { deliverAs: 'steer' });
  });

  pi.on('tool_call', (event) => guard.checkToolCall(event.toolName, event.input));
}
