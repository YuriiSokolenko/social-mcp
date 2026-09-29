import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Type } from 'typebox';

import { ProgressController } from './pi-common/progress-controller.mjs';
import { stageConfig } from './pi-common/stage-config.mjs';
import { trivialRepoLookup } from './pi-common/trivial-repo-lookup.mjs';
import { repoSearch } from './pi-common/repo-search.mjs';

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

const IMPLEMENTATION_PLAN_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
  },
  required: ['steps'],
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

function validateImplementationPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) {
    throw new Error('Implementation planner returned an invalid structured result');
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8) {
    throw new Error('Implementation planner returned an invalid step list');
  }
  const steps = value.steps.map(step => typeof step === 'string' ? step.trim() : '');
  if (steps.some(step => !step || step.length > 240)) {
    throw new Error('Implementation planner returned an invalid plan step');
  }
  return { steps };
}

function plannerTask(env = process.env) {
  const issue = implementerIssueContext(env);
  return `Create the concise top-level implementation plan for this issue. Do not classify it and do not implement it. Describe the evidence/target needed, but do not prescribe scout/subagent/direct-tool routing; runtime complexity policy decides that after classification.

Issue title:
${issue.title}

Issue body:
${issue.body}`;
}

function classifierTask(plan, env = process.env) {
  const issue = implementerIssueContext(env);
  return `Classify only the supplied issue and implementation plan. Do not inspect the repository or solve the task.

Issue title:
${issue.title}

Issue body:
${issue.body}

Implementation plan:
${plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`;
}

async function runStructuredSubagent(pi, ctx, { agent, nodeId, task, schema, timeoutMs, maxTokens = null, toolBudget = { hard: 1 } }, signal) {
  const requestId = randomUUID();
  const ownerRunId = ctx.sessionManager.getSessionId();
  const previousBudget = process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS;
  if (maxTokens) process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = String(maxTokens);

  try {
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
      const onAbort = () => finish(reject, new Error(`${agent} delegation was aborted`));

      unsubscribe = pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
        if (payload?.requestId !== requestId) return;
        if (payload.status !== 'invalid_request' &&
            (payload.ownerRunId !== ownerRunId || payload.nodeId !== nodeId)) return;
        finish(resolve, payload);
      });

      timer = setTimeout(
        () => finish(reject, new Error(`${agent} did not return within ${timeoutMs} ms`)),
        timeoutMs + 5000,
      );
      signal?.addEventListener?.('abort', onAbort, { once: true });

      pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
        requestId,
        ownerRunId,
        nodeId,
        agent,
        task,
        context: 'fresh',
        cwd: ctx.cwd,
        timeoutMs,
        toolBudget,
        intercomBridge: { mode: 'off' },
        result: { kind: 'structured', schema },
      });
    });

    if (response.status !== 'completed') {
      throw new Error(`${agent} failed: ${response.error || response.status}`);
    }
    if (response.result?.kind !== 'structured') {
      throw new Error(`${agent} did not return a structured result`);
    }
    return response;
  } finally {
    if (previousBudget == null) delete process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS;
    else process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = previousBudget;
  }
}

async function runStructuredImplementationPlanner(pi, ctx, config, signal) {
  const request = {
    agent: config.implementationPlannerAgent,
    nodeId: 'implementation-plan',
    task: plannerTask(),
    schema: IMPLEMENTATION_PLAN_SCHEMA,
    timeoutMs: Number(config.implementationPlannerTimeoutMs ?? 120000),
    maxTokens: Number(config.implementationPlannerMaxTokens ?? 768),
    toolBudget: { hard: 3 },
  };
  const retries = Number(config.implementationPlannerStructuredRetry ?? 1);
  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await runStructuredSubagent(pi, ctx, request, signal);
      break;
    } catch (error) {
      const message = String(error?.message ?? error);
      const retryable = message.includes('Missing structured_output call');
      if (!retryable || attempt >= retries) throw error;
      console.log(`PI_SUBAGENT_RETRY ${JSON.stringify({
        agent: config.implementationPlannerAgent,
        reason: 'missing_structured_output',
        attempt: attempt + 1,
      })}`);
    }
  }
  return {
    ...validateImplementationPlan(response.result.value),
    usage: response.usage ?? null,
  };
}

async function runStructuredComplexityClassifier(pi, ctx, config, plan, signal) {
  const response = await runStructuredSubagent(pi, ctx, {
    agent: config.complexityClassifierAgent,
    nodeId: 'task-complexity',
    task: classifierTask(plan),
    schema: COMPLEXITY_SCHEMA,
    timeoutMs: Number(config.complexityClassifierTimeoutMs ?? 120000),
    toolBudget: { hard: 1 },
  }, signal);
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
  const resumePatch = stage === 'implementer' ? process.env.PI_RESUME_PATCH : null;
  const resumedImplementer = Boolean(
    resumePatch &&
    fs.existsSync(resumePatch) &&
    fs.statSync(resumePatch).size > 0
  );
  const controller = new ProgressController(
    resumedImplementer
      ? {
          ...config,
          requireComplexity: false,
          productiveProgress: config.productiveProgress
            ? { ...config.productiveProgress, startState: 'action_required' }
            : null,
        }
      : config
  );

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

  if (controller.requireComplexity && config.implementationPlannerAgent && config.complexityClassifierAgent) {
    pi.registerTool({
      name: 'prepare_implementation',
      label: 'Prepare implementation',
      description: 'Run the runtime-owned implementation planner and then the complexity classifier. Call exactly once as the first startup tool after the operating contract is loaded in the initial prompt; do not write a competing plan in the main agent.',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const plan = await runStructuredImplementationPlanner(pi, ctx, config, signal);
        const classified = await runStructuredComplexityClassifier(pi, ctx, config, plan, signal);
        const result = controller.setComplexity(classified.complexity);
        console.log(`PI_PLAN ${JSON.stringify({ stage, steps: plan.steps, usage: plan.usage })}`);
        console.log(`PI_COMPLEXITY ${JSON.stringify({
          stage,
          complexity: classified.complexity,
          reason: classified.reason,
          usage: classified.usage,
        })}`);
        const numberedPlan = plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
        return {
          content: [{
            type: 'text',
            text: `Implementation plan:\n${numberedPlan}\n\nComplexity: ${result.complexity} — ${classified.reason}\nPreparation complete. Continue according to the loaded Implementer contract. Complexity is metadata and does not by itself require delegation.`,
          }],
          details: {
            ...result,
            plan: plan.steps,
            plannerUsage: plan.usage,
            reason: classified.reason,
            classifierUsage: classified.usage,
          },
        };
      },
    });
  } else if (controller.requireComplexity && config.complexityClassifierAgent) {
    pi.registerTool({
      name: 'classify_task_complexity',
      label: 'Classify task complexity',
      description: 'Classify task complexity through a runtime-owned structured child from the supplied plan.',
      parameters: Type.Object({
        plan: Type.String({ minLength: 1, maxLength: 6000 }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const plan = { steps: params.plan.split('\n').map(line => line.trim()).filter(Boolean) };
        const classified = await runStructuredComplexityClassifier(pi, ctx, config, plan, signal);
        const result = controller.setComplexity(classified.complexity);
        console.log(`PI_COMPLEXITY ${JSON.stringify({
          stage,
          complexity: classified.complexity,
          reason: classified.reason,
          usage: classified.usage,
        })}`);
        return {
          content: [{ type: 'text', text: `Complexity set to ${result.complexity}: ${classified.reason} Execute the plan now.` }],
          details: { ...result, reason: classified.reason, classifierUsage: classified.usage },
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

  if (config.productiveProgress?.blockerTool) {
    pi.registerTool({
      name: config.productiveProgress.blockerTool,
      label: 'Request one evidence action',
      description: 'Use only when one concrete missing fact prevents the next edit/write/submit action. This unlocks exactly one evidence-gathering tool call; after that call productive action is required again.',
      parameters: Type.Object({
        missing: Type.String({ minLength: 1, maxLength: 300 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_toolCallId, params) {
        return {
          content: [{
            type: 'text',
            text: `One evidence action unlocked for: ${params.missing}. After that evidence call, edit/write/submit_result is required again.`,
          }],
          details: params,
        };
      },
    });
  }

  let trivialLookupUsed = false;
  let pendingMutationSnapshot = null;
  let lastSuccessfulMutationSnapshot = null;

  function captureMutationSnapshot(cwd, requestedPath) {
    if (typeof requestedPath !== 'string' || !requestedPath) return null;
    const root = path.resolve(cwd);
    const absolutePath = path.resolve(root, requestedPath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new Error('Mutation path escapes the current worktree');
    }
    const existed = fs.existsSync(absolutePath);
    if (existed && !fs.statSync(absolutePath).isFile()) {
      throw new Error('Mutation rollback supports files only');
    }
    return {
      path: requestedPath,
      absolutePath,
      existed,
      content: existed ? fs.readFileSync(absolutePath) : null,
    };
  }

  if (stage === 'implementer') {
    pi.registerTool({
      name: 'rollback_last_mutation',
      label: 'Rollback last mutation',
      description: 'Restore exactly the file state captured immediately before the most recent successful edit/write. Use when that mutation caused a regression or was the wrong approach. This is a productive recovery action and does not reset unrelated earlier changes.',
      parameters: Type.Object({
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_toolCallId, params) {
        const snapshot = lastSuccessfulMutationSnapshot;
        if (!snapshot) throw new Error('No successful edit/write is available to roll back');
        if (snapshot.existed) {
          fs.mkdirSync(path.dirname(snapshot.absolutePath), { recursive: true });
          fs.writeFileSync(snapshot.absolutePath, snapshot.content);
        } else if (fs.existsSync(snapshot.absolutePath)) {
          fs.rmSync(snapshot.absolutePath, { force: true });
        }
        lastSuccessfulMutationSnapshot = null;
        return {
          content: [{
            type: 'text',
            text: `Rolled back the most recent successful mutation to ${snapshot.path}. Continue from the restored repository state; do not rebuild a workaround around the reverted change.`,
          }],
          details: { path: snapshot.path, reason: params.reason },
        };
      },
    });

    pi.registerTool({
      name: 'repo_search',
      label: 'Repository search',
      description: 'Cheap deterministic literal search over tracked repository paths or content in the current worktree. Use before scout for mechanical discovery; no child model is launched.',
      parameters: Type.Object({
        kind: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('path')])),
        query: Type.String({ minLength: 1, maxLength: 300 }),
        pathPrefix: Type.Optional(Type.String({ maxLength: 300 })),
        extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 12 })),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = repoSearch(ctx.cwd, params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });

    pi.registerTool({
      name: 'trivial_repo_lookup',
      label: 'Trivial repository lookup',
      description: 'For TRIVIAL tasks only: inspect tracked files from origin/dev only, never resumed checkpoint/worktree changes. Honors extension preference order, excludes control/legal/generated-style targets, and reports exact-text idempotency explicitly as latest-dev evidence.',
      parameters: Type.Object({
        extensions: Type.Array(Type.String({ minLength: 1, maxLength: 12 }), { maxItems: 8 }),
        exactText: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (controller.complexity !== 'trivial') {
          throw new Error('trivial_repo_lookup is available only after task complexity is classified as trivial');
        }
        if (trivialLookupUsed) throw new Error('trivial_repo_lookup may be called only once per task');
        trivialLookupUsed = true;
        const result = trivialRepoLookup(ctx.cwd, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        };
      },
    });
  }

  if (!controller.fixedMaxTokens) {
    pi.registerTool({
      name: 'set_response_budget',
      label: 'Set response budget',
      description: `Set the maximum output for the NEXT model response only: short (${controller.budgets.short}), normal (${controller.budgets.normal}), or deep (${controller.budgets.deep}). Use the smallest sufficient level; automatic budget escalation is driven by hitting the active ceiling.`,
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
      productiveState: controller.productiveProgressState(),
    })}`);
  });

  pi.on('tool_call', (event, ctx) => {
    const blocked = controller.checkToolCall(event.toolName, event.input);
    if (blocked) return blocked;
    if (stage === 'implementer' && (event.toolName === 'edit' || event.toolName === 'write')) {
      pendingMutationSnapshot = captureMutationSnapshot(ctx?.cwd || process.cwd(), event.input?.path);
    }
    return undefined;
  });
  pi.on('tool_execution_end', (event) => {
    if (stage === 'implementer' && (event.toolName === 'edit' || event.toolName === 'write')) {
      if (!event.isError && pendingMutationSnapshot) {
        lastSuccessfulMutationSnapshot = pendingMutationSnapshot;
      }
      pendingMutationSnapshot = null;
    }
    controller.onToolExecutionEnd(event.toolName, event.isError);
  });

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
      preservedForToolTurn: next.preservedForToolTurn === true,
      productiveState: controller.productiveProgressState(),
    })}`);
  });
}
