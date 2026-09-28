import { Type } from 'typebox';

import { nextResponseBudgetLevel, RESPONSE_BUDGETS, withResponseBudget } from './pi-common/response-budget-policy.mjs';

// Shared per-turn verbosity control for every Pi agent. This is deliberately
// independent from task-complexity/loop-guard policy.
//
// Normal sessions start at SHORT. A ceiling hit alone does not promote the next
// response: Laguna can spend the entire extra budget reconsidering the same
// decision. Automatic SHORT -> NORMAL -> DEEP escalation is allowed only when
// the same turn also completed a concrete action (edit/write/submit). A response
// below its ceiling, or a ceiling hit without action progress, resets the next
// response to SHORT. DEEP always falls back to SHORT after that response.
// Explicit set_response_budget calls remain one-response overrides.
export default function (pi) {
  const fixedMaxTokens = Number(process.env.PI_FIXED_RESPONSE_MAX_TOKENS || 0);
  if (fixedMaxTokens && (!Number.isSafeInteger(fixedMaxTokens) || fixedMaxTokens < 1)) throw new Error('PI_FIXED_RESPONSE_MAX_TOKENS must be a positive integer');
  const configuredBudgets = {
    short: Number(process.env.PI_RESPONSE_BUDGET_SHORT || RESPONSE_BUDGETS.short),
    normal: Number(process.env.PI_RESPONSE_BUDGET_NORMAL || RESPONSE_BUDGETS.normal),
    deep: Number(process.env.PI_RESPONSE_BUDGET_DEEP || RESPONSE_BUDGETS.deep),
  };
  for (const [name, value] of Object.entries(configuredBudgets)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`PI_RESPONSE_BUDGET_${name.toUpperCase()} must be a positive integer`);
  }

  let level = 'short';
  let turnLevel = 'short';
  let explicitNextResponse = false;
  let turnMadeProgress = false;
  const progressTools = new Set(['edit', 'write', 'submit_result', 'submit_repair']);

  async function apply(nextLevel, ctx) {
    if (!ctx.model) throw new Error('No active model is available for response budgeting');
    const model = fixedMaxTokens ? { ...ctx.model, maxTokens: fixedMaxTokens } : { ...withResponseBudget(ctx.model, nextLevel), maxTokens: configuredBudgets[nextLevel] };
    const changed = await pi.setModel(model);
    if (!changed) throw new Error(`Failed to apply ${nextLevel} response budget`);
    level = nextLevel;
    return fixedMaxTokens || configuredBudgets[nextLevel];
  }

  pi.on('session_start', async (_event, ctx) => {
    await apply('short', ctx);
  });

  if (!fixedMaxTokens) pi.registerTool({
    name: 'set_response_budget',
    label: 'Set response budget',
    description: `Set the maximum output for the NEXT model response only. Use short (${configuredBudgets.short}) for simple work, normal (${configuredBudgets.normal}) for ordinary reasoning, and deep (${configuredBudgets.deep}) only when genuinely necessary. After that response the automatic budget policy resumes. Prefer the smallest sufficient level; ${configuredBudgets.deep} is the configured maximum.`,
    parameters: Type.Object({
      level: Type.Union([Type.Literal('short'), Type.Literal('normal'), Type.Literal('deep')]),
      reason: Type.String({ description: 'One short sentence explaining why the next response needs this budget' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const maxTokens = await apply(params.level, ctx);
      explicitNextResponse = true;
      return {
        content: [{ type: 'text', text: `Response budget set to ${params.level.toUpperCase()} (${maxTokens} max output tokens) for the next model response only.` }],
        details: { budget: params.level, maxTokens, reason: params.reason },
      };
    },
  });

  pi.on('turn_start', (event) => {
    turnLevel = level;
    turnMadeProgress = false;
    console.log(`PI_BUDGET ${JSON.stringify({ turn: event.turnIndex, budget: fixedMaxTokens ? 'fixed' : turnLevel, maxTokens: fixedMaxTokens || configuredBudgets[turnLevel] })}`);
  });

  pi.on('tool_execution_end', (event) => {
    if (!event.isError && progressTools.has(event.toolName)) turnMadeProgress = true;
  });

  pi.on('turn_end', async (event, ctx) => {
    if (fixedMaxTokens) return;
    if (explicitNextResponse) {
      explicitNextResponse = false;
      return;
    }

    const outputTokens = Number(event.message?.usage?.output || 0);
    const nextLevel = nextResponseBudgetLevel(turnLevel, outputTokens, configuredBudgets, { madeProgress: turnMadeProgress });
    await apply(nextLevel, ctx);
    console.log(`PI_BUDGET_NEXT ${JSON.stringify({ afterTurn: event.turnIndex, outputTokens, madeProgress: turnMadeProgress, previousBudget: turnLevel, nextBudget: nextLevel, maxTokens: configuredBudgets[nextLevel] })}`);
  });
}
