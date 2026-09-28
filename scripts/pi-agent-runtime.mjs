import { Type } from 'typebox';

import { ProgressController } from './pi-common/progress-controller.mjs';
import { stageConfig } from './pi-common/stage-config.mjs';

// Single runtime controller for every model-driven stage. It owns orientation,
// task-complexity declaration, repeat/turn safety and per-response output budget.
export default function (pi) {
  const stage = process.env.PI_STAGE;
  const config = stageConfig(stage);
  const controller = new ProgressController(config);

  async function applyBudget(level, ctx) {
    if (!ctx.model) throw new Error('No active model is available for response budgeting');
    const changed = await pi.setModel(controller.modelFor(ctx.model, level));
    if (!changed) throw new Error(`Failed to apply ${level} response budget`);
  }

  pi.on('session_start', async (_event, ctx) => {
    await applyBudget('short', ctx);
  });

  if (controller.requireComplexity) {
    pi.registerTool({
      name: 'declare_task_complexity',
      label: 'Declare task complexity',
      description: 'After the bounded orientation and short execution plan, classify this task as trivial, normal, or complex. Complexity is planning metadata only; it does not change tool quotas or response budgets.',
      parameters: Type.Object({
        complexity: Type.Union([
          Type.Literal('trivial'),
          Type.Literal('normal'),
          Type.Literal('complex'),
        ]),
        reason: Type.String({ description: 'One short sentence explaining the classification' }),
      }),
      async execute(_toolCallId, params) {
        const result = controller.setComplexity(params.complexity);
        return {
          content: [{
            type: 'text',
            text: result.changed
              ? `Complexity set to ${result.complexity}. Execute the plan; escalate only if the actual scope expands.`
              : `Complexity remains ${result.complexity}.`,
          }],
          details: { ...result, reason: params.reason },
        };
      },
    });
  }

  if (!controller.fixedMaxTokens) {
    pi.registerTool({
      name: 'set_response_budget',
      label: 'Set response budget',
      description: `Set the maximum output for the NEXT model response only: short (${controller.budgets.short}), normal (${controller.budgets.normal}), or deep (${controller.budgets.deep}). Use the smallest sufficient level; a ceiling hit without concrete progress will not be rewarded with a larger automatic budget.`,
      parameters: Type.Object({
        level: Type.Union([Type.Literal('short'), Type.Literal('normal'), Type.Literal('deep')]),
        reason: Type.String({ description: 'One short sentence explaining why the next response needs this budget' }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const maxTokens = controller.setBudget(params.level);
        await applyBudget(params.level, ctx);
        return {
          content: [{ type: 'text', text: `Response budget set to ${params.level.toUpperCase()} (${maxTokens} max output tokens) for the next response only.` }],
          details: { budget: params.level, maxTokens, reason: params.reason },
        };
      },
    });
  }

  pi.on('turn_start', (event) => {
    controller.onTurnStart(event.turnIndex);
    console.log(`PI_BUDGET ${JSON.stringify({
      turn: event.turnIndex,
      stage,
      budget: controller.fixedMaxTokens ? 'fixed' : controller.turnLevel,
      maxTokens: controller.fixedMaxTokens || controller.budgets[controller.turnLevel],
    })}`);
  });

  pi.on('tool_call', (event) => controller.checkToolCall(event.toolName, event.input));
  pi.on('tool_execution_end', (event) => controller.onToolExecutionEnd(event.toolName, event.isError));

  pi.on('turn_end', async (event, ctx) => {
    const outputTokens = Number(event.message?.usage?.output || 0);
    const next = controller.afterTurn(outputTokens);
    if (next.changed) await applyBudget(next.level, ctx);
    console.log(`PI_BUDGET_NEXT ${JSON.stringify({
      afterTurn: event.turnIndex,
      outputTokens,
      madeProgress: controller.turnMadeProgress,
      nextBudget: next.level,
      maxTokens: next.maxTokens,
      explicit: next.explicit === true,
    })}`);
  });
}
