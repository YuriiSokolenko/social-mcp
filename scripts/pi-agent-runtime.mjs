import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Type } from 'typebox';

import {
  FINISH_TOOLS,
  ProgressController,
  actionRequiredToolNames,
  classifyTruncatedToolCall,
  MAX_CEILING_WITHOUT_TOOL_TURNS,
  nextActionRequiredProseOnlyTurns,
  nextCeilingWithoutToolTurns,
  nextActionResponseCap,
  truncatedToolCallGuidance,
} from './pi-common/progress-controller.mjs';
import { stageConfig } from './pi-common/stage-config.mjs';
import { mergeNewlyActiveTools } from './pi-common/session-state.mjs';
import { repoSearch } from './pi-common/repo-search.mjs';
import { CHECK_KINDS, checkMetricRecord, runCheck, sandboxPreflight } from './pi-common/run-check.mjs';
import { appendCheckRecord, normalizeScope } from './pi-common/validation-ledger.mjs';
import { safeEdit } from './pi-common/safe-edit.mjs';
import { structuralEdit } from './pi-common/structural-edit.mjs';
import {
  captureMutationSnapshot,
  detectNoOpWrite,
  mutationSnapshotChanged,
} from './pi-common/mutation-snapshot.mjs';
import { baseRef } from './pi-common/project-config.mjs';
import {
  SemanticLoopGuard,
  isSemanticMutationTool,
  loopGuardLimits,
  repositoryStateFingerprint,
} from './pi-common/semantic-loop-guard.mjs';
import { zoektSearch } from './pi-common/zoekt-search.mjs';
import { MutationTargetRejected, resolveMutationTarget } from './pi-common/mutation-target.mjs';

// Every tool whose effect is one target-file mutation: snapshot/rollback/no-op/progress apply.
const CONTENT_MUTATION_TOOLS = new Set(['structural_edit', 'safe_edit', 'edit', 'write']);

// Trust boundary: the coding session's agent definition, tool allowlist and extensions come
// from THIS module's control checkout (the trusted harness), never from the issue worktree the
// Implementer can rewrite. It is registered in code through pi-subagents' runtime-agent
// registry; an explicit `extensions` list disables ambient (worktree/global) extensions for the
// fork, worktree `agentOverrides` can only narrow model/thinking for a runtime agent, and a
// same-name worktree agent collides and fails the launch closed. The fork runs this same
// runtime (in coding-session mode), so every runtime protection applies inside it unchanged.
const CONTROL_SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_AGENT_REGISTER_EVENT = 'pi-subagents:runtime-agent-register:v1';
const CODING_SESSION_SYSTEM_PROMPT = `You are the same Implementer, continuing your own session in its coding phase.

The conversation above is your session: the issue, your contract, the evidence you gathered and the implementation you decided. Exploration and implementation decisions are already complete. Do not re-plan, design or draft code in prose. Start by calling the appropriate coding tool.

Your normal turns had a small output ceiling; this coding session has a large one only so large code fits in tool arguments. Finish the task here under your normal contract and runtime rules: write the code, add or update tests where the task needs them, run_check, fix what the checks report, and call submit_result when the work is complete. If one concrete fact is missing, use need_more_evidence.`;

export function codingSessionAgentDefinition(tools, scriptsDir = CONTROL_SCRIPTS_DIR) {
  return {
    description: '16k coding-phase continuation forked from the Implementer session; implements, verifies and submits',
    systemPrompt: CODING_SESSION_SYSTEM_PROMPT,
    tools: [...tools],
    // Explicit list: ambient extensions are disabled for the fork; all paths are absolute paths
    // inside the trusted control checkout. The runtime enforces the same rules as in the parent.
    extensions: [
      path.join(scriptsDir, 'pi-bash-timeout.mjs'),
      path.join(scriptsDir, 'pi-agent-runtime.mjs'),
      path.join(scriptsDir, 'pi-implementer-result-tool.mjs'),
    ],
    systemPromptMode: 'append',
    inheritProjectContext: true,
    inheritGlobalContext: true,
    inheritSkills: false,
    defaultContext: 'fork',
    // The string "off" (pi-subagents 0.71.0 appends it as a :off model suffix); `false` would
    // add no suffix and leave the model's default reasoning on. Also prevents defaultThinking
    // from filling the field. The delegation request repeats it as an override, and the runtime
    // enforces it on the wire (see CODING_SESSION_PAYLOAD_PATCH).
    thinking: 'off',
  };
}

// Laguna (llama-server, openai-completions) reasons by default once tools are present, and pi's
// "off" level sends no reasoning field for this provider's compat. The coding session therefore
// disables thinking on every provider request itself; chat_template_kwargs.enable_thinking=false
// is honored by the Laguna chat template (live probe: 0 reasoning chars, immediate tool call).
export function disableThinkingInPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.messages)) return payload;
  return {
    ...payload,
    chat_template_kwargs: { ...(payload.chat_template_kwargs ?? {}), enable_thinking: false },
  };
}

// Both OpenAI-compatible Chat Completions and Responses requests accept tool_choice="required".
// The active Pi tool surface has already been reduced to the valid action_required tools before
// the request is built, so this forces a real tool call without choosing the tool on the model's
// behalf. The runtime keeps this request constraint armed until the provider emits a tool call;
// transport retries or ceiling-hit responses must not consume it. Only a non-retryable compatibility
// status (400/404/422) on a request that was actually forced clears the constraint; transient
// statuses such as 408/429 leave it armed for the retry.
export function requireToolChoiceInPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.tools) || payload.tools.length === 0) {
    return payload;
  }
  return { ...payload, tool_choice: 'required' };
}

// Set (only) for the forked coding session: switches this runtime into coding-session mode.
function codingSessionSpec(env = process.env) {
  try {
    const spec = JSON.parse(env.PI_CODING_SESSION ?? '');
    const maxTokens = Number(spec?.maxTokens);
    if (spec?.sessionId && Number.isSafeInteger(maxTokens) && maxTokens > 0) return { sessionId: String(spec.sessionId), maxTokens };
  } catch { /* parent session */ }
  return null;
}

const SUBAGENT_DELEGATION_REQUEST_EVENT = 'prompt-template:subagent:request';
const SUBAGENT_DELEGATION_RESPONSE_EVENT = 'prompt-template:subagent:response';

// Evidence needs are reported independently of complexity: a nontrivial task can still need
// zero repository evidence (a fresh standalone file from a complete spec), so complexity is
// not a valid proxy for how many evidence actions the Implementer should be granted.
const MAX_PLANNER_EVIDENCE_BUDGET = 6;

const MAX_PLANNER_STEP_LENGTH = 240;

// Transport boundary only: tolerates repairable deviations (overlong steps, extra fields) so they
// reach normalizeImplementationPreparation() instead of failing before the runtime sees a value.
// The strict canonical contract is enforced locally by validateImplementationPreparation().
const IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 1 },
    },
    complexity: { type: 'string', enum: ['trivial', 'nontrivial'] },
    evidence_budget: { type: 'integer', minimum: 0, maximum: MAX_PLANNER_EVIDENCE_BUDGET },
    reason: { type: 'string', minLength: 1, maxLength: 300 },
  },
  required: ['steps', 'complexity', 'evidence_budget', 'reason'],
  additionalProperties: true,
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

// Safe repairs only: keep the four canonical fields, trim strings, truncate overlong steps.
// Missing or invalid required fields are left untouched so strict validation fails closed.
function normalizeImplementationPreparation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const trim = item => typeof item === 'string' ? item.trim() : item;
  const normalized = {};
  for (const key of ['steps', 'complexity', 'evidence_budget', 'reason']) {
    if (!(key in value)) continue;
    normalized[key] = key === 'steps' && Array.isArray(value.steps)
      ? value.steps.map(step => typeof step === 'string' ? step.trim().slice(0, MAX_PLANNER_STEP_LENGTH).trim() : step)
      : trim(value[key]);
  }
  return normalized;
}

function validateImplementationPreparation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Implementation planner returned a non-object structured result');
  }
  const keys = Object.keys(value);
  const requiredKeys = ['steps', 'complexity', 'evidence_budget', 'reason'];
  if (keys.length !== requiredKeys.length || !requiredKeys.every(key => keys.includes(key))) {
    throw new Error('Implementation planner returned unexpected structured fields');
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8) {
    throw new Error('Implementation planner returned an invalid step list');
  }
  const steps = value.steps.map(step => typeof step === 'string' ? step.trim() : '');
  if (steps.some(step => !step || step.length > MAX_PLANNER_STEP_LENGTH)) {
    throw new Error('Implementation planner returned an invalid plan step');
  }
  if (!['trivial', 'nontrivial'].includes(value.complexity)) {
    throw new Error(`Implementation planner returned invalid complexity: ${String(value.complexity)}`);
  }
  const evidenceBudget = Number(value.evidence_budget);
  if (!Number.isSafeInteger(evidenceBudget) || evidenceBudget < 0 || evidenceBudget > MAX_PLANNER_EVIDENCE_BUDGET) {
    throw new Error(`Implementation planner returned invalid evidence_budget: ${String(value.evidence_budget)}`);
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (!reason || reason.length > 300) throw new Error('Implementation planner returned an invalid reason');
  return { steps, complexity: value.complexity, evidenceBudget, reason };
}

function plannerTask(env = process.env, { repair = false } = {}) {
  const issue = implementerIssueContext(env);
  return `Create the concise top-level implementation plan for this issue, classify only whether it is trivial or nontrivial, and separately estimate the bounded evidence budget (0-${MAX_PLANNER_EVIDENCE_BUDGET}): how many repository evidence-gathering actions (reads/searches) the Implementer will likely need before it can safely mutate. Evidence needs are independent of complexity: a nontrivial task can still need 0 evidence actions (for example a fresh standalone file from a complete written specification), while a trivial one-line fix to an unfamiliar file may still need 1-2. Do not inspect the repository or implement the task. Describe the evidence/target needed, but do not prescribe scout/subagent/direct-tool routing.

Output contract: call structured_output with the result wrapped in the required outer envelope { "value": { "steps": [...], "complexity": "...", "evidence_budget": N, "reason": "..." } }. Each step must be at most 240 characters (aim for 200 or fewer); include no fields beyond the four listed.${repair ? `\n\nREPAIR: your previous structured_output call was rejected by schema validation. Call structured_output again with exactly { "value": { "steps": [...], "complexity": "trivial|nontrivial", "evidence_budget": 0-${MAX_PLANNER_EVIDENCE_BUDGET}, "reason": "..." } } and nothing else.` : ''}

Issue title:
${issue.title}

Issue body:
${issue.body}`;
}

// `context: 'fork'` branches the parent's persisted session transcript into the child
// (pi-subagents createBranchedSession); `childEnv` is visible only while the child runs.
async function runStructuredSubagent(pi, ctx, {
  agent, nodeId, task, schema = null, timeoutMs, maxTokens = null, toolBudget = { hard: 1 },
  context = 'fresh', childEnv = {}, thinking = null,
}, signal) {
  const requestId = randomUUID();
  const ownerRunId = ctx.sessionManager.getSessionId();
  const previousBudget = process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS;
  if (maxTokens) process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = String(maxTokens);
  const previousEnv = Object.fromEntries(Object.keys(childEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, childEnv);

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
        context,
        cwd: ctx.cwd,
        timeoutMs,
        ...(toolBudget ? { toolBudget } : {}),
        // Request-level thinking wins over the agent's (incl. worktree agentOverrides/defaults).
        ...(thinking ? { thinking } : {}),
        intercomBridge: { mode: 'off' },
        result: schema ? { kind: 'structured', schema } : { kind: 'text' },
      });
    });

    if (response.status !== 'completed') {
      throw new Error(`${agent} failed: ${response.error || response.status}`);
    }
    if (schema && response.result?.kind !== 'structured') {
      throw new Error(`${agent} did not return a structured result`);
    }
    return response;
  } finally {
    if (previousBudget == null) delete process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS;
    else process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = previousBudget;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// pi-subagents reports a terminal schema/envelope rejection as `Structured output validation failed: <details>`
// (readStructuredOutput). The structured_output tool's own per-call "Validation failed for tool" errors stay
// inside the subagent loop; if that loop cannot recover, the runtime sees a timeout, which is not retried.
const STRUCTURED_SCHEMA_FAILURE = /(^|: )Structured output validation failed:/;

async function runStructuredImplementationPlanner(pi, ctx, config, signal) {
  const request = {
    agent: config.implementationPlannerAgent,
    nodeId: 'implementation-plan',
    task: plannerTask(),
    schema: IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA,
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
      const missing = message.includes('Missing structured_output call');
      const schemaFailure = !missing && STRUCTURED_SCHEMA_FAILURE.test(message);
      const retryable = missing || schemaFailure;
      const reason = missing ? 'missing_structured_output' : schemaFailure ? 'structured_output_schema_failure' : 'planner_infrastructure_failure';
      if (schemaFailure) request.task = plannerTask(process.env, { repair: true });
      console.warn(`PI_SUBAGENT_FAILURE ${JSON.stringify({
        agent: config.implementationPlannerAgent,
        reason,
        attempt: attempt + 1,
        retriesExhausted: retryable && attempt >= retries,
        error: message,
      })}`);
      if (!retryable || attempt >= retries) throw error;
      console.log(`PI_SUBAGENT_RETRY ${JSON.stringify({
        agent: config.implementationPlannerAgent,
        reason,
        attempt: attempt + 1,
      })}`);
    }
  }
  return {
    ...validateImplementationPreparation(normalizeImplementationPreparation(response.result.value)),
    usage: response.usage ?? null,
  };
}

function resultText(result) {
  if (typeof result === 'string') return result;
  const content = Array.isArray(result) ? result : result?.content;
  if (Array.isArray(content)) return content.map(part => part?.text ?? '').join('\n');
  return typeof result?.message === 'string' ? result.message : '';
}

function codingSessionLog(phase, fields) {
  const line = `PI_CODING_SESSION ${JSON.stringify({ phase, ...fields })}`;
  if (['failed', 'rejected', 'cancelled'].includes(phase)) console.warn(line);
  else console.log(line);
}


// Single runtime controller for every model-driven stage. It owns orientation,
// task-complexity declaration, repeat/turn safety and per-response output budget.
export default function (pi) {
  const stage = process.env.PI_STAGE;
  // Inside the forked coding session this same runtime enforces the same rules, with the
  // large ceiling on every response and no nested transition or legacy grant.
  const codingSession = stage === 'implementer' ? codingSessionSpec() : null;
  const baseConfig = stageConfig(stage);
  const config = codingSession
    ? {
        ...baseConfig,
        fixedResponseMaxTokens: codingSession.maxTokens,
        productiveProgress: {
          ...baseConfig.productiveProgress,
          actionResponseMaxTokens: codingSession.maxTokens,
          actionResponseRetryMaxTokens: codingSession.maxTokens,
          codingSessionTool: null,
          largeMutationBudgetTool: null,
        },
      }
    : baseConfig;
  const resumePatch = stage === 'implementer' ? process.env.PI_RESUME_PATCH : null;
  const resumedImplementer = process.env.PI_RESUME_ACTIVE != null
    ? process.env.PI_RESUME_ACTIVE === 'true'
    : Boolean(
        resumePatch &&
        fs.existsSync(resumePatch) &&
        fs.statSync(resumePatch).size > 0
      );
  const validationRepair = stage === 'implementer' && process.env.PI_VALIDATION_REPAIR === 'true';
  const freshBaseCommit = stage === 'implementer'
    ? String(process.env.PI_IMPLEMENTER_START_COMMIT ?? '').trim()
    : '';
  // A coding session is already prepared: it starts directly in the action phase.
  const directActionImplementer = resumedImplementer || validationRepair || Boolean(codingSession);
  const controller = new ProgressController(
    directActionImplementer
      ? {
          ...config,
          requireComplexity: false,
          productiveProgress: config.productiveProgress
            ? { ...config.productiveProgress, startState: 'action_required' }
            : null,
        }
      : config
  );
  const loopGuard = stage === 'implementer'
    ? new SemanticLoopGuard(loopGuardLimits())
    : null;

  let appliedActionCap = 0;
  let actionTurnAttemptedTool = false;
  let actionRequiredProseOnlyTurns = 0;
  let ceilingWithoutToolTurns = 0;
  let requireToolOnNextProviderRequest = false;
  let forcedProviderRequestInFlight = false;
  let loopGuardSteeredThisTurn = false;
  let unrestrictedActiveTools = null;
  // Tracks whether the current turn attempted one of the finish tools (mutation, rollback,
  // or terminal submission) it was granted a one-shot elevated mutation budget for.
  let elevatedTurnAttemptedFinishTool = false;

  function syncProductiveState() {
    const state = controller.productiveProgressState();
    process.env.PI_PRODUCTIVE_STATE = state;
    return state;
  }

  let lastSurfaceSignature = null;
  function setSurface(names, reason) {
    pi.setActiveTools(names);
    const signature = names.join(',');
    if (signature !== lastSurfaceSignature) {
      console.log(`PI_TOOL_SURFACE_UPDATE ${JSON.stringify({ stage, reason, active: names })}`);
      lastSurfaceSignature = signature;
    }
  }

  function syncActionToolSurface(productiveState) {
    const preComplexityRequired =
      config.preComplexityActionResponseMaxTokens != null &&
      controller.preComplexityActionRequired();
    const productiveActionRequired =
      stage === 'implementer' &&
      config.productiveProgress &&
      productiveState === 'action_required';

    const largeMutationBudgetActive = stage === 'implementer' && controller.largeMutationBudgetActive();
    // Completed one-shot control tools disappear. Enabled tools such as `subagent` are shown only
    // where the controller gate lets them execute (evidence_allowed), never in action_required.
    const satisfied = controller.transitions.satisfiedToolNames();
    const current = pi.getActiveTools();
    // Tools added by a control transition appear in the live list but not in the saved baseline.
    if (unrestrictedActiveTools != null) {
      unrestrictedActiveTools = mergeNewlyActiveTools(unrestrictedActiveTools, current);
    }
    const visible = names => names.filter(name => !satisfied.has(name));

    if (preComplexityRequired || productiveActionRequired) {
      if (unrestrictedActiveTools == null) unrestrictedActiveTools = current;
      const restricted = preComplexityRequired
        ? unrestrictedActiveTools.filter(name =>
            new Set([
              ...(config.preComplexityTransitionTools ?? []),
              'submit_result',
              'submit_repair',
            ]).has(name)
          )
        : largeMutationBudgetActive
          // UX on top of the controller's own hard gate: while the elevated budget is active,
          // don't even show tools this turn is not allowed to call.
          ? unrestrictedActiveTools.filter(name => FINISH_TOOLS.has(name))
          : actionRequiredToolNames(unrestrictedActiveTools, {
            actionTools: config.productiveProgress.actionTools,
            controlTools: config.productiveProgress.controlTools,
            blockerTool: config.productiveProgress.blockerTool,
            verificationTools: controller.verificationPermitted()
              ? [config.productiveProgress.verificationTool].filter(Boolean)
              : [],
          });
      setSurface(visible(restricted), 'restricted');
      return;
    }

    if (unrestrictedActiveTools != null) {
      setSurface(visible(unrestrictedActiveTools), 'restored');
      unrestrictedActiveTools = null;
      return;
    }
    const remaining = visible(current);
    if (remaining.length !== current.length) setSurface(remaining, 'transition_complete');
  }

  // Materialize a newly completed one-shot transition into durable runtime state, the active
  // tool surface, and the next model request (a steering message the model sees in history).
  async function announceTransition(record, productiveState) {
    console.log(`PI_STATE_TRANSITION_COMPLETE ${JSON.stringify({ stage, ...record })}`);
    syncActionToolSurface(productiveState);
    const block = controller.transitions.stateBlock();
    console.log(`PI_SESSION_STATE ${JSON.stringify({ stage, completed: [...controller.transitions.completed.keys()], block })}`);
    await pi.sendUserMessage(
      `${controller.transitions.transitionNotice(record)}\n\n${block}`,
      { deliverAs: 'steer' },
    );
  }

  function recordRuntimeAbort(failureCode, reason, details = {}) {
    const record = {
      ...details,
      schema_version: 1,
      stage,
      failure_class: 'model_execution_abort',
      failure_code: failureCode,
      reason,
    };
    // A coding-session fork is recoverable by its parent Implementer. Keep its abort in logs,
    // but never let a nested fork leave job-level failure provenance behind.
    if (codingSession) {
      console.error(`PI_RUNTIME_FAILURE_NESTED ${JSON.stringify(record)}`);
      return;
    }
    const failureFile = String(process.env.PI_RUNTIME_FAILURE_FILE ?? '').trim();
    if (!failureFile) return;
    try {
      fs.mkdirSync(path.dirname(failureFile), { recursive: true });
      const tempFile = `${failureFile}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tempFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tempFile, failureFile);
      console.error(`PI_RUNTIME_FAILURE ${JSON.stringify(record)}`);
    } catch (error) {
      // Failure classification is best-effort metadata; it must never suppress the watchdog abort.
      console.error(`PI_RUNTIME_FAILURE_WRITE_ERROR ${JSON.stringify({ stage, failureCode, error: String(error?.message ?? error) })}`);
    }
  }

  async function handleLoopResult(loopResult, ctx) {
    if (!loopResult?.tripped) return;
    const metric = {
      stage: loopResult.stage,
      tool: loopResult.tool,
      reason: loopResult.reason,
      fingerprintClass: loopResult.fingerprintClass,
      repositoryState: loopResult.repositoryState,
      revisitCount: loopResult.revisitCount,
      window: loopResult.window,
      classification: loopResult.classification,
      noOp: loopResult.noOp,
      repeatedObservation: loopResult.repeatedObservation,
      repeatedFailure: loopResult.repeatedFailure,
      returnedToSeenState: loopResult.returnedToSeenState,
      action: loopResult.action,
    };
    console.log('PI_LOOP_GUARD ' + JSON.stringify(metric));
    if (loopResult.action === 'steer') {
      loopGuardSteeredThisTurn = true;
      console.warn('PI_LOOP_GUARD_STEER ' + JSON.stringify(metric));
      await pi.sendUserMessage(
        'RUNTIME LOOP GUARD: the current strategy is cycling through previously seen evidence or repository state. Do not repeat or cosmetically vary the same approach. Choose a genuinely different action that can create new evidence/state, or submit/stop if the task is already complete or blocked.',
        { deliverAs: 'steer' },
      );
    } else {
      console.error('PI_LOOP_GUARD_ABORT ' + JSON.stringify(metric));
      ctx.abort();
    }
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

  function truncationGuidance(toolName) {
    return truncatedToolCallGuidance(toolName, {
      largeMutationBudgetTool: controller.largeMutationBudgetTool,
      codingSessionTool: config.productiveProgress?.codingSessionTool ?? null,
    });
  }

  syncProductiveState();

  // The run_check sandbox is a hard dependency of stages that expose it. Prove it works before any
  // agent turn is spent, and fail the stage as an infrastructure error rather than let the agent
  // discover a broken runner mid-task and go looking for an unrestricted shell.
  async function preflightRunCheckSandbox() {
    const result = await sandboxPreflight();
    const record = result.ok
      ? { ...result, stage, ok: true }
      : { stage, ok: false, summary: result.summary, infrastructure: result.infrastructure, stderr_tail: result.stderr_tail };
    console[result.ok ? 'info' : 'error'](`PI_RUN_CHECK_PREFLIGHT ${JSON.stringify(record)}`);
    if (!result.ok) throw new Error(`run_check sandbox preflight failed: ${result.summary}`);
  }

  // Provider-request patches are deliberately narrow:
  // - coding sessions keep thinking disabled on every request;
  // - after the first prose-only Implementer action_required violation, requests keep
  //   tool_choice="required" until the model actually attempts one exposed tool. Pi has already
  //   restricted payload.tools to the valid action surface, so the model still chooses direct
  //   mutation vs coding session vs submit/escape hatch.
  let codingReadyAt = null;
  let codingFirstToolLogged = false;
  let codingFirstResponseLogged = false;
  if (stage === 'implementer') {
    let patchedThinkingRequests = 0;
    pi.on('before_provider_request', (event) => {
      forcedProviderRequestInFlight = false;
      let patched = codingSession ? disableThinkingInPayload(event.payload) : event.payload;
      if (codingSession && patched !== event.payload && ++patchedThinkingRequests === 1) {
        codingSessionLog('thinking_disabled', {
          side: 'fork',
          sessionId: codingSession.sessionId,
          enableThinking: patched.chat_template_kwargs.enable_thinking,
          maxTokens: patched.max_completion_tokens ?? patched.max_tokens ?? null,
        });
      }
      if (requireToolOnNextProviderRequest) {
        const productiveState = controller.productiveProgressState();
        if (productiveState !== 'action_required') {
          requireToolOnNextProviderRequest = false;
          console.warn(`PI_ACTION_REQUIRED_TOOL_CHOICE_CLEARED ${JSON.stringify({ stage, reason: 'state_changed', productiveState })}`);
        } else {
          const constrained = requireToolChoiceInPayload(patched);
          if (constrained !== patched) {
            forcedProviderRequestInFlight = true;
            console.warn(`PI_ACTION_REQUIRED_TOOL_CHOICE ${JSON.stringify({ stage, mode: 'required', activeTools: pi.getActiveTools() })}`);
            patched = constrained;
          }
        }
      }
      return patched;
    });
    pi.on('after_provider_response', (event) => {
      const status = Number(event?.status ?? 0);
      const wasForced = forcedProviderRequestInFlight;
      forcedProviderRequestInFlight = false;
      // Clear only on non-retryable compatibility/request-shape failures. Transient 408/429
      // responses must preserve the requirement so the transport retry is still forced.
      if (
        requireToolOnNextProviderRequest &&
        wasForced &&
        [400, 404, 422].includes(status)
      ) {
        requireToolOnNextProviderRequest = false;
        console.warn(`PI_ACTION_REQUIRED_TOOL_CHOICE_CLEARED ${JSON.stringify({ stage, reason: 'provider_incompatible_status', status })}`);
      }
    });
  }

  // Registers the trusted coding-session agent with pi-subagents (synchronous event contract).
  let codingSessionAgent = null;
  function ensureCodingSessionAgent() {
    if (codingSessionAgent?.ok) return codingSessionAgent;
    const definition = codingSessionAgentDefinition(config.productiveProgress.codingSessionTools ?? []);
    const request = { version: 1, name: config.productiveProgress.codingSessionAgent, definition };
    pi.events?.emit?.(RUNTIME_AGENT_REGISTER_EVENT, request);
    codingSessionAgent = request.result
      ? (request.result.ok ? { ok: true } : { ok: false, error: String(request.result.error?.message ?? request.result.error) })
      : { ok: false, error: 'pi-subagents did not handle runtime agent registration' };
    codingSessionLog(codingSessionAgent.ok ? 'agent_registered' : 'agent_unavailable', {
      agent: request.name, source: 'runtime', thinking: definition.thinking, tools: definition.tools, extensions: definition.extensions,
      ...(codingSessionAgent.ok ? {} : { error: codingSessionAgent.error }),
    });
    return codingSessionAgent;
  }

  pi.on('session_start', async (_event, ctx) => {
    // The sandbox preflight is the first hard gate: nothing else starts if it fails.
    if (config.productiveProgress?.verificationTool === 'run_check') await preflightRunCheckSandbox();
    if (stage === 'implementer' && config.productiveProgress?.codingSessionTool) ensureCodingSessionAgent();
    await applyBudget('short', ctx);
    syncActionToolSurface(syncProductiveState());
    if (codingSession) {
      const entries = ctx.sessionManager?.getEntries?.() ?? [];
      codingReadyAt = Date.now();
      codingSessionLog('session_ready', {
        side: 'fork',
        sessionId: codingSession.sessionId,
        maxTokens: Number(ctx.model?.maxTokens) || null,
        thinkingLevel: pi.getThinkingLevel?.() ?? null,
        activeTools: pi.getActiveTools(),
        inheritedEntries: entries.length,
        inheritedToolResults: entries.filter(entry => entry?.message?.role === 'toolResult').length,
        forkedFromParent: Boolean(ctx.sessionManager?.getHeader?.()?.parentSession),
      });
    }
  });

  if (controller.requireComplexity && config.implementationPlannerAgent) {
    pi.registerTool({
      name: 'prepare_implementation',
      label: 'Prepare implementation',
      description: 'Run the runtime-owned implementation planner once. It returns the plan and a trivial/nontrivial classification in one structured result, or PREPARATION_FALLBACK if planner infrastructure fails; do not write a competing plan in the main agent.',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        let prepared;
        try {
          prepared = await runStructuredImplementationPlanner(pi, ctx, config, signal);
        } catch (error) {
          // Cancellation is not a recovery request: never unlock execution on abort.
          if (signal?.aborted) throw error;
          const fallback = controller.enterPreparationFallback();
          const reason = String(error?.message ?? error);
          console.warn(`PI_PREPARATION_FALLBACK ${JSON.stringify({
            stage,
            ...fallback,
            source: config.implementationPlannerAgent,
            failureClass: 'preparation_infrastructure_failure',
            recovery: 'continue_without_planner_output',
            reason,
          })}`);
          syncActionToolSurface(syncProductiveState());
          return {
            content: [{ type: 'text', text:
              `PREPARATION_FALLBACK: implementation planner infrastructure failed: ${reason}\n` +
              'Your preparation obligation is satisfied. No planner output or complexity was recorded. ' +
              'Do not call prepare_implementation again. Continue implementing from the issue and loaded contract. ' +
              'Normal mutation, begin_coding_session for the coding phase, run_check after mutation, and submit_result rules apply. ' +
              'If one concrete fact is missing, use need_more_evidence to unlock a read/search before acting.\n' +
              `LSP workspace root: ${ctx.cwd}. Fresh worktree base: ${baseRef()}${freshBaseCommit ? ` at ${freshBaseCommit}` : ''}.`,
            }],
            details: { ...fallback, failureClass: 'preparation_infrastructure_failure', reason,
              lspWorkspaceRoot: ctx.cwd, freshBaseCommit },
          };
        }
        const result = controller.setComplexity(prepared.complexity);
        controller.setEvidenceBudget(prepared.evidenceBudget);
        console.log(`PI_PLAN ${JSON.stringify({
          stage,
          steps: prepared.steps,
          complexity: prepared.complexity,
          evidenceBudget: prepared.evidenceBudget,
          reason: prepared.reason,
          usage: prepared.usage,
        })}`);
        console.log(`PI_COMPLEXITY ${JSON.stringify({
          stage,
          complexity: prepared.complexity,
          evidenceBudget: prepared.evidenceBudget,
          reason: prepared.reason,
          usage: prepared.usage,
          source: 'implementation-planner',
        })}`);
        const numberedPlan = prepared.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
        const provenance = stage === 'implementer' && !resumedImplementer
          ? `\n\nFresh worktree provenance: runtime created this worktree directly from latest fetched ${baseRef()}${freshBaseCommit ? ` at ${freshBaseCommit}` : ''}, and no saved issue work was applied. Until the first successful structural_edit/safe_edit/edit/write, direct reads of this worktree are authoritative latest-base evidence; do not use extra Git/evidence calls to re-prove that provenance.`
          : '';
        const lspWorkspace = stage === 'implementer' && !resumedImplementer
          ? `\n\nLSP workspace root: ${ctx.cwd}. For a cold name-only lookup with an explicit language, call lsp_start_server once with the matching server_id and this exact absolute workspace_root before lsp_find_symbol; lsp_start_server is a control action and does not consume evidence budget.`
          : '';
        return {
          content: [{
            type: 'text',
            text: `Implementation plan:\n${numberedPlan}\n\nComplexity: ${result.complexity} — ${prepared.reason}\nEvidence budget: ${prepared.evidenceBudget}\nPreparation complete. Continue according to the loaded Implementer contract.${provenance}${lspWorkspace}`,
          }],
          details: {
            ...result,
            plan: prepared.steps,
            evidenceBudget: prepared.evidenceBudget,
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
      description: 'Use only when one concrete missing fact prevents the next productive action. This unlocks exactly one evidence-gathering tool call; after that call runtime returns to action-required state.',
      parameters: Type.Object({
        missing: Type.String({ minLength: 1, maxLength: 300 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_toolCallId, params) {
        return {
          content: [{
            type: 'text',
            text: `One evidence action unlocked for: ${params.missing}. After that evidence call, runtime returns to action-required state.`,
          }],
          details: params,
        };
      },
    });
  }

  const pendingMutationSnapshots = new Map();
  // Truncated calls already guided, whichever of tool_result / tool_execution_end fired first.
  const truncationGuidedCalls = new Set();
  const pendingLoopCalls = new Map();
  const pendingToolInputs = new Map();
  let lastSuccessfulMutationSnapshot = null;

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
      description: 'Deterministic current-worktree mutation by 1-based line/range. Prefer it for bounded insert/replace changes when reproducing multiline oldText would be brittle. It re-reads the file immediately before writing, validates an optional expected marker, preserves newline style/final-newline state, writes atomically, returns a bounded post-edit preview of what landed on disk, and participates in normal rollback/progress handling. A result with changed=false means no edit occurred. Do not re-read merely to verify a successful change.',
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
          content: [{
            type: 'text',
            text: result.changed
              ? JSON.stringify(result)
              : `NO CHANGE: replacement is identical to the existing content. ${JSON.stringify(result)}`,
          }],
          details: result,
        };
      },
    });

    pi.registerTool({
      name: 'run_check',
      label: 'Run focused check',
      description: 'Focused local verification without shell access. kind=python_compile|ruff take paths (files/dirs in the worktree); kind=pytest takes targets (test files or node ids); kind=profile takes profile=node_tests|pytest_all. Returns {status: pass|fail|timeout|invalid|infra_error, summary, diagnostics[{file,line,column,code,message}], stdout_tail, stderr_tail}. A failing check is evidence, not task failure: fix the reported diagnostic with an edit, then re-check. status=infra_error means the runner could not run the check (sandbox or tool missing): it says nothing about your change, so do not retry, do not look for a shell workaround, and report it as an infrastructure blocker. Available once after each successful mutation. Passing does not replace final validation; still call submit_result.',
      parameters: Type.Object({
        kind: Type.Union(CHECK_KINDS.map(kind => Type.Literal(kind))),
        paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 })),
        targets: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 })),
        profile: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = await runCheck(ctx.cwd, params);
        console.info(`PI_RUN_CHECK ${JSON.stringify(checkMetricRecord(result, { backend: 'pi', stage }))}`);
        appendCheckRecord(process.env.PI_VALIDATION_LEDGER_FILE, {
          kind: result.kind,
          scope: normalizeScope(params, ctx.cwd),
          status: result.status,
          exit_code: result.exit_code,
          source: 'run_check',
          stage,
          backend: 'pi',
          run_id: `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}`,
          diagnostics_count: result.diagnostics.length,
          summary: result.summary,
          infrastructure: result.infrastructure ?? null,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });

    pi.registerTool({
      name: 'rollback_last_mutation',
      label: 'Rollback last mutation',
      description: 'Restore exactly the file state captured immediately before the most recent successful structural_edit/safe_edit/edit/write. Use when that mutation caused a regression or was the wrong approach. This is a productive recovery action and does not reset unrelated earlier changes.',
      parameters: Type.Object({
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_toolCallId, params) {
        const snapshot = lastSuccessfulMutationSnapshot;
        if (!snapshot) throw new Error('No successful structural_edit/safe_edit/edit/write is available to roll back');
        if (snapshot.existed) {
          fs.mkdirSync(path.dirname(snapshot.absolutePath), { recursive: true });
          fs.writeFileSync(snapshot.absolutePath, snapshot.content);
          if (snapshot.mode != null) fs.chmodSync(snapshot.absolutePath, snapshot.mode);
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

    if (controller.largeMutationBudgetTool) {
      pi.registerTool({
        name: controller.largeMutationBudgetTool,
        label: 'Request large mutation budget',
        description: `LEGACY: prefer begin_coding_session. Grant exactly the NEXT response a ${controller.largeMutationBudgetMaxTokens}-token completion ceiling, for one large write/edit/safe_edit/structural_edit payload that would not fit in the normal small action budget. Do not call this for extra reasoning/planning room. That one elevated response must attempt structural_edit, safe_edit, edit, write, rollback_last_mutation, or submit_result; the budget always collapses back to the normal small ceiling immediately afterward, whether or not it was used, and must be requested again for another large payload.`,
        parameters: Type.Object({
          reason: Type.String({ minLength: 1, maxLength: 300, description: 'One short sentence on why the next mutation needs the larger budget' }),
        }),
        async execute(_toolCallId, params) {
          return {
            content: [{
              type: 'text',
              text: `Large mutation budget granted for exactly the next response (${controller.largeMutationBudgetMaxTokens} max output tokens). Use it now for one structural_edit/safe_edit/edit/write/rollback_last_mutation/submit_result call; do not spend it on narration or another request.`,
            }],
            details: { reason: params.reason, maxTokens: controller.largeMutationBudgetMaxTokens },
          };
        },
      });
    }

    const codingSessionTool = config.productiveProgress?.codingSessionTool;
    if (codingSessionTool && config.productiveProgress?.codingSessionAgent) {
      const sessionConfig = config.productiveProgress;
      const maxSessions = Number(sessionConfig.codingSessionMaxSessions ?? 2);
      let sessionsStarted = 0;
      pi.registerTool({
        name: codingSessionTool,
        label: 'Begin coding session',
        description: `Call once exploration is done and you know what to implement, in particular when the code will not fit your normal ${sessionConfig.actionResponseMaxTokens}-token response. The runtime continues THIS session (same conversation, evidence and decisions) as a coding session with a ${sessionConfig.codingSessionMaxTokens}-token response ceiling and your normal coding tools (write/edit/safe_edit/structural_edit, rollback, run_check, repo_search, need_more_evidence, submit_result) under the same runtime rules. Write the code and tests there, run checks, fix, and submit_result. Call it as soon as you are ready; do NOT draft the code here first. Small changes can stay direct.`,
        parameters: Type.Object({
          reason: Type.Optional(Type.String({ maxLength: 300, description: 'Optional one-line note for logs' })),
        }),
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
          const sessionId = randomUUID();
          const base = { sessionId, session: sessionsStarted + 1, side: 'parent' };
          codingSessionLog('requested', {
            ...base,
            parentRunId: ctx.sessionManager?.getSessionId?.() ?? null,
            parentMaxTokens: Number(ctx.model?.maxTokens) || null,
            codingMaxTokens: sessionConfig.codingSessionMaxTokens,
            preparationState: controller.preparationState,
            reason: params?.reason ?? null,
          });
          const refuse = (reason, message) => {
            codingSessionLog('rejected', { ...base, reason });
            const error = new Error(message);
            error.code = reason;
            throw error;
          };
          if (sessionsStarted >= maxSessions) {
            refuse('max_sessions', `The coding session limit (${maxSessions}) for this run is reached. Finish with direct edits or submit_result.`);
          }
          // The fork inherits the persisted parent transcript. Without one there is no
          // same-context session to run, and a fresh prompt is not an acceptable stand-in.
          const parentSessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
          if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
            refuse('fork_unavailable', 'This session is not persisted, so it cannot continue as a coding session. Implement with direct edits.');
          }
          const agentReady = ensureCodingSessionAgent();
          if (!agentReady.ok) {
            refuse('agent_unavailable', `The trusted coding-session agent is not registered (${agentReady.error}). Implement with direct edits.`);
          }
          sessionsStarted += 1;
          const terminalFile = process.env.PI_TERMINAL_RESULT_FILE || null;
          const startedAt = Date.now();
          codingSessionLog('started', { ...base, context: 'fork', agent: sessionConfig.codingSessionAgent, codingMaxTokens: sessionConfig.codingSessionMaxTokens });
          let response = null;
          let sessionError = null;
          try {
            response = await runStructuredSubagent(pi, ctx, {
              agent: sessionConfig.codingSessionAgent,
              nodeId: `coding-session-${toolCallId}`,
              task: 'Coding phase: continue this Implementer session and finish the issue. Implement the code (and tests where the task needs them), run_check, fix what fails, and call submit_result when the work is complete. Write code directly in tool arguments.',
              timeoutMs: Number(sessionConfig.codingSessionTimeoutMs ?? 5400000),
              maxTokens: sessionConfig.codingSessionMaxTokens,
              // No tool budget: the runtime inside the fork applies the normal progress/loop rules.
              toolBudget: null,
              thinking: 'off',
              context: 'fork',
              childEnv: { PI_CODING_SESSION: JSON.stringify({ sessionId, maxTokens: sessionConfig.codingSessionMaxTokens }) },
            }, signal);
          } catch (error) {
            sessionError = error;
          }
          if (signal?.aborted) {
            codingSessionLog('cancelled', { ...base, durationMs: Date.now() - startedAt });
            throw sessionError ?? new Error('coding session was cancelled');
          }
          const submitted = Boolean(terminalFile && fs.existsSync(terminalFile) && fs.statSync(terminalFile).size > 0);
          codingSessionLog(submitted ? 'completed' : 'ended_without_submit', {
            ...base,
            durationMs: Date.now() - startedAt,
            usage: response?.usage ?? null,
            submitted,
            status: sessionError ? 'error' : 'ok',
            ...(sessionError ? { error: String(sessionError?.message ?? sessionError) } : {}),
          });
          if (submitted) {
            return {
              content: [{ type: 'text', text: 'Coding session completed the implementation and submitted the result. The work is done: stop now.' }],
              details: { ...base, submitted: true },
              // The fork already called submit_result; end this session without another turn.
              terminate: true,
            };
          }
          const remaining = maxSessions - sessionsStarted;
          const message = `Coding session ended without submit_result${sessionError ? ` (${String(sessionError?.message ?? sessionError)})` : ''}. Its repository changes, if any, are in the worktree. ${remaining > 0 ? `You may call ${codingSessionTool} once more (${remaining} left), ` : ''}finish with direct edits/run_check, or submit_result.`;
          if (sessionError) throw new Error(message);
          return { content: [{ type: 'text', text: message }], details: { ...base, submitted: false } };
        },
      });
    }

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
    elevatedTurnAttemptedFinishTool = false;
    loopGuardSteeredThisTurn = false;
    controller.onTurnStart(event.turnIndex);
    const productiveState = syncProductiveState();
    syncActionToolSurface(productiveState);
    console.log(`PI_BUDGET ${JSON.stringify({
      turn: event.turnIndex,
      stage,
      budget: controller.fixedMaxTokens ? 'fixed' : controller.turnLevel,
      maxTokens: appliedActionCap || controller.fixedMaxTokens || controller.budgets[controller.turnLevel],
      productiveState,
      actionCapApplied: appliedActionCap > 0,
      largeMutationBudget: controller.largeMutationBudgetState,
    })}`);
  });

  pi.on('tool_call', async (event, ctx) => {
    if (codingSession && !codingFirstToolLogged) {
      codingFirstToolLogged = true;
      codingSessionLog('first_tool_call', { side: 'fork', sessionId: codingSession.sessionId, tool: event.toolName, msSinceReady: codingReadyAt ? Date.now() - codingReadyAt : null });
    }
    const productiveState = controller.productiveProgressState();
    const blocked = controller.checkToolCall(event.toolName, event.input);
    // Any provider-emitted tool call satisfies the transport-level forcing requirement, even if
    // the controller later classifies it as already completed. Progress accounting remains stricter:
    // an already-satisfied transition still does not reset prose/ceiling watchdogs.
    if (requireToolOnNextProviderRequest) {
      requireToolOnNextProviderRequest = false;
      console.warn(`PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED ${JSON.stringify({ stage, tool: event.toolName, alreadySatisfied: blocked?.alreadySatisfied === true })}`);
    }
    if (!blocked?.alreadySatisfied) {
      actionTurnAttemptedTool = true;
    }
    if (blocked) {
      if (blocked.alreadySatisfied) {
        console.warn(`PI_ALREADY_SATISFIED ${JSON.stringify({ stage, ...controller.lastAlreadySatisfied, suppressed: true, productive: false })}`);
      }
      if (loopGuard) {
        const loopResult = loopGuard.observe({
          stage,
          tool: event.toolName,
          input: event.input ?? {},
          result: blocked,
          blocked: true,
          productiveState,
        });
        // A blocked tool has no tool_execution_end event, so classify it here.
        await handleLoopResult(loopResult, ctx).catch(error => {
          console.error('PI_LOOP_GUARD_HANDLER_ERROR ' + String(error?.message ?? error));
        });
      }
      return blocked;
    }
    // Only a call the controller actually let through counts as an attempted finish tool: a
    // blocked call never reached execution, so it must not suppress the violation warning.
    if (FINISH_TOOLS.has(event.toolName)) elevatedTurnAttemptedFinishTool = true;

    const cwd = ctx?.cwd || process.cwd();

    // `write` always overwrites unconditionally, unlike `edit` (which already refuses a
    // same-content replacement before touching disk) and `safe_edit` (which compares bytes
    // itself). Prove byte equality here and skip the real tool entirely so an identical write
    // never bumps mtime or resets rollback/progress state. Reuses the same blocked-call path
    // as checkToolCall above, so repeated no-op writes still accumulate toward loop/stall
    // detection without counting as productive progress.
    if (stage === 'implementer' && event.toolName === 'write' && detectNoOpWrite(cwd, event.input)) {
      const noOpBlocked = {
        block: true,
        reason: `NO CHANGE: write content for ${event.input?.path} is already identical to the existing file; no write performed.`,
      };
      if (loopGuard) {
        const loopResult = loopGuard.observe({
          stage,
          tool: event.toolName,
          input: event.input ?? {},
          result: noOpBlocked,
          blocked: true,
          productiveState,
        });
        await handleLoopResult(loopResult, ctx).catch(error => {
          console.error('PI_LOOP_GUARD_HANDLER_ERROR ' + String(error?.message ?? error));
        });
      }
      return noOpBlocked;
    }

    // Trusted containment for every file mutation, direct or inside the coding session:
    // the target must physically be inside the worktree (no escape, no .git, no symlinks).
    if (stage === 'implementer' && CONTENT_MUTATION_TOOLS.has(event.toolName)) {
      try {
        resolveMutationTarget(cwd, event.input?.path);
      } catch (error) {
        if (!(error instanceof MutationTargetRejected)) throw error;
        const containmentBlocked = { block: true, reason: `BLOCKED: ${event.toolName} did not execute. ${error.message}` };
        console.warn(`PI_MUTATION_BLOCKED ${JSON.stringify({ stage, tool: event.toolName, reason: error.code, path: event.input?.path ?? null })}`);
        return containmentBlocked;
      }
    }

    const semanticMutation = loopGuard && isSemanticMutationTool(event.toolName);
    const repositoryStateBefore = semanticMutation
      ? repositoryStateFingerprint(cwd)
      : null;

    if (stage === 'implementer' && CONTENT_MUTATION_TOOLS.has(event.toolName)) {
      try {
        pendingMutationSnapshots.set(
          event.toolCallId,
          captureMutationSnapshot(cwd, event.input?.path),
        );
      } catch (error) {
        console.warn('PI_MUTATION_SNAPSHOT_UNAVAILABLE ' + JSON.stringify({
          tool: event.toolName,
          reason: String(error?.message ?? error),
        }));
      }
    }
    pendingToolInputs.set(event.toolCallId, structuredClone(event.input ?? {}));
    if (loopGuard) {
      pendingLoopCalls.set(event.toolCallId, {
        cwd,
        input: structuredClone(event.input ?? {}),
        productiveState,
        repositoryStateBefore,
      });
    }
    return undefined;
  });
  pi.on('tool_execution_end', async (event, ctx) => {
    // pi rejects a call whose arguments were cut off at the output ceiling before execution and
    // may not route that rejection through tool_result; steer from here so the truncation
    // guidance (begin the coding session instead of regenerating) still reaches the model once.
    const truncatedText = resultText(event.result);
    const truncated = classifyTruncatedToolCall({ toolName: event.toolName, isError: event.isError, text: truncatedText });
    if (truncated && !truncationGuidedCalls.has(event.toolCallId)) {
      truncationGuidedCalls.add(event.toolCallId);
      console.log(`PI_TOOL_CALL_TRUNCATED ${JSON.stringify({ stage, ...truncated, source: 'tool_execution_end' })}`);
      await pi.sendUserMessage(`RUNTIME: ${truncationGuidance(event.toolName)}`, { deliverAs: 'steer' });
    }
    const pendingLoopCall = pendingLoopCalls.get(event.toolCallId) ?? null;
    const contentMutation =
      stage === 'implementer' &&
      CONTENT_MUTATION_TOOLS.has(event.toolName);
    const mutationSnapshot = contentMutation
      ? (pendingMutationSnapshots.get(event.toolCallId) ?? null)
      : null;

    let mutationChanged = null;
    if (contentMutation && pendingLoopCall && mutationSnapshot) {
      try {
        const afterSnapshot = captureMutationSnapshot(
          pendingLoopCall.cwd,
          mutationSnapshot.path,
        );
        mutationChanged = mutationSnapshotChanged(mutationSnapshot, afterSnapshot);
      } catch (error) {
        console.warn('PI_MUTATION_SNAPSHOT_UNAVAILABLE ' + JSON.stringify({
          tool: event.toolName,
          reason: String(error?.message ?? error),
        }));
      }
    }

    let repositoryStateAfter = null;
    if (loopGuard && pendingLoopCall && isSemanticMutationTool(event.toolName)) {
      repositoryStateAfter = repositoryStateFingerprint(pendingLoopCall.cwd);
      // Compare fingerprints only when both are known. A failed fingerprint
      // (null) means "unknown", not "unchanged": keep mutationChanged null so
      // progress accounting is not downgraded to a no-op.
      if (
        mutationChanged == null &&
        pendingLoopCall.repositoryStateBefore &&
        repositoryStateAfter
      ) {
        mutationChanged = pendingLoopCall.repositoryStateBefore !== repositoryStateAfter;
      }
    }

    if (contentMutation) {
      console.log(`PI_MUTATION ${JSON.stringify({
        stage,
        tool: event.toolName,
        mode: codingSession ? 'coding_session' : 'direct',
        path: mutationSnapshot?.path ?? null,
        isError: event.isError === true,
        changed: mutationChanged,
      })}`);
      if (!event.isError && mutationChanged === true && mutationSnapshot) {
        lastSuccessfulMutationSnapshot = mutationSnapshot;
      }
      pendingMutationSnapshots.delete(event.toolCallId);
    }

    const effectiveProgress = !event.isError && (mutationChanged == null || mutationChanged);
    controller.onToolExecutionEnd(event.toolName, event.isError, { madeProgress: effectiveProgress });
    const transitionRecord = controller.recordTransitionCompleted(event.toolName, pendingToolInputs.get(event.toolCallId) ?? {}, event.isError);
    pendingToolInputs.delete(event.toolCallId);
    const productiveState = syncProductiveState();
    syncActionToolSurface(productiveState);
    if (transitionRecord) await announceTransition(transitionRecord, productiveState);

    if (loopGuard && pendingLoopCall) {
      const loopResult = loopGuard.observe({
        stage,
        tool: event.toolName,
        input: pendingLoopCall.input,
        result: event.result,
        isError: event.isError,
        productiveState: pendingLoopCall.productiveState,
        repositoryStateBefore: pendingLoopCall.repositoryStateBefore,
        repositoryStateAfter,
        mutationChanged,
      });
      pendingLoopCalls.delete(event.toolCallId);

      await handleLoopResult(loopResult, ctx);
    }
  });

  pi.on('tool_result', (event) => {
    const text = resultText(event);
    const truncated = classifyTruncatedToolCall({ toolName: event.toolName, isError: event.isError, text });
    if (!truncated) return undefined;
    if (event.toolCallId) {
      if (truncationGuidedCalls.has(event.toolCallId)) return undefined;
      truncationGuidedCalls.add(event.toolCallId);
    }
    console.log(`PI_TOOL_CALL_TRUNCATED ${JSON.stringify({ stage, ...truncated, source: 'tool_result' })}`);
    const guidance = truncationGuidance(event.toolName);
    return {
      content: [{ type: 'text', text: `${guidance}\n\n${text}` }],
      isError: true,
    };
  });

  pi.on('turn_end', async (event, ctx) => {
    const outputTokens = Number(event.message?.usage?.output || 0);
    if (codingSession && !codingFirstResponseLogged) {
      codingFirstResponseLogged = true;
      codingSessionLog('first_response', { side: 'fork', sessionId: codingSession.sessionId, outputTokens, attemptedTool: actionTurnAttemptedTool });
    }
    const activeResponseCap =
      appliedActionCap || controller.fixedMaxTokens || controller.budgets[controller.turnLevel];
    const responseHitOutputCeiling =
      activeResponseCap > 0 && outputTokens >= activeResponseCap;
    const next = controller.afterTurn(outputTokens);
    const productiveState = syncProductiveState();
    syncActionToolSurface(productiveState);

    // The turn that just ended was the one-shot elevated mutation response (if any): consume
    // it unconditionally so a second elevated response is never granted automatically, and
    // flag it when it did not even attempt the mutation/terminal action it was granted for.
    if (stage === 'implementer' && controller.largeMutationBudgetActive()) {
      console.log(`PI_LARGE_MUTATION_BUDGET ${JSON.stringify({
        stage,
        phase: 'consumed',
        attemptedFinishTool: elevatedTurnAttemptedFinishTool,
        outputTokens,
      })}`);
      if (!elevatedTurnAttemptedFinishTool) {
        console.warn('PI_LARGE_MUTATION_BUDGET_VIOLATION: elevated mutation response attempted no structural_edit/safe_edit/edit/write/rollback_last_mutation/submit_result; collapsing to the normal budget');
      }
      controller.resetLargeMutationBudget();
      syncActionToolSurface(productiveState);
    }

    const preComplexityRequired =
      config.preComplexityActionResponseMaxTokens != null &&
      controller.preComplexityActionRequired();
    const postComplexityRequired =
      config.postComplexityActionResponseMaxTokens != null &&
      controller.complexityRecorded();
    const productiveActionRequired = productiveState === 'action_required';
    const runtimeActionRequired =
      preComplexityRequired || postComplexityRequired || productiveActionRequired;
    const actionCap = Number(
      preComplexityRequired
        ? (config.preComplexityActionResponseMaxTokens ?? 0)
        : postComplexityRequired
          ? (config.postComplexityActionResponseMaxTokens ?? 0)
          : (config.productiveProgress?.actionResponseMaxTokens ?? 0)
    );
    const actionRetryCap = Number(
      preComplexityRequired
        ? (config.preComplexityActionResponseRetryMaxTokens ?? actionCap)
        : postComplexityRequired
          ? (config.postComplexityActionResponseRetryMaxTokens ?? actionCap)
          : (config.productiveProgress?.actionResponseRetryMaxTokens ?? actionCap)
    );
    actionRequiredProseOnlyTurns = nextActionRequiredProseOnlyTurns(
      actionRequiredProseOnlyTurns,
      {
        actionRequired: runtimeActionRequired,
        attemptedTool: actionTurnAttemptedTool,
        madeProgress: controller.turnMadeProgress,
        responseHitOutputCeiling,
      },
    );

    if (actionRequiredProseOnlyTurns >= 2) {
      recordRuntimeAbort(
        'PI_ACTION_REQUIRED_ABORT',
        'second consecutive prose-only action-required turn; aborting stage',
        { actionRequiredProseOnlyTurns, ceilingWithoutToolTurns },
      );
      console.error('PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn; aborting stage');
      ctx.abort();
      return;
    }

    // The first genuine prose-only violation in the productive Implementer state gets one
    // provider-level retry constraint. Output-ceiling turns are handled by their independent
    // watchdog and are intentionally not converted into prose strikes.
    if (
      stage === 'implementer' &&
      productiveActionRequired &&
      actionRequiredProseOnlyTurns === 1 &&
      !responseHitOutputCeiling &&
      !actionTurnAttemptedTool &&
      !controller.turnMadeProgress
    ) {
      requireToolOnNextProviderRequest = true;
      console.warn('PI_ACTION_REQUIRED_TOOL_CHOICE_ARMED: next provider request requires one exposed tool call');
    }

    ceilingWithoutToolTurns = nextCeilingWithoutToolTurns(ceilingWithoutToolTurns, {
      actionRequired: runtimeActionRequired,
      attemptedTool: actionTurnAttemptedTool,
      madeProgress: controller.turnMadeProgress,
      responseHitOutputCeiling,
    });
    if (ceilingWithoutToolTurns >= MAX_CEILING_WITHOUT_TOOL_TURNS) {
      const reason = `${ceilingWithoutToolTurns} consecutive action-required responses hit the output ceiling without a tool call; aborting stage`;
      recordRuntimeAbort(
        'PI_ACTION_REQUIRED_ABORT',
        reason,
        { actionRequiredProseOnlyTurns, ceilingWithoutToolTurns },
      );
      console.error(`PI_ACTION_REQUIRED_ABORT: ${reason}`);
      ctx.abort();
      return;
    }

    let targetActionCap = actionCap > 0
      ? nextActionResponseCap({
          baseCap: actionCap,
          retryCap: actionRetryCap,
          actionRequired: runtimeActionRequired,
          attemptedTool: actionTurnAttemptedTool,
          madeProgress: controller.turnMadeProgress,
        })
      : 0;
    let budgetReason = targetActionCap > 0 ? 'action_required' : 'level_ladder';

    // A grant just succeeded this turn: override whatever the normal action cap would be and
    // apply the elevated ceiling to exactly the upcoming response.
    const largeMutationBudgetGrantedThisTurn =
      stage === 'implementer' && controller.largeMutationBudgetPending();
    if (largeMutationBudgetGrantedThisTurn) {
      targetActionCap = controller.largeMutationBudgetMaxTokens;
      budgetReason = 'large_mutation_elevated';
      controller.activateLargeMutationBudget();
      console.log(`PI_LARGE_MUTATION_BUDGET ${JSON.stringify({ stage, phase: 'granted', maxTokens: targetActionCap })}`);
    }

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

    if (runtimeActionRequired && !controller.turnMadeProgress && !loopGuardSteeredThisTurn) {
      const codingSessionTool = config.productiveProgress?.codingSessionTool;
      const directive = stage === 'implementer' && ceilingWithoutToolTurns > 0
        // Code drafted in reasoning (or a cut-off call) ate the whole response: name it exactly.
        ? `RUNTIME: your last response used the entire ${actionCap || 'output'}-token ceiling without calling any tool. Do not draft, outline, or reason through file contents in this session; that output is discarded. In the next response call a tool immediately.${codingSessionTool ? ` If you are ready to implement and the code is large, call ${codingSessionTool} now; that coding session has your full context and a large output ceiling and writes the code itself.` : ''} If it is small, call the direct mutation tool now.`
        : preComplexityRequired
        ? 'RUNTIME CLASSIFICATION REQUIRED: startup evidence is complete. In the next response, do not narrate or reconsider the review plan. Call declare_task_complexity immediately with the classification already supported by the issue, diff, and changed code.'
        : postComplexityRequired
          ? 'RUNTIME REVIEW ACTION REQUIRED: complexity is already declared. Do not continue prose-only deliberation. If the current issue, diff, and changed code are sufficient, call submit_result now with PASS or CHANGES_REQUESTED. Otherwise call exactly one concrete evidence tool for the unresolved review question, then decide.'
          : stage === 'implementer'
            ? 'RUNTIME ACTION REQUIRED: evidence is complete. In the next response, do not narrate or restate the plan. Call structural_edit, safe_edit, edit, write, begin_coding_session (to implement in a large-output coding session), rollback_last_mutation, or submit_result immediately (run_check is also available once after a mutation). If authoritative current-code evidence proves explicit written requirements or constraints are mutually incompatible and no compliant mutation exists, call submit_result with blocked_reason now. If exactly one concrete fact still prevents a safe action, call need_more_evidence as the tool action.'
            : 'RUNTIME ACTION REQUIRED: classification evidence is complete. In the next response, do not narrate classifications. Call submit_result immediately with the complete structured result.';
      const reason = stage === 'implementer' && ceilingWithoutToolTurns > 0
        ? `ceiling without tool (${ceilingWithoutToolTurns}/${MAX_CEILING_WITHOUT_TOOL_TURNS})`
        : actionRequiredProseOnlyTurns > 0
          ? 'prose-only retry'
          : 'action-required transition';
      console.log(`PI_ACTION_REQUIRED_STEER: ${reason}; injecting user-level runtime directive`);
      await pi.sendUserMessage(directive, { deliverAs: 'steer' });
    }

    console.log(`PI_BUDGET_NEXT ${JSON.stringify({
      afterTurn: event.turnIndex,
      outputTokens,
      madeProgress: controller.turnMadeProgress,
      attemptedTool: actionTurnAttemptedTool,
      responseHitOutputCeiling,
      nextBudget: next.level,
      maxTokens: appliedActionCap || next.maxTokens,
      budgetReason,
      largeMutationBudget: controller.largeMutationBudgetState,
      explicit: next.explicit === true,
      preservedForToolTurn: next.preservedForToolTurn === true,
      productiveState,
      preComplexityActionRequired: preComplexityRequired,
      postComplexityActionRequired: postComplexityRequired,
      actionCapApplied: appliedActionCap > 0,
      actionCapEscalated: appliedActionCap > actionCap,
    })}`);
  });
}
