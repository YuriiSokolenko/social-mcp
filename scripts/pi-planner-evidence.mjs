import { plannerBudgetSupported, plannerModelLimit } from './pi-common/planner-request-budget.mjs';
import fs from 'node:fs';
import { repoSearch } from './pi-common/repo-search.mjs';
import { plannerOrbitContext } from './pi-common/planner-orbit.mjs';

// Loaded only inside the implementation-planner pi-subagents child via .pi/settings.json.
// Enforces the trusted read-only surface at tool-call time. Evidence action counts are
// observability only; semantic no-progress guards, not numeric budgets, stop accidental loops.
import {
  PLANNER_EVIDENCE_STATE_FILE_ENV,
  PLANNER_LIFECYCLE_ID_ENV,
  PLANNER_EVIDENCE_TOOLS,
  createPlannerEvidenceGate,
  plannerEvidenceFact,
} from './pi-common/implementation-planner.mjs';

const PLANNER_GRAPH_MAX_CHARS = 16000;
const EVIDENCE_NO_PROGRESS_STREAK_LIMIT = 4;

function graphFocusTerms(question) {
  const raw = String(question ?? '').toLowerCase();
  const terms = new Set(raw.match(/[a-z0-9_]{4,}/g) ?? []);
  const expansions = [
    [/call/, ['call', 'caller', 'callee']],
    [/refer|usage|use/, ['reference', 'refer', 'usage', 'use']],
    [/implement|definition/, ['implement', 'definition', 'override']],
    [/depend|import/, ['depend', 'dependency', 'import']],
    [/test|spec/, ['test', 'spec']],
  ];
  for (const [pattern, words] of expansions) {
    if (pattern.test(raw)) for (const word of words) terms.add(word);
  }
  return [...terms].slice(0, 16);
}

function focusedGraphText(text, question) {
  const value = String(text ?? '').trim();
  const terms = graphFocusTerms(question);
  if (!value || terms.length === 0) return value;
  const lines = value.split(/\r?\n/);
  const matched = lines.filter(line => {
    const lower = line.toLowerCase();
    return terms.some(term => lower.includes(term));
  });
  return matched.length > 0 ? matched.join('\n') : value;
}

function boundedGraphText(text) {
  const value = String(text ?? '').trim();
  if (value.length <= PLANNER_GRAPH_MAX_CHARS) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, PLANNER_GRAPH_MAX_CHARS)}\n[planner_code_graph output truncated]`,
    truncated: true,
  };
}

export async function plannerCodeGraph(cwd, params, { execFile: execFileFn, signal = null } = {}) {
  const target = String(params?.target ?? '').trim();
  const question = String(params?.question ?? '').trim();
  if (!target || target.length > 400 || target.startsWith('-') || /[\u0000-\u001f\u007f]/.test(target)) {
    throw new Error('planner_code_graph target must be one concrete symbol/path target (1-400 printable characters)');
  }
  if (!question || question.length > 400 || /[\u0000-\u001f\u007f]/.test(question)) {
    throw new Error('planner_code_graph question must be one concise planning question (1-400 printable characters)');
  }

  let graph;
  try {
    graph = await plannerOrbitContext(cwd, target, { execFile: execFileFn, signal });
  } catch (error) {
    const diagnostic = sanitizeDiagnosticText(error?.message ?? error, 240);
    console.log(`PI_PLANNER_CODE_GRAPH ${JSON.stringify({ status: 'unavailable', target, diagnostic })}`);
    throw error;
  }
  const focused = focusedGraphText(graph.text, question);
  const bounded = boundedGraphText(focused);
  const result = {
    target,
    question,
    text: bounded.text,
    truncated: bounded.truncated,
    head: graph.currentHead,
    indexStatus: graph.indexStatus,
  };
  console.log(`PI_PLANNER_CODE_GRAPH ${JSON.stringify({
    status: 'success', target, head: graph.currentHead, indexStatus: graph.indexStatus,
    serializedBytes: Buffer.byteLength(result.text, 'utf8'), truncated: result.truncated,
  })}`);
  return result;
}

export function registerPlannerEvidenceTools(pi, {
  repoSearchFn = repoSearch,
  plannerCodeGraphFn = plannerCodeGraph,
} = {}) {
  if (typeof pi?.registerTool !== 'function') return;

  pi.registerTool({
    name: 'repo_search',
    label: 'Planner repository search',
    description: 'Read-only deterministic search over tracked files in the current planner worktree. Use when the exact path or text location is unknown.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['content', 'path'] },
        query: { type: 'string', minLength: 1, maxLength: 300 },
        pathPrefix: { type: 'string', maxLength: 300 },
        extensions: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 16 }, maxItems: 12 },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = repoSearchFn(ctx.cwd, params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: 'planner_code_graph',
    label: 'Planner code graph',
    description: 'Read-only bounded structural context for one concrete symbol/path in the current trusted Orbit index. Use for callers, references, implementations, dependencies, related tests, or blast-radius questions.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 400 },
        question: { type: 'string', minLength: 1, maxLength: 400 },
      },
      required: ['target', 'question'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await plannerCodeGraphFn(ctx.cwd, params, { signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}

function recordEvidenceState(admission, { fact = null, toolName = null, env = process.env } = {}) {
  const file = env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  if (!file) return;
  try {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
    const previousUsed = Number.isSafeInteger(previous?.used) && previous.used >= 0 ? previous.used : 0;
    const nextUsed = Math.max(previousUsed, Number.isSafeInteger(admission?.used) ? admission.used : 0);
    const previousFacts = Array.isArray(previous?.facts)
      ? previous.facts.filter(item => typeof item === 'string' && item.trim())
      : [];
    const facts = [...previousFacts];
    if (fact && !facts.includes(fact)) facts.push(fact);
    const toolCounts = {};
    for (const [name, count] of Object.entries(previous?.toolCounts ?? {})) {
      if (PLANNER_EVIDENCE_TOOLS.includes(name) && Number.isSafeInteger(count) && count >= 0) toolCounts[name] = count;
    }
    if (nextUsed > previousUsed && PLANNER_EVIDENCE_TOOLS.includes(toolName)) {
      toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
    }
    const state = { ...previous, used: nextUsed, facts, toolCounts };
    delete state.cap;
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn(`PI_PLANNER_EVIDENCE_STATE_FAILED ${JSON.stringify({ error: String(error?.message ?? error) })}`);
  }
}

function stableSignatureValue(value) {
  if (Array.isArray(value)) return value.map(stableSignatureValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableSignatureValue(value[key])]));
}

function plannerActionSignature(toolName, input) {
  return `${toolName}:${JSON.stringify(stableSignatureValue(input ?? {}))}`;
}

function recordEvidenceFailure({ failureKind, diagnostic, env = process.env }) {
  const file = env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  if (!file) return;
  try {
    let previous = {};
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* state may not exist yet */ }
    const next = {
      ...previous,
      failureKind,
      failureDiagnostic: sanitizeDiagnosticText(diagnostic, 400),
    };
    fs.writeFileSync(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn(`PI_PLANNER_EVIDENCE_STATE_FAILED ${JSON.stringify({ error: String(error?.message ?? error) })}`);
  }
}

// Persist protocol state separately from the short evidence fingerprint ledger. Only a
// complete, normally terminated submit_plan can write planText to this private sidecar.
function updatePlannerProtocolState(patch, env = process.env) {
  const file = env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  if (!file) return;
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fresh child */ }
  fs.writeFileSync(file, JSON.stringify({ ...previous, ...patch }) + '\n', { mode: 0o600 });
}

// Admission is deliberately minimal; observability signals are not a semantic judge.
// Check ALL available verified paths (including the last evidence action), plus explicit
// issue targets. Never truncate the candidates based on investigation order.
function plannerNamedTargets(text) {
  if (typeof text !== 'string') return [];
  const paths = text.match(/(?<![A-Za-z0-9:/])(?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/g) ?? [];
  const rootFiles = text.match(/\b(?:package\.json|README\.md|Makefile|gradlew|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pyproject\.toml)\b/g) ?? [];
  return [...paths, ...rootFiles];
}

function plannerCapabilityBlocker(text) {
  // A generic "blocked" or "cannot" in an implementation description is NOT
  // evidence that a GitHub/PR/permission/tool capability is unavailable.
  return /\b(?:missing|unavailable|not exposed|without|lack(?:ing|s)?|insufficient|no)\s+(?:(?:required|available|necessary|write|appropriate)\s+)?(?:github\s+(?:api|access|permissions?|tools?)|(?:api|tool|capability|permission|credentials?|access)\b)/i.test(text) ||
    /\b(?:cannot|unable to|blocked from|out.of.scope(?:\s+for)?)\b[^.\n]{0,120}\b(?:github|pull request|PR\b|issues?\b|api\b|permissions?\b|tools?\b|capability|orchestration)\b/i.test(text);
}

export function plannerPlanAdmission(planText, facts = [], issue = null) {
  if (typeof planText !== 'string' || !planText.trim()) return { ok: false, failureKind: 'planner_submission_invalid' };
  if (planText.split(/\r?\n/).some(line => /^\s*(?:\[INSERT PLAN HERE\]|<TODO:\s*write plan>)\s*$/i.test(line))) {
    return { ok: false, failureKind: 'planner_submission_placeholder' };
  }
  const issueText = [issue?.title, issue?.body].filter(value => typeof value === 'string').join('\n');
  const knownTargets = [...new Set([
    ...plannerNamedTargets(issueText),
    ...facts.flatMap(fact => plannerNamedTargets(String(fact))),
  ])];
  const targetMentioned = knownTargets.some(target => planText.includes(target));
  const blocker = plannerCapabilityBlocker(planText);
  const title = String(issue?.title ?? '').trim();
  const issueTerms = [...new Set((title.toLowerCase().match(/[a-z0-9_-]{5,}/g) ?? [])
    .filter(word => !new Set(['issue', 'create', 'update', 'change', 'implement', 'review', 'task', 'tests', 'planner']).has(word)))];
  const issueAlignment = issueTerms.some(word => planText.toLowerCase().includes(word));
  // An actual target outweighs superficial issue-keyword matching. When paths exist,
  // the submitted plan must mention ANY of them, or explicitly state a capability blocker.
  // Non-code orchestration tasks can have no legitimate repository paths.
  if (knownTargets.length > 0 && !targetMentioned && !blocker) {
    return { ok: false, failureKind: 'planner_submission_missing_verified_target' };
  }
  if (knownTargets.length === 0 && issueTerms.length > 0 && !issueAlignment && !blocker) {
    return { ok: false, failureKind: 'planner_submission_missing_issue_alignment' };
  }
  return {
    ok: true,
    qualitySignals: {
      verifiedTargets: knownTargets.length,
      targetMentioned,
      capabilityBlocker: blocker,
      issueAlignment,
      actionableSteps: /\b(update|modify|add|remove|test|verify|inspect|implement|review|create|check)\b/i.test(planText),
      verification: /\b(test|verification|verify|check|CI)\b/i.test(planText),
      uncertainty: /\b(assum|unknown|unverified|uncertain|blocker)\b/i.test(planText),
    },
  };
}

// Inspect only budget fields actually serialized in the provider request. The
// expected phase budget is NOT evidence of what the provider will receive.
// Keep model capacity separate from serialized provider payload verification.
export function plannerProviderBudgetEvidence(payload, expected) {
  const fields = [
    ['max_output_tokens', payload?.max_output_tokens],
    ['max_completion_tokens', payload?.max_completion_tokens],
    ['max_tokens', payload?.max_tokens],
    ['maxTokens', payload?.maxTokens],
    ['generationConfig.maxOutputTokens', payload?.generationConfig?.maxOutputTokens],
    ['generation_config.max_output_tokens', payload?.generation_config?.max_output_tokens],
  ].filter(([, value]) => value !== undefined && value !== null);
  if (fields.length === 0) {
    return { effective: null, fields: [], verified: false, reason: 'provider_budget_unverified' };
  }
  const values = fields.map(([field, value]) => ({ field, value }));
  const valid = values.every(({ value }) => Number.isSafeInteger(value) && value > 0);
  const unique = new Set(values.map(({ value }) => value));
  const effective = valid && unique.size === 1 ? values[0].value : null;
  return {
    effective,
    fields: values.map(({ field }) => field),
    verified: effective === expected,
    reason: !valid ? 'invalid_provider_budget' : unique.size !== 1
      ? 'conflicting_provider_budgets' : effective === expected ? 'verified' : 'provider_budget_mismatch',
  };
}

// Read status from Pi's OpenAI-compatible provider error envelope. A 400/422
// alone does not identify tool-choice incompatibility: context and token-budget
// validation also return these statuses. An ordinary 200 with prose is a
// separate failure to produce an executable terminal tool call.
export function plannerProviderErrorStatus(message) {
  if (message?.stopReason !== 'error') return null;
  for (const value of [message.status, message.statusCode, message.error?.status, message.error?.statusCode]) {
    const code = Number(value);
    if (Number.isInteger(code) && code >= 100 && code <= 599) return code;
  }
  const text = String(message.errorMessage ?? '').trim();
  const sdk = /^(?:([45]\d{2})(?::(?:\s|$)|\s+(?=(?:status code\b|[\[{])))|[A-Za-z_$][\w.$]*Error:\s*([45]\d{2})(?=[:\s]|$))/.exec(text);
  if (sdk) return Number(sdk[1] ?? sdk[2]);
  const api = /\bAPI error \((\d{3})\):/.exec(text);
  return api ? Number(api[1]) : null;
}

// Classify provider errors narrowly; only an explicit constraint rejection
// permits the single named-tool compatibility retry. Never log raw provider
// errors because they may contain request details or credentials.
export function plannerSubmissionProviderError(message) {
  const status = plannerProviderErrorStatus(message);
  if (status == null) return { status: null, kind: 'transport' };
  if (![400, 422].includes(status)) return { status, kind: 'transport' };
  const error = String(message?.errorMessage ?? message?.error?.message ?? '');
  if (/\b(?:context.{0,40}(?:length|window|size|exceed)|maximum context|too many tokens|prompt.{0,30}(?:long|large)|token.{0,30}limit)\b/i.test(error)) {
    return { status, kind: 'context_exhausted' };
  }
  if (/\b(?:max[_ -]?(?:completion[_ -]?|output[_ -]?)?tokens?|output[_ -]?budget)\b/i.test(error)) {
    return { status, kind: 'invalid_output_budget' };
  }
  const choice = /\b(?:tool[_ -]?choice|function[_ -]?calling|function[_ -]?call)\b/i.test(error);
  const rejected = /\b(?:unsupported|not supported|does not support|invalid|unknown|unrecognized|rejected|not allowed|forbidden|not permitted|must be|expected|requires?|cannot|can't)\b/i.test(error);
  return { status, kind: choice && rejected ? 'tool_choice_rejected' : 'other_bad_request' };
}

// Never infer policy from getActiveTools: only the exact post-filtered provider
// request is authoritative. Named choice is a single bounded compatibility
// correction for providers which reject or ignore "required".
export function plannerSubmissionToolChoice(strategy) {
  return strategy === 'named'
    ? { type: 'function', function: { name: 'submit_plan' } }
    : 'required';
}

function plannerToolChoiceLabel(choice) {
  if (typeof choice === 'string') return choice;
  if (choice && typeof choice === 'object') {
    const name = choice.function?.name ?? choice.name;
    return name === 'submit_plan' ? 'named:submit_plan' : 'named:other';
  }
  return choice == null ? null : 'unrecognized';
}

export default function (pi) {
  // Capture this child lifecycle's state identity exactly once. Parallel Planner
  // extension instances must never consult a later process.env value for sidecar writes.
  const stateEnv = { [PLANNER_EVIDENCE_STATE_FILE_ENV]: process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] };
  const lifecycleId = process.env[PLANNER_LIFECYCLE_ID_ENV];
  const issueContextFile = process.env.PI_ISSUE_CONTEXT;
  registerPlannerEvidenceTools(pi);
  pi.registerTool?.({
    name: 'begin_plan_submission',
    label: 'Finish Planner research',
    description: 'End repository investigation and request a separate provider turn to submit the complete plan. No arguments. This is NOT the finished handoff.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { return { content: [{ type: 'text', text: 'Research closed. On the next request call submit_plan with the complete Markdown plan; no repository tools remain.' }] }; },
  });
  pi.registerTool?.({
    name: 'submit_plan',
    label: 'Submit complete plan',
    description: 'Only successful Planner terminal operation. Supply the full actionable Markdown/plain-text plan in planText on the dedicated larger-budget request.',
    parameters: { type: 'object', properties: { planText: { type: 'string', minLength: 1 } }, required: ['planText'], additionalProperties: false },
    async execute(toolCallId) {
      // Pi applies this after the completed tool batch and turn_end, so the
      // normal success path can durably persist the validated plan first.
      // Invalid, partial or unverified submissions must keep their recovery turn.
      return {
        content: [{ type: 'text', text: 'Plan submission received; the runtime will validate complete provider termination before acceptance.' }],
        terminate: canTerminateSubmittedPlan(toolCallId),
      };
    },
  });

  const gate = createPlannerEvidenceGate();
  const pendingEvidence = new Map();
  const knownFacts = new Set();
  let phase = 'researching';
  let budget = 2048;
  let escalated = false;
  let nudgeUsed = false;
  let evidenceProgressContinuationPending = false;
  let stallDetected = false;
  let lastEvidenceSignature = null;
  let lastEvidenceMadeProgress = true;
  let consecutiveNoProgressEvidence = 0;
  let control = null;
  let lastAssistant = null;
  let lastProviderInputTokens = null;
  let providerRequest = 0;
  let submissionChoiceStrategy = 'required';
  let submissionCorrectionUsed = false;
  let lastSerializedChoice = null;
  let providerBudgetEvidence = { effective: null, fields: [], verified: false, reason: 'no_provider_request' };
  const budgetHistory = [];

  function canTerminateSubmittedPlan(toolCallId) {
    // message_end precedes tool execution in Pi; the full provider response and
    // its serialized budget must be verified before asking Pi to skip follow-up.
    return phase === 'submission_pending' && providerBudgetEvidence.verified &&
      control?.kind === 'submit' && control.toolCallId === toolCallId &&
      lastAssistant?.complete && lastAssistant.reason === 'tooluse' &&
      lastAssistant.calls.length === 1 &&
      lastAssistant.calls[0].name === 'submit_plan' &&
      lastAssistant.calls[0].id === toolCallId;
  }

  function setPhase(next, metadata = {}) {
    const prior = phase;
    phase = next;
    updatePlannerProtocolState({ phase, submissionBudget: budget, budgetHistory, ...metadata }, stateEnv);
    console.log(`PI_PLANNER_PHASE ${JSON.stringify({ from: prior, to: next, budget, ...('failureKind' in metadata ? { failureKind: metadata.failureKind } : {}) })}`);
  }
  function fail(failureKind, reason, ctx) {
    const sanitized = sanitizeDiagnosticText(reason, 300);
    recordEvidenceFailure({ failureKind, diagnostic: sanitized, env: stateEnv });
    setPhase('failed', { failureKind });
    console.warn(`PI_PLANNER_SUBMISSION_REJECTED ${JSON.stringify({ failureKind, reason: sanitized, budget })}`);
    ctx?.abort?.();
  }
  function continuation(entries, message, kind) {
    return {
      entries: [...(Array.isArray(entries) ? entries : []), {
        type: 'custom_message', customType: kind, content: message, display: false,
      }],
      continue: true,
    };
  }
  async function applyBudget(ctx, target) {
    // A budget switch happens only between provider requests; the model is owned by this
    // Planner child. No process-global mutation can affect concurrent agents.
    if (!plannerBudgetSupported(pi, target) || !ctx?.model || typeof pi.setModel !== 'function') return false;
    const capacity = Number(ctx.model.contextWindow);
    if (Number.isFinite(capacity) && capacity > 0) {
      if (capacity < target + 1024) return false;
      // A retry must retain enough verified history for a meaningful plan without researching again.
      if (target === 8192 && (!Number.isFinite(lastProviderInputTokens) ||
          lastProviderInputTokens + target + 1024 > capacity)) return false;
    }
    const changed = await pi.setModel({ ...ctx.model, maxTokens: target });
    if (!changed) return false;
    budget = target;
    // The upcoming request has not happened yet, but the accepted session-scoped
    // budget transition must already be durable and visible to the parent.
    updatePlannerProtocolState({ submissionBudget: budget }, stateEnv);
    return true;
  }

  recordEvidenceState({ used: 0 }, { env: stateEnv });
  updatePlannerProtocolState({ phase, submissionBudget: budget, budgetHistory }, stateEnv);
  console.log(`PI_PLANNER_CAT_WAITING ${JSON.stringify({ state: 'CAT_WAITING', event: 'start' })}`);
  pi.on('before_provider_request', (event, ctx) => {
    const payload = event?.payload;
    if (!payload) return payload;
    // Never expose submit_plan on a research request or evidence tools after transition.
    const allowed = phase === 'researching'
      ? new Set([...PLANNER_EVIDENCE_TOOLS, 'begin_plan_submission'])
      : phase === 'submission_pending' ? new Set(['submit_plan']) : new Set();
    const tools = Array.isArray(payload.tools)
      ? payload.tools.filter(tool => allowed.has(tool.function?.name ?? tool.name))
      : [];
    const executableTools = tools.map(tool => tool.function?.name ?? tool.name);
    const requestedChoice = plannerToolChoiceLabel(payload.tool_choice);
    providerBudgetEvidence = plannerProviderBudgetEvidence(payload, budget);
    const submission = phase === 'submission_pending';
    // Pi catches hook exceptions and sends the ORIGINAL provider payload.
    // Never throw here: abort the child through the supplied ctx and return a
    // sanitized, tool-less payload even if cancellation is asynchronous.
    if (submission && (executableTools.length !== 1 || executableTools[0] !== 'submit_plan')) {
      fail('planner_submission_tool_unavailable',
        'submit_plan is absent or not the sole serialized provider tool', ctx);
      const { tools: _tools, tool_choice: _choice, ...safePayload } = payload;
      console.warn('PI_PLANNER_PROVIDER_WIRE_BLOCKED ' + JSON.stringify({
        phase: 'submission_pending', reason: 'submit_plan_not_executable',
        serializedToolChoice: null, serializedTools: [],
      }));
      return safePayload;
    }
    const selectedChoice = submission ? plannerSubmissionToolChoice(submissionChoiceStrategy)
      : tools.length > 0 ? 'auto' : null;
    const selectedChoiceLabel = plannerToolChoiceLabel(selectedChoice);
    lastSerializedChoice = selectedChoiceLabel;
    providerRequest += 1;
    budgetHistory.push({
      phase, expected: budget, effective: providerBudgetEvidence.effective,
      fields: providerBudgetEvidence.fields, verified: providerBudgetEvidence.verified,
      reason: providerBudgetEvidence.reason,
      requestedToolChoice: requestedChoice,
      serializedToolChoice: selectedChoiceLabel,
      executableTools,
    });
    updatePlannerProtocolState({ budgetHistory, submissionBudget: budget }, stateEnv);
    const wire = tools.length === 0
      ? (({ tools: _tools, tool_choice: _choice, ...rest }) => rest)(payload)
      : { ...payload, tools, tool_choice: selectedChoice };
    console.log(`PI_PLANNER_PROVIDER_REQUEST ${JSON.stringify({
      request: providerRequest, phase, requestedBudget: budget,
      effectiveBudget: providerBudgetEvidence.effective,
      providerFields: providerBudgetEvidence.fields, budgetVerified: providerBudgetEvidence.verified,
      verificationReason: providerBudgetEvidence.reason,
      requestedToolChoice: requestedChoice, serializedToolChoice: plannerToolChoiceLabel(wire.tool_choice),
      soleExecutableTool: executableTools.length === 1 ? executableTools[0] : null,
      tools: executableTools, compatibilityCorrection: submissionCorrectionUsed,
    })}`);
    return wire;
  });

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === 'begin_plan_submission') {
      if (phase !== 'researching' || control || Object.keys(event.input ?? {}).length > 0) {
        return { block: true, reason: 'begin_plan_submission is valid only once during research with no arguments.' };
      }
      control = { kind: 'begin', toolCallId: event.toolCallId, executed: false };
      return undefined;
    }
    if (event.toolName === 'submit_plan') {
      if (phase !== 'submission_pending' || control) return { block: true, reason: 'submit_plan is allowed once in submission_pending only.' };
      const decision = plannerPlanAdmission(event.input?.planText, [...knownFacts], (() => {
        try { return JSON.parse(fs.readFileSync(issueContextFile, 'utf8')); } catch { return null; }
      })());
      if (!decision.ok) {
        control = { kind: 'invalid', failureKind: decision.failureKind };
        return { block: true, reason: decision.failureKind };
      }
      control = { kind: 'submit', toolCallId: event.toolCallId, executed: false, planText: event.input.planText, qualitySignals: decision.qualitySignals };
      return undefined;
    }
    if (phase !== 'researching') {
      return { block: true, reason: 'Planner repository inspection is closed after begin_plan_submission.' };
    }
    const signature = PLANNER_EVIDENCE_TOOLS.includes(event.toolName)
      ? plannerActionSignature(event.toolName, event.input) : null;
    if (signature && signature === lastEvidenceSignature && !lastEvidenceMadeProgress) {
      stallDetected = true;
      console.log(`PI_PLANNER_NO_PROGRESS ${JSON.stringify({ kind: 'repeated_evidence', tool: event.toolName })}`);
      return { block: true, reason: 'Repeated equivalent evidence produced no progress. Call begin_plan_submission with facts already collected.' };
    }
    const admission = gate.admit(event.toolName);
    if (admission.allowed) {
      recordEvidenceState(admission, { toolName: event.toolName, env: stateEnv });
      if (event.toolCallId) pendingEvidence.set(event.toolCallId, {
        toolName: event.toolName, input: structuredClone(event.input ?? {}), admission, signature,
      });
      console.log(`PI_PLANNER_EVIDENCE ${JSON.stringify({ tool: event.toolName, action: admission.used })}`);
      return undefined;
    }
    return { block: true, reason: admission.reason };
  });

  pi.on('message_end', event => {
    const msg = event?.message;
    if (msg?.role !== 'assistant') return;
    const calls = Array.isArray(msg.content) ? msg.content.filter(block => block?.type === 'toolCall') : [];
    const reason = String(msg.stopReason ?? msg.stop_reason ?? '').toLowerCase();
    const output = Number(msg.usage?.outputTokens ?? msg.usage?.output_tokens ?? msg.usage?.output);
    const input = Number(msg.usage?.inputTokens ?? msg.usage?.input_tokens ?? msg.usage?.input);
    if (Number.isFinite(input) && input >= 0) lastProviderInputTokens = input;
    lastAssistant = {
      reason, calls: calls.map(call => ({ id: call.id, name: call.name })),
      complete: ['tooluse', 'stop', 'end_turn', 'completed', 'complete'].includes(reason),
      outputTokens: Number.isFinite(output) ? output : null,
      text: Array.isArray(msg.content) && msg.content.some(block => block?.type === 'text' && String(block.text ?? '').trim()),
      status: plannerProviderErrorStatus(msg),
      // Keep in memory only for classification. Never persist or log raw error prose.
      errorMessage: typeof msg.errorMessage === 'string' ? msg.errorMessage
        : typeof msg.error?.message === 'string' ? msg.error.message : '',
    };
    if (phase === 'submission_pending') {
      console.log(`PI_PLANNER_PROVIDER_RESPONSE ${JSON.stringify({
        request: providerRequest, serializedToolChoice: lastSerializedChoice,
        stopReason: reason, httpStatus: lastAssistant.status,
        responseForm: calls.length ? 'tool_call' : lastAssistant.text ? 'text_only' : 'no_tool_call',
        toolCallCount: calls.length, toolNames: calls.map(call => call.name),
        outputTokens: lastAssistant.outputTokens,
      })}`);
    }
    if (lastAssistant.text && calls.length === 0 && phase === 'researching') {
      evidenceProgressContinuationPending = false;
      console.log('PI_PLANNER_PLAIN_FINAL_REJECTED');
    }
  });

  pi.on('tool_execution_end', event => {
    if (control?.toolCallId && event.toolCallId === control.toolCallId) {
      control.executed = !event.isError;
      return;
    }
    const pending = event.toolCallId ? pendingEvidence.get(event.toolCallId) : null;
    if (event.toolCallId) pendingEvidence.delete(event.toolCallId);
    if (!pending) return;
    const fact = event.isError ? null : plannerEvidenceFact(pending.toolName, pending.input, event.result);
    const progress = Boolean(fact && !knownFacts.has(fact));
    if (progress) {
      consecutiveNoProgressEvidence = 0;
      knownFacts.add(fact);
      recordEvidenceState(pending.admission, { fact, toolName: pending.toolName, env: stateEnv });
      console.log(`PI_PLANNER_EVIDENCE_FACT ${JSON.stringify({ tool: pending.toolName, fact })}`);
      console.log(`PI_PLANNER_CAT_WAITING ${JSON.stringify({ state: 'CAT_WAITING', event: 'progress' })}`);
      if (phase === 'researching') evidenceProgressContinuationPending = true;
    } else {
      consecutiveNoProgressEvidence += 1;
      if (consecutiveNoProgressEvidence >= EVIDENCE_NO_PROGRESS_STREAK_LIMIT) {
        stallDetected = true;
        console.log(`PI_PLANNER_NO_PROGRESS ${JSON.stringify({ kind: 'evidence_streak', consecutiveNoProgressEvidence })}`);
      }
    }
    lastEvidenceSignature = pending.signature;
    lastEvidenceMadeProgress = progress;
  });

  pi.on('turn_end', async (event, ctx) => {
    const entries = event?.entries;
    if (phase === 'researching') {
      const beginComplete = control?.kind === 'begin' && control.executed && lastAssistant?.complete &&
        lastAssistant.reason === 'tooluse' && lastAssistant.calls.length === 1 &&
        lastAssistant.calls[0].name === 'begin_plan_submission' &&
        lastAssistant.calls[0].id === control.toolCallId;
      if (beginComplete) {
        if (!providerBudgetEvidence.verified) {
          fail('planner_submission_budget_unavailable', 'Research request output budget was not verified at provider boundary', ctx);
          return;
        }
        control = null;
        evidenceProgressContinuationPending = false;
        if (!(await applyBudget(ctx, 4096))) {
          fail('planner_submission_budget_unavailable', '4096 output tokens not supported for this Planner session', ctx);
          return;
        }
        setPhase('submission_pending');
        pi.setActiveTools?.(['submit_plan']);
        return continuation(entries,
          'RESEARCH CLOSED. On THIS NEW provider request call submit_plan({ planText }) exactly once with the complete actionable Markdown plan. No repository evidence tools remain. Do not return plain prose.',
          'planner-submission-phase');
      }
      if (control?.kind === 'begin') { control = null; stallDetected = true; }
      if (stallDetected || lastAssistant?.text && lastAssistant.calls.length === 0) {
        evidenceProgressContinuationPending = false;
        if (nudgeUsed) {
          fail(stallDetected ? 'planner_no_progress' : 'planner_submission_not_started',
            'Planner did not begin submission after the deterministic nudge', ctx);
          return;
        }
        nudgeUsed = true;
        stallDetected = false;
        return continuation(entries, 'PLANNER COMPLETION REQUIRED: research is over. Using only already-collected evidence, call begin_plan_submission() exactly once. Ordinary final prose is NOT a submission.', 'planner-research-nudge');
      }
      if (evidenceProgressContinuationPending) {
        evidenceProgressContinuationPending = false;
        console.log(`PI_PLANNER_EVIDENCE_CONTINUATION ${JSON.stringify({ action: 'delivered', source: 'turn_end' })}`);
        return continuation(entries, '🐈 The cat is still waiting to be petted. Finish the plan as soon as you have enough evidence.', 'planner-evidence-progress');
      }
      return undefined;
    }
    if (phase !== 'submission_pending') return undefined;
    const accepted = control?.executed && canTerminateSubmittedPlan(control.toolCallId);
    if (accepted) {
      if (!lifecycleId) {
        fail('planner_submission_incomplete', 'Planner lifecycle identity is missing', ctx);
        return;
      }
      const planText = control.planText;
      const qualitySignals = control.qualitySignals;
      const planTextBytes = Buffer.byteLength(planText, 'utf8');
      // The adapter may reject empty final prose after terminate:true. Persist the
      // proof of the *executed* complete tool call, not just an attempted submission.
      // The parent matches this against its per-attempt nonce before accepting it.
      const submissionReceipt = {
        lifecycleId, toolCallId: control.toolCallId,
        admitted: true, executed: control.executed, providerComplete: lastAssistant.complete,
        stopReason: lastAssistant.reason, providerBudgetVerified: providerBudgetEvidence.verified,
        submissionBudget: budget, planTextBytes,
      };
      setPhase('submitted', { planText, qualitySignals, submissionReceipt });
      console.log(`PI_PLANNER_SUBMITTED ${JSON.stringify({
        planTextBytes, budget, qualitySignals, termination: lastAssistant.reason,
        request: providerRequest, serializedToolChoice: lastSerializedChoice,
        compatibilityCorrection: submissionCorrectionUsed, acceptedReceipt: true,
      })}`);
      console.log(`PI_PLANNER_CAT_PETTED ${JSON.stringify({ state: 'CAT_PETTED', event: 'accepted' })}`);
      pi.setActiveTools?.([]);
      control = null;
      return undefined;
    }
    // A longer attempt cannot repair an unverified provider serialization budget.
    if (!providerBudgetEvidence.verified) {
      fail('planner_submission_budget_unavailable',
        'Actual submission provider budget is unverified or differs from the phase budget', ctx);
      return;
    }
    // An inadmissible but complete plan is a terminal invalid plan, not a transport retry.
    if (control?.kind === 'invalid' && control.failureKind !== 'planner_submission_invalid') {
      fail(control.failureKind, 'Complete submit_plan was rejected by minimal admission', ctx);
      return;
    }
    if (lastAssistant?.reason === 'error' || lastAssistant?.reason === 'aborted') {
      const error = plannerSubmissionProviderError({
        stopReason: lastAssistant.reason, status: lastAssistant.status,
        errorMessage: lastAssistant.errorMessage,
      });
      const incompatible = error.kind === 'tool_choice_rejected';
      if (incompatible && !submissionCorrectionUsed && !escalated &&
          submissionChoiceStrategy === 'required') {
        submissionChoiceStrategy = 'named';
        submissionCorrectionUsed = true;
        control = null;
        console.warn(`PI_PLANNER_TOOL_CHOICE_CORRECTION ${JSON.stringify({
          request: providerRequest, cause: 'required_rejected', httpStatus: lastAssistant.status,
          previousChoice: lastSerializedChoice, nextChoice: 'named:submit_plan', retry: 1,
        })}`);
        return continuation(entries,
          'SUBMISSION COMPATIBILITY RETRY ONLY: the provider rejected required tool choice. Call submit_plan({ planText }) once. Do not research or return ordinary prose.',
          'planner-tool-choice-compatibility');
      }
      const classification = incompatible ? 'planner_submission_tool_choice_unsupported'
        : error.kind === 'context_exhausted' ? 'planner_submission_context_exhausted'
        : error.kind === 'invalid_output_budget' ? 'planner_submission_budget_unavailable'
        : error.kind === 'other_bad_request' ? 'planner_submission_provider_rejected'
        : 'planner_submission_transport_failure';
      console.warn('PI_PLANNER_PROVIDER_FAILURE ' + JSON.stringify({
        request: providerRequest, httpStatus: error.status, classification,
        providerErrorKind: error.kind, retryAllowed: false,
      }));
      fail(classification, 'Submission provider error classified as ' + error.kind, ctx);
      return;
    }
    if (lastAssistant?.reason === 'tooluse' &&
        (lastAssistant.calls.length > 1 ||
          lastAssistant.calls.some(call => call.name !== 'submit_plan'))) {
      fail('planner_submission_invalid_transition', 'Duplicate, forbidden or wrong terminal tool call', ctx);
      return;
    }
    if (lastAssistant?.complete && lastAssistant.reason !== 'tooluse') {
      if (!submissionCorrectionUsed && !escalated &&
          submissionChoiceStrategy === 'required') {
        submissionChoiceStrategy = 'named';
        submissionCorrectionUsed = true;
        control = null;
        console.warn(`PI_PLANNER_TOOL_CHOICE_CORRECTION ${JSON.stringify({
          request: providerRequest, cause: 'completed_without_tool_call',
          responseForm: lastAssistant.text ? 'text_only' : 'no_tool_call',
          previousChoice: lastSerializedChoice, nextChoice: 'named:submit_plan', retry: 1,
        })}`);
        return continuation(entries,
          'SUBMISSION CORRECTION ONLY: the provider completed without executing submit_plan. This is the sole retry. Call submit_plan({ planText }) with the full plan, not plain prose. No research.',
          'planner-tool-choice-correction');
      }
      fail('planner_submission_tool_choice_ignored',
        'Completed provider response omitted submit_plan despite mandatory tool choice', ctx);
      return;
    }
    const failureKind = control?.failureKind ?? 'planner_submission_incomplete';
    const cause = control?.failureKind ?? (lastAssistant?.reason === 'length' ? 'truncated' : 'incomplete_or_missing_submit_plan');
    const retryable = lastAssistant?.reason === 'length' ||
      control?.kind === 'invalid' && control.failureKind === 'planner_submission_invalid' ||
      (lastAssistant?.reason === 'tooluse' && (!control || !control.executed || !lastAssistant.complete));
    control = null;
    if (!retryable) {
      fail(failureKind, 'Submission did not contain a complete valid tool call', ctx);
      return;
    }
    if (!escalated && !submissionCorrectionUsed) {
      escalated = true;
      if (!(await applyBudget(ctx, 8192))) {
        const capacity = Number(ctx?.model?.contextWindow);
        const className = Number.isFinite(capacity) && capacity > 0 &&
          Number.isFinite(lastProviderInputTokens) && lastProviderInputTokens + 9216 > capacity
          ? 'planner_submission_context_exhausted' : 'planner_submission_budget_unavailable';
        fail(className, '8192-token submission-only retry cannot fit or is unsupported', ctx);
        return;
      }
      console.log(`PI_PLANNER_BUDGET_ESCALATION ${JSON.stringify({ cause, to: budget, evidenceToolsAvailable: false })}`);
      pi.setActiveTools?.(['submit_plan']);
      return continuation(entries,
        'SUBMISSION RETRY ONLY: previous submit_plan transport was incomplete or malformed. Do not inspect the repository or reuse partial tool arguments. Call submit_plan({ planText }) with the FULL plan from existing issue and verified research context; this is the sole retry.',
        'planner-submission-retry');
    }
    fail(failureKind, 'One permitted incomplete-submission retry did not complete', ctx);
    return undefined;
  });
}

function sanitizeDiagnosticText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted pem]')
    .replace(/\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{12,}\b/g, '[redacted credential]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s]+)/gi, '$1[redacted]')
    .slice(0, maxLength);
}
