import { plannerBudgetSupported, plannerModelLimit } from './pi-common/planner-request-budget.mjs';
import fs from 'node:fs';
import { repoSearch } from './pi-common/repo-search.mjs';
import { plannerOrbitContext } from './pi-common/planner-orbit.mjs';

// Loaded only inside the implementation-planner pi-subagents child via .pi/settings.json.
// Enforces the trusted read-only surface at tool-call time. Evidence action counts are
// observability only; semantic no-progress guards, not numeric budgets, stop accidental loops.
import {
  PLANNER_EVIDENCE_STATE_FILE_ENV,
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

export function plannerPlanAdmission(planText, facts = [], issue = null) {
  if (typeof planText !== 'string' || !planText.trim()) return { ok: false, failureKind: 'planner_submission_invalid' };
  if (planText.split(/\r?\n/).some(line => /^\s*(?:\[INSERT PLAN HERE\]|<TODO:\s*write plan>)\s*$/i.test(line))) {
    return { ok: false, failureKind: 'planner_submission_placeholder' };
  }
  const paths = facts.flatMap(fact => String(fact).match(/(?:src|tests|scripts|agents|\.pi|\.github)\/[A-Za-z0-9_./-]+/g) ?? []);
  const knownTargets = [...new Set(paths)].slice(0, 8);
  const targetMentioned = knownTargets.some(target => planText.includes(target));
  const blocker = /\b(blocked|unavailable|out.of.scope|missing (?:access|permission|tool|capability)|cannot|not exposed|requires github)\b/i.test(planText);
  // A verified concrete repository target should survive in the handoff, unless the Planner
  // explicitly explains why implementing it is outside the available tool surface.
  if (knownTargets.length && !targetMentioned && !blocker) {
    return { ok: false, failureKind: 'planner_submission_missing_verified_target' };
  }
  const title = String(issue?.title ?? '').trim();
  return {
    ok: true,
    qualitySignals: {
      verifiedTargets: knownTargets.length,
      targetMentioned,
      capabilityBlocker: blocker,
      issueAlignment: Boolean(title && title.split(/\s+/).some(word => word.length > 4 && planText.toLowerCase().includes(word.toLowerCase()))),
      actionableSteps: /\b(update|modify|add|remove|test|verify|inspect|implement|review|create|check)\b/i.test(planText),
      verification: /\b(test|verification|verify|check|CI)\b/i.test(planText),
      uncertainty: /\b(assum|unknown|unverified|uncertain|blocker)\b/i.test(planText),
    },
  };
}

export default function (pi) {
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
    async execute() { return { content: [{ type: 'text', text: 'Plan submission received; the runtime will validate complete provider termination before acceptance.' }] }; },
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
  const budgetHistory = [];

  function setPhase(next, metadata = {}) {
    const prior = phase;
    phase = next;
    updatePlannerProtocolState({ phase, submissionBudget: budget, budgetHistory, ...metadata });
    console.log(`PI_PLANNER_PHASE ${JSON.stringify({ from: prior, to: next, budget, ...('failureKind' in metadata ? { failureKind: metadata.failureKind } : {}) })}`);
  }
  function fail(failureKind, reason, ctx) {
    const sanitized = sanitizeDiagnosticText(reason, 300);
    recordEvidenceFailure({ failureKind, diagnostic: sanitized });
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
    return true;
  }

  recordEvidenceState({ used: 0 });
  updatePlannerProtocolState({ phase, submissionBudget: budget, budgetHistory });
  console.log(`PI_PLANNER_CAT_WAITING ${JSON.stringify({ state: 'CAT_WAITING', event: 'start' })}`);
  pi.on('before_provider_request', event => {
    const payload = event?.payload;
    if (!payload) return payload;
    // Never expose submit_plan on a research request or evidence tools after transition.
    const allowed = phase === 'researching'
      ? new Set([...PLANNER_EVIDENCE_TOOLS, 'begin_plan_submission'])
      : phase === 'submission_pending' ? new Set(['submit_plan']) : new Set();
    const tools = Array.isArray(payload.tools)
      ? payload.tools.filter(tool => allowed.has(tool.function?.name ?? tool.name))
      : [];
    const effective = Number(payload.max_output_tokens ?? payload.max_tokens ?? event.model?.maxTokens ?? budget);
    const validBudget = !Number.isFinite(effective) || effective === budget;
    budgetHistory.push({ phase, expected: budget, effective: Number.isFinite(effective) ? effective : null });
    updatePlannerProtocolState({ budgetHistory, submissionBudget: budget });
    console.log(`PI_PLANNER_PROVIDER_REQUEST ${JSON.stringify({ phase, requestedBudget: budget, effectiveBudget: Number.isFinite(effective) ? effective : null, tools: tools.map(tool => tool.function?.name ?? tool.name), validBudget })}`);
    if (!validBudget) recordEvidenceFailure({ failureKind: 'planner_submission_budget_unavailable', diagnostic: 'Provider budget disagrees with session phase' });
    if (tools.length === 0) {
      const { tools: _tools, tool_choice: _choice, ...rest } = payload;
      return rest;
    }
    return { ...payload, tools, tool_choice: 'auto' };
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
        try { return JSON.parse(fs.readFileSync(process.env.PI_ISSUE_CONTEXT, 'utf8')); } catch { return null; }
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
      recordEvidenceState(admission, { toolName: event.toolName });
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
    };
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
      recordEvidenceState(pending.admission, { fact, toolName: pending.toolName });
      console.log(`PI_PLANNER_EVIDENCE_FACT ${JSON.stringify({ tool: pending.toolName, fact })}`);
      console.log(`PI_PLANNER_CAT_WAITING ${JSON.stringify({ state: 'CAT_WAITING', event: 'progress' })}`);
      if (phase === 'researching') evidenceProgressContinuationPending = true;
    } else {
      consecutiveNoProgressEvidence += 1;
      if (consecutiveNoProgressEvidence >= EVIDENCE_NO_PROGRESS_STREAK_LIMIT) stallDetected = true;
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
        return continuation(entries, '🐈 The cat is still waiting to be petted. Finish the plan as soon as you have enough evidence.', 'planner-evidence-progress');
      }
      return undefined;
    }
    if (phase !== 'submission_pending') return undefined;
    const accepted = control?.kind === 'submit' && control.executed &&
      lastAssistant?.reason === 'tooluse' && lastAssistant.complete &&
      lastAssistant.calls.length === 1 && lastAssistant.calls[0].name === 'submit_plan' &&
      lastAssistant.calls[0].id === control.toolCallId &&
      (lastAssistant.outputTokens === null || lastAssistant.outputTokens < budget || lastAssistant.complete);
    if (accepted) {
      const planText = control.planText;
      const qualitySignals = control.qualitySignals;
      setPhase('submitted', { planText, qualitySignals });
      console.log(`PI_PLANNER_SUBMITTED ${JSON.stringify({ planTextBytes: Buffer.byteLength(planText, 'utf8'), budget, qualitySignals, termination: lastAssistant.reason })}`);
      console.log(`PI_PLANNER_CAT_PETTED ${JSON.stringify({ state: 'CAT_PETTED', event: 'accepted' })}`);
      pi.setActiveTools?.([]);
      control = null;
      return undefined;
    }
    const cause = control?.failureKind ?? (lastAssistant?.reason === 'length' ? 'truncated' : 'incomplete_or_missing_submit_plan');
    control = null;
    if (!escalated) {
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
        'SUBMISSION RETRY ONLY: the prior submit_plan was incomplete or invalid. Do not inspect the repository or reuse partial tool arguments. Call submit_plan({ planText }) with the FULL plan from existing issue and verified research context; this is the sole retry.',
        'planner-submission-retry');
    }
    fail('planner_submission_incomplete', 'Submission retry did not deliver a single complete normally terminated submit_plan call', ctx);
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
