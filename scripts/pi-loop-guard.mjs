import { Type } from 'typebox';

import { LoopGuard } from './pi-common/loop-guard-policy.mjs';
import { RESPONSE_BUDGETS, withResponseBudget } from './pi-common/response-budget-policy.mjs';

// Runtime execution budget. Implementer runs require an explicit complexity
// declaration from the model before any implementation tool can be used.
// The declaration selects real turn/tool budgets instead of merely asking the
// model in prose to "be brief".
export default function (pi) {
  const guard = new LoopGuard({
    turnLimit: Number(process.env.PI_MAX_TURNS ?? 100),
    repeatThreshold: Number(process.env.PI_MAX_REPEAT_CALLS ?? 3),
    requireComplexity: process.env.PI_REQUIRE_TASK_COMPLEXITY === '1',
  });

  let responseBudgetLevel = 'short';

  async function applyResponseBudget(level, ctx) {
    const model = ctx.model;
    if (!model) throw new Error('No active model is available for response budgeting');
    const changed = await pi.setModel(withResponseBudget(model, level));
    if (!changed) throw new Error(`Failed to apply ${level} response budget`);
    responseBudgetLevel = level;
    return RESPONSE_BUDGETS[level];
  }

  pi.on('session_start', async (_event, ctx) => {
    // Start every session terse. The model may explicitly raise the budget for
    // the *next* response when the next step genuinely needs more reasoning.
    await applyResponseBudget('short', ctx);
  });

  pi.registerTool({
    name: 'set_response_budget',
    label: 'Set response budget',
    description: 'Set the maximum output for the NEXT model response. Use short (2048) for obvious navigation/status/listing/simple tool selection, normal (4096) for ordinary local reasoning or a small edit, and deep (8192) only for genuinely difficult debugging, synthesis, substantial code generation, or conflict resolution. Prefer the smallest level that can complete the next step; 8192 is the absolute maximum.',
    parameters: Type.Object({
      level: Type.Union([
        Type.Literal('short'),
        Type.Literal('normal'),
        Type.Literal('deep'),
      ]),
      reason: Type.String({ description: 'One short sentence explaining why the next response needs this budget' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const maxTokens = await applyResponseBudget(params.level, ctx);
      return {
        content: [{
          type: 'text',
          text: `Response budget set to ${params.level.toUpperCase()} (${maxTokens} max output tokens) for the next model response.`,
        }],
        details: { budget: params.level, maxTokens, reason: params.reason },
      };
    },
  });

  pi.registerTool({
    name: 'declare_task_complexity',
    label: 'Declare task complexity',
    description: 'REQUIRED FIRST ACTION for Implementer. Classify the issue once: trivial for an exact tiny edit with no behavior/design work; normal for ordinary implementation; complex for broad architectural or multi-part work. This selects the runtime execution budget.',
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
    console.log(`PI_BUDGET ${JSON.stringify({ turn: event.turnIndex, budget: responseBudgetLevel, maxTokens: RESPONSE_BUDGETS[responseBudgetLevel] })}`);
    guard.onTurnStart(event.turnIndex);
    const warning = guard.takeSoftWarning();
    if (warning) await pi.sendUserMessage(warning, { deliverAs: 'steer' });
  });

  pi.on('tool_call', (event) => guard.checkToolCall(event.toolName, event.input));
}
