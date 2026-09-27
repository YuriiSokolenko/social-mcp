import { Type } from 'typebox';

import { LoopGuard } from './pi-common/loop-guard-policy.mjs';

// Runtime loop/stall guard. Complexity is declared before work so agents can
// choose an appropriate strategy and may escalate it if broader scope emerges.
// Complexity does not impose turn or tool-call quotas.
export default function (pi) {
  const guard = new LoopGuard({
    turnLimit: Number(process.env.PI_MAX_TURNS ?? 100),
    repeatThreshold: Number(process.env.PI_MAX_REPEAT_CALLS ?? 3),
    requireComplexity: process.env.PI_REQUIRE_TASK_COMPLEXITY === '1',
    preComplexityReadPaths: (process.env.PI_PRE_COMPLEXITY_READ_PATHS ?? '')
      .split(',')
      .map((path) => path.trim())
      .filter(Boolean),
  });

  pi.registerTool({
    name: 'declare_task_complexity',
    label: 'Declare task complexity',
    description: 'REQUIRED FIRST ACTION. Classify the current task: trivial for an exact tiny scope with no behavior/design work; normal for ordinary work; complex for broad architectural or multi-part work. You may later escalate complexity if investigation reveals broader scope, but never downgrade it.',
    parameters: Type.Object({
      complexity: Type.Union([
        Type.Literal('trivial'),
        Type.Literal('normal'),
        Type.Literal('complex'),
      ]),
      reason: Type.String({ description: 'One short sentence explaining the classification' }),
    }),
    async execute(_toolCallId, params) {
      const result = guard.setComplexity(params.complexity);
      return {
        content: [{
          type: 'text',
          text: result.changed
            ? `Complexity set to ${result.complexity}. It may be escalated later if broader scope emerges, but complexity does not limit tool calls or turns.`
            : `Complexity remains ${result.complexity}.`,
        }],
        details: { ...result, reason: params.reason },
      };
    },
  });

  pi.on('turn_start', (event) => {
    guard.onTurnStart(event.turnIndex);
  });

  pi.on('tool_call', (event) => guard.checkToolCall(event.toolName, event.input));
}
