import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Type } from 'typebox';

import { ProgressController, nextActionResponseCap } from './pi-common/progress-controller.mjs';
import { stageConfig } from './pi-common/stage-config.mjs';
import { repoSearch } from './pi-common/repo-search.mjs';
import { safeEdit } from './pi-common/safe-edit.mjs';
import { structuralEdit } from './pi-common/structural-edit.mjs';
import { zoektSearch } from './pi-common/zoekt-search.mjs';

const SUBAGENT_DELEGATION_REQUEST_EVENT = 'prompt-template:subagent:request';
const SUBAGENT_DELEGATION_RESPONSE_EVENT = 'prompt-template:subagent:response';

const IMPLEMENTATION_PREPARATION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
    complexity: { type: 'string', enum: ['trivial', 'nontrivial'] },
    reason: { type: 'string', minLength: 1, maxLength: 300 },
  },
  required: ['steps', 'complexity', 'reason'],
  additionalProperties: false,
});

function implementerIssueContext(env = process.env) {
  const contextFile = env.PI_ISSUE_CONTEXT;
  if (!contextFile) throw new Error('PI_ISSUE_CONTEXT is required for runtime implementation preparation');
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  return {
    title: String(context.title ?? ''),
    body: String(context.body ?? ''),
  };
}

function validateImplementationPreparation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Implementation planner returned a non-object structured result');
  }
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes('steps') || !keys.includes('complexity') || !keys.includes('reason')) {
    throw new Error('Implementation planner returned unexpected structured fields');
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8) {
    throw new Error('Implementation planner returned an invalid step list');
  }
  const steps = value.steps.map(step => typeof step === 'string' ? step.trim() : '');
  if (steps.some(step => !step || step.length > 240)) {
    throw new Error('Implementation planner returned an invalid plan step');
  }
  if (!['trivial', 'nontrivial'].includes(value.complexity)) {
    throw new Error(`Implementation planner returned invalid complexity: ${String(value.complexity)}`);
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (!reason || reason.length > 300) throw new Error('Implementation planner returned an invalid reason');
  return { steps, complexity: value.complexity, reason };
}

function plannerTask(env = process.env) {
  const issue = implementerIssueContext(env);
  return `Create the concise top-level implementation plan for this issue and classify only whether it is trivial or nontrivial. Do not inspect the repository or implement the task. Describe the evidence/target needed, but do not prescribe scout/subagent/direct-tool routing.

Issue title:
${issue.title}

Issue body:
${issue.body}`;
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
    schema: IMPLEMENTATION_PREPARATION_SCHEMA,
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
    ...validateImplementationPreparation(response.result.value),
    usage: response.usage ?? null,
  };
}


// Single runtime controller for every model-driven stage. It owns orientation,
// task-complexity declaration, repeat/turn safety and per-response output budget.
export default function (pi) {
  const stage = process.env.PI_STAGE;
  const config = stageConfig(stage);
  const resumePatch = stage === 'implementer' ? process.env.PI_RESUME_PATCH : null;
  const resumedImplementer = process.env.PI_RESUME_ACTIVE != null
    ? process.env.PI_RESUME_ACTIVE === 'true'
    : Boolean(
        resumePatch &&
        fs.existsSync(resumePatch) &&
        fs.statSync(resumePatch).size > 0
      );
  const freshBaseCommit = stage === 'implementer'
    ? String(process.env.PI_IMPLEMENTER_START_COMMIT ?? '').trim()
    : '';
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

  let appliedActionCap = 0;
  let actionTurnAttemptedTool = false;

  function syncProductiveState() {
    const state = controller.productiveProgressState();
    process.env.PI_PRODUCTIVE_STATE = state;
    return state;
  }

  async function applyBudget(level, ctx) {
    if (!ctx.model) throw new Error('No active model is available for response budgeting');
    const budgetedModel = controller.modelFor(ctx.model, level);
    process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = String(budgetedModel.maxTokens);
    const changed = await pi.setModel(budgetedModel);
    if (!changed) throw new Error(`Failed to apply ${level} response budget`);
  }

  async function applyTokenCap(maxTokens, ctx) {
    if (!ctx.model) throw new Error('No active model is available for response budgeting');
    const cappedModel = { ...ctx.model, maxTokens };
    process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = String(maxTokens);
    const changed = await pi.setModel(cappedModel);
    if (!changed) throw new Error(`Failed to apply action-required response cap of ${maxTokens} tokens`);
  }

  syncProductiveState();

  pi.on('session_start', async (_event, ctx) => {
    await applyBudget('short', ctx);
  });

  if (controller.requireComplexity && config.implementationPlannerAgent) {
    pi.registerTool({
      name: 'prepare_implementation',
      label: 'Prepare implementation',
      description: 'Run the runtime-owned implementation planner once. It returns the plan and a trivial/nontrivial classification in one structured result; do not write a competing plan in the main agent.',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const prepared = await runStructuredImplementationPlanner(pi, ctx, config, signal);
        const result = controller.setComplexity(prepared.complexity);
        console.log(`PI_PLAN ${JSON.stringify({
          stage,
          steps: prepared.steps,
          complexity: prepared.complexity,
          reason: prepared.reason,
          usage: prepared.usage,
        })}`);
        console.log(`PI_COMPLEXITY ${JSON.stringify({
          stage,
          complexity: prepared.complexity,
          reason: prepared.reason,
          usage: prepared.usage,
          source: 'implementation-planner',
        })}`);
        const numberedPlan = prepared.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
        const provenance = stage === 'implementer' && !resumedImplementer
          ? `\n\nFresh worktree provenance: runtime created this worktree directly from latest fetched origin/dev${freshBaseCommit ? ` at ${freshBaseCommit}` : ''}, and no saved issue work was applied. Until the first successful safe_edit/edit/write, direct reads of this worktree are authoritative latest-dev evidence; do not use extra Git/evidence calls to re-prove that provenance.`
          : '';
        const lspWorkspace = stage === 'implementer' && !resumedImplementer
          ? `\n\nLSP workspace root: ${ctx.cwd}. For a cold name-only lookup with an explicit language, call lsp_start_server once with the matching server_id and this exact absolute workspace_root before lsp_find_symbol; lsp_start_server is a control action and does not consume evidence budget.`
          : '';
        return {
          content: [{
            type: 'text',
            text: `Implementation plan:\n${numberedPlan}\n\nComplexity: ${result.complexity} — ${prepared.reason}\nPreparation complete. Continue according to the loaded Implementer contract.${provenance}${lspWorkspace}`,
          }],
          details: {
            ...result,
            plan: prepared.steps,
            plannerUsage: prepared.usage,
            reason: prepared.reason,
            freshBaseCommit: stage === 'implementer' && !resumedImplementer ? freshBaseCommit : null,
            freshWorktreeIsLatestDev: stage === 'implementer' && !resumedImplementer,
            lspWorkspaceRoot: stage === 'implementer' && !resumedImplementer ? ctx.cwd : null,
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

  if (config.productiveProgress?.blockerTool) {
    pi.registerTool({
      name: config.productiveProgress.blockerTool,
      label: 'Request one evidence action',
      description: 'Use only when one concrete missing fact prevents the next safe_edit/edit/write/submit action. This unlocks exactly one evidence-gathering tool call; after that call productive action is required again.',
      parameters: Type.Object({
        missing: Type.String({ minLength: 1, maxLength: 300 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_toolCallId, params) {
        return {
          content: [{
            type: 'text',
            text: `One evidence action unlocked for: ${params.missing}. After that evidence call, safe_edit/edit/write/submit_result is required again.`,
          }],
          details: params,
        };
      },
    });
  }

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
      name: 'structural_edit',
      label: 'Structural AST edit',
      description: 'Preferred source-code mutation when one exact syntax node can be described with an ast-grep pattern/rewrite. ast-grep infers the language from the target file, dry-runs the rewrite, requires exactly one AST match, verifies the matched byte range is still current, then writes that one replacement atomically. Use metavariables to preserve untouched code instead of reproducing neighboring statements. Use safe_edit for bounded text/config edits or when structural matching is not a good fit.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 1000 }),
        pattern: Type.String({ minLength: 1, maxLength: 20000 }),
        rewrite: Type.String({ minLength: 1, maxLength: 20000 }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = structuralEdit(ctx.cwd, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        };
      },
    });

    pi.registerTool({
      name: 'safe_edit',
      label: 'Safe line edit',
      description: 'Deterministic current-worktree mutation by 1-based line/range. Prefer it for bounded insert/replace changes when reproducing multiline oldText would be brittle. It re-reads the file immediately before writing, validates an optional expected marker, preserves newline style/final-newline state, writes atomically, returns a bounded post-edit preview of what landed on disk, and participates in normal rollback/progress handling. Do not re-read merely to verify a successful result.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 1000 }),
        operation: Type.Union([
          Type.Literal('insert_before'),
          Type.Literal('insert_after'),
          Type.Literal('replace'),
        ]),
        start_line: Type.Integer({ minimum: 1 }),
        end_line: Type.Optional(Type.Integer({ minimum: 1 })),
        text: Type.String({ minLength: 1, maxLength: 20000 }),
        expected_marker: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = safeEdit(ctx.cwd, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        };
      },
    });

    pi.registerTool({
      name: 'rollback_last_mutation',
      label: 'Rollback last mutation',
      description: 'Restore exactly the file state captured immediately before the most recent successful safe_edit/edit/write. Use when that mutation caused a regression or was the wrong approach. This is a productive recovery action and does not reset unrelated earlier changes.',
      parameters: Type.Object({
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_toolCallId, params) {
        const snapshot = lastSuccessfulMutationSnapshot;
        if (!snapshot) throw new Error('No successful safe_edit/edit/write is available to roll back');
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

    if (process.env.PI_ZOEKT_URL) {
      pi.registerTool({
        name: 'indexed_repo_search',
        label: 'Indexed repository search',
        description: 'Fast read-only search against the configured Zoekt index of dev. Prefer it for literal/path discovery when the source symbol/path is not already known. For a known source-code symbol, use semantic LSP lookup first. Results may lag the current worktree, so use direct read/repo_search for exact post-mutation verification.',
        parameters: Type.Object({
          kind: Type.Optional(Type.Union([
            Type.Literal('content'),
            Type.Literal('path'),
            Type.Literal('symbol'),
          ])),
          query: Type.String({ minLength: 1, maxLength: 300 }),
          pathPrefix: Type.Optional(Type.String({ maxLength: 300 })),
          extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 12 })),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        }),
        async execute(_toolCallId, params) {
          const startedAt = performance.now();
          const result = await zoektSearch({
            endpoint: process.env.PI_ZOEKT_URL,
            repository: process.env.PI_ZOEKT_REPOSITORY || '',
            timeoutMs: Number(process.env.PI_ZOEKT_TIMEOUT_MS || 3000),
            ...params,
          });
          console.info(`indexed_repo_search backend=zoekt query=${JSON.stringify(params.query)} matches=${result.matches.length} durationMs=${Math.round(performance.now() - startedAt)}`);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        },
      });
    }

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
    actionTurnAttemptedTool = false;
    controller.onTurnStart(event.turnIndex);
    syncProductiveState();
    console.log(`PI_BUDGET ${JSON.stringify({
      turn: event.turnIndex,
      stage,
      budget: controller.fixedMaxTokens ? 'fixed' : controller.turnLevel,
      maxTokens: controller.fixedMaxTokens || controller.budgets[controller.turnLevel],
      productiveState: controller.productiveProgressState(),
    })}`);
  });

  pi.on('tool_call', (event, ctx) => {
    actionTurnAttemptedTool = true;
    const blocked = controller.checkToolCall(event.toolName, event.input);
    if (blocked) return blocked;
    if (stage === 'implementer' && ['structural_edit', 'safe_edit', 'edit', 'write'].includes(event.toolName)) {
      pendingMutationSnapshot = captureMutationSnapshot(ctx?.cwd || process.cwd(), event.input?.path);
    }
    return undefined;
  });
  pi.on('tool_execution_end', (event) => {
    if (stage === 'implementer' && ['structural_edit', 'safe_edit', 'edit', 'write'].includes(event.toolName)) {
      if (!event.isError && pendingMutationSnapshot) {
        lastSuccessfulMutationSnapshot = pendingMutationSnapshot;
      }
      pendingMutationSnapshot = null;
    }
    controller.onToolExecutionEnd(event.toolName, event.isError);
    syncProductiveState();
  });

  pi.on('turn_end', async (event, ctx) => {
    const outputTokens = Number(event.message?.usage?.output || 0);
    const next = controller.afterTurn(outputTokens);
    const productiveState = syncProductiveState();
    const actionCap = Number(config.productiveProgress?.actionResponseMaxTokens ?? 0);
    const actionRetryCap = Number(
      config.productiveProgress?.actionResponseRetryMaxTokens ?? actionCap
    );
    const actionRequired =
      productiveState === 'action_required' ||
      productiveState === 'recovery_action_required';
    const targetActionCap = actionCap > 0
      ? nextActionResponseCap({
          baseCap: actionCap,
          retryCap: actionRetryCap,
          outputTokens,
          actionRequired,
          attemptedTool: actionTurnAttemptedTool,
          madeProgress: controller.turnMadeProgress,
        })
      : 0;

    if (targetActionCap > 0) {
      if (appliedActionCap !== targetActionCap || Number(ctx.model?.maxTokens) !== targetActionCap) {
        await applyTokenCap(targetActionCap, ctx);
      }
      appliedActionCap = targetActionCap;
    } else if (appliedActionCap > 0) {
      await applyBudget(next.level, ctx);
      appliedActionCap = 0;
    } else if (next.changed) {
      await applyBudget(next.level, ctx);
    }

    console.log(`PI_BUDGET_NEXT ${JSON.stringify({
      afterTurn: event.turnIndex,
      outputTokens,
      madeProgress: controller.turnMadeProgress,
      attemptedTool: actionTurnAttemptedTool,
      nextBudget: next.level,
      maxTokens: appliedActionCap || next.maxTokens,
      explicit: next.explicit === true,
      preservedForToolTurn: next.preservedForToolTurn === true,
      productiveState,
      actionCapApplied: appliedActionCap > 0,
      actionCapEscalated: appliedActionCap > actionCap,
    })}`);
  });
}
