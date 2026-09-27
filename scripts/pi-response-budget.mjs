import { Type } from 'typebox';

import { RESPONSE_BUDGETS, withResponseBudget } from './pi-common/response-budget-policy.mjs';

// Shared per-turn verbosity control for every Pi agent. This is deliberately
// independent from task-complexity/loop-guard policy.
export default function (pi) {
  const fixedMaxTokens = Number(process.env.PI_FIXED_RESPONSE_MAX_TOKENS || 0);
  if (fixedMaxTokens && (!Number.isSafeInteger(fixedMaxTokens) || fixedMaxTokens < 1)) throw new Error('PI_FIXED_RESPONSE_MAX_TOKENS must be a positive integer');
  let level = 'short';

  async function apply(nextLevel, ctx) {
    if (!ctx.model) throw new Error('No active model is available for response budgeting');
    const model = fixedMaxTokens ? { ...ctx.model, maxTokens: fixedMaxTokens } : withResponseBudget(ctx.model, nextLevel);
    const changed = await pi.setModel(model);
    if (!changed) throw new Error(`Failed to apply ${nextLevel} response budget`);
    level = nextLevel;
    return fixedMaxTokens || RESPONSE_BUDGETS[nextLevel];
  }

  pi.on('session_start', async (_event, ctx) => {
    await apply('short', ctx);
  });

  if (!fixedMaxTokens) pi.registerTool({
    name: 'set_response_budget',
    label: 'Set response budget',
    description: 'Set the maximum output for the NEXT model response. Use short (2048) for obvious navigation/status/listing/simple tool selection, normal (4096) for ordinary local reasoning or a small edit, and deep (8192) only for genuinely difficult debugging, synthesis, substantial code generation, or conflict resolution. Prefer the smallest sufficient level; 8192 is the absolute maximum.',
    parameters: Type.Object({
      level: Type.Union([Type.Literal('short'), Type.Literal('normal'), Type.Literal('deep')]),
      reason: Type.String({ description: 'One short sentence explaining why the next response needs this budget' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const maxTokens = await apply(params.level, ctx);
      return {
        content: [{ type: 'text', text: `Response budget set to ${params.level.toUpperCase()} (${maxTokens} max output tokens) for the next model response.` }],
        details: { budget: params.level, maxTokens, reason: params.reason },
      };
    },
  });

  pi.on('turn_start', (event) => {
    console.log(`PI_BUDGET ${JSON.stringify({ turn: event.turnIndex, budget: fixedMaxTokens ? 'fixed' : level, maxTokens: fixedMaxTokens || RESPONSE_BUDGETS[level] })}`);
  });
}
