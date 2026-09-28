import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { Type } from 'typebox';

import { ProgressController } from './pi-common/progress-controller.mjs';
import { stageConfig } from './pi-common/stage-config.mjs';

const SUBAGENT_DELEGATION_REQUEST_EVENT = 'prompt-template:subagent:request';
const SUBAGENT_DELEGATION_RESPONSE_EVENT = 'prompt-template:subagent:response';

const COMPLEXITY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    complexity: { type: 'string', enum: ['trivial', 'normal', 'complex'] },
    reason: { type: 'string', minLength: 1, maxLength: 300 },
  },
  required: ['complexity', 'reason'],
  additionalProperties: false,
});

function implementerIssueContext(env = process.env) {
  const contextFile = env.PI_ISSUE_CONTEXT;
  if (!contextFile) throw new Error('PI_ISSUE_CONTEXT is required for runtime complexity classification');
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  return {
    title: String(context.title ?? ''),
    body: String(context.body ?? ''),
  };
}

function validateComplexityValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Complexity classifier returned a non-object structured result');
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('complexity') || !keys.includes('reason')) {
    throw new Error('Complexity classifier returned unexpected structured fields');
  }
  if (!['trivial', 'normal', 'complex'].includes(value.complexity)) {
    throw new Error(`Complexity classifier returned invalid complexity: ${String(value.complexity)}`);
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (!reason || reason.length > 300) throw new Error('Complexity classifier returned an invalid reason');
  return { complexity: value.complexity, reason };
}

function classifierTask(plan, env = process.env) {
  const issue = implementerIssueContext(env);
  return `Classify only the supplied issue and parent execution plan. Do not inspect the repository or solve the task.

Issue title:
${issue.title}

Issue body:
${issue.body}

Parent execution plan:
${plan}`;
}

async function runStructuredComplexityClassifier(pi, ctx, config, plan, signal) {
  const requestId = randomUUID();
  const ownerRunId = ctx.sessionManager.getSessionId();
  const nodeId = 'task-complexity';
  const timeoutMs = Number(config.complexityClassifierTimeoutMs ?? 120000);

  const response = await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let unsubscribe = () => {};

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => finish(reject, new Error('Complexity classification was aborted'));

    unsubscribe = pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
      if (payload?.requestId !== requestId) return;
      if (payload.status !== 'invalid_request' &&
          (payload.ownerRunId !== ownerRunId || payload.nodeId !== nodeId)) return;
      finish(resolve, payload);
    });

    timer = setTimeout(
      () => finish(reject, new Error(`Complexity classifier did not return within ${timeoutMs} ms`)),
      timeoutMs + 5000,
    );
    signal?.addEventListener?.('abort', onAbort, { once: true });

    pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
      requestId,
      ownerRunId,
      nodeId,
      agent: config.complexityClassifierAgent,
      task: classifierTask(plan),
      context: 'fresh',
      cwd: ctx.cwd,
      timeoutMs,
      toolBudget: { hard: 1 },
      intercomBridge: { mode: 'off' },
      result: { kind: 'structured', schema: COMPLEXITY_SCHEMA },
    });
  });

  if (response.status !== 'completed') {
    throw new Error(`Complexity classifier failed: ${response.error || response.status}`);
  }
  if (response.result?.kind !== 'structured') {
    throw new Error('Complexity classifier did not return a structured result');
  }

  return {
    ...validateComplexityValue(response.result.value),
    usage: response.usage ?? null,
  };
}

// Single runtime controller for every model-driven stage. It owns orientation,
// task-complexity declaration, repeat/turn safety and per-response output budget.
export default function (pi) {
  const stage = process.env.PI_STAGE;
  const config = stageConfig(stage);
  const controller = new ProgressController(config);

  async function applyBudget(level, ctx) {
    if (!ctx.model) throw new Error('No active model is available for response budgeting');
    const budgetedModel = controller.modelFor(ctx.model, level);
    process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = String(budgetedModel.maxTokens);
    const changed = await pi.setModel(budgetedModel);
    if (!changed) throw new Error(`Failed to apply ${level} response budget`);
  }

  pi.on('session_start', async (_event, ctx) => {
    await applyBudget('short', ctx);
  });

  if (controller.requireComplexity && config.complexityClassifierAgent) {
    pi.registerTool({
      name: 'classify_task_complexity',
      label: 'Classify task complexity',
      description: 'Classify task complexity through a runtime-owned pi-subagents child with no repository tools. One child tool call is reserved for structured_output so the schema-validated result can be returned. Pass only the short parent execution plan; no raw child output is returned.',
      parameters: Type.Object({
        plan: Type.String({
          minLength: 1,
          maxLength: 6000,
          description: 'The short top-level execution plan already written from the supplied issue text',
        }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const classified = await runStructuredComplexityClassifier(pi, ctx, config, params.plan, signal);
        const result = controller.setComplexity(classified.complexity);
        console.log(`PI_COMPLEXITY ${JSON.stringify({
          stage,
          complexity: classified.complexity,
          reason: classified.reason,
          usage: classified.usage,
        })}`);
        return {
          content: [{
            type: 'text',
            text: `Complexity set to ${result.complexity}: ${classified.reason} Execute the plan now.`,
          }],
          details: {
            ...result,
            reason: classified.reason,
            classifierUsage: classified.usage,
          },
        };
      },
    });
  } else if (controller.requireComplexity) {
    pi.registerTool({
      name: 'declare_task_complexity',
      label: 'Declare task complexity',
      description: 'Record the trivial, normal, or complex classification. Complexity is planning metadata only; it does not change tool quotas or response budgets.',
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
