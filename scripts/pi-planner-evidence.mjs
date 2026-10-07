import fs from 'node:fs';
import { repoSearch } from './pi-common/repo-search.mjs';
import { plannerOrbitContext } from './pi-common/planner-orbit.mjs';

// Loaded only inside the implementation-planner pi-subagents child via .pi/settings.json.
// Enforces the trusted read-only surface at tool-call time. Evidence action counts are
// observability only; semantic no-progress guards, not numeric budgets, stop accidental loops.
import {
  PLANNER_EVIDENCE_STATE_FILE_ENV,
  PLANNER_RESOLVED_TARGETS_ENV,
  PLANNER_EVIDENCE_TOOLS,
  PLANNER_RESULT_TOOL,
  createPlannerEvidenceGate,
  plannerEvidenceFact,
  validateResolvedTargetPaths,
} from './pi-common/implementation-planner.mjs';

const PLANNER_GRAPH_MAX_CHARS = 16000;
const RESULT_EQUIVALENT_NO_PROGRESS_LIMIT = 3;
const EVIDENCE_NO_PROGRESS_STREAK_LIMIT = 4;

function plannerResolvedTargets(env = process.env) {
  const raw = env[PLANNER_RESOLVED_TARGETS_ENV];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`PI_PLANNER_RESOLVED_TARGETS_INVALID ${JSON.stringify({ reason: 'non_object' })}`);
      return {};
    }
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string' && value.trim()));
  } catch (error) {
    console.warn(`PI_PLANNER_RESOLVED_TARGETS_INVALID ${JSON.stringify({
      reason: 'invalid_json',
      error: String(error?.message ?? error).slice(0, 200),
    })}`);
    return {};
  }
}

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

function plannerResultFailureSignature(kind, diagnostic, rawArguments) {
  const args = typeof rawArguments === 'string'
    ? sanitizeDiagnosticText(rawArguments, 240)
    : JSON.stringify(stableSignatureValue(rawArguments ?? {}));
  return `${kind}:${sanitizeDiagnosticText(diagnostic, 240)}:${args}`;
}

export default function (pi) {
  registerPlannerEvidenceTools(pi);
  const resolvedTargets = plannerResolvedTargets();

  let finalizing = false;
  let resultAttempts = 0;
  let structuredCorrections = 0;
  let resultCallPending = false;
  let resultSucceeded = false;
  const blockedResultCallIds = new Set();
  let streamedResultArguments = new Map();
  const observedResultCalls = [];
  const gate = createPlannerEvidenceGate();
  const pendingEvidence = new Map();
  const knownFacts = new Set();
  let lastEvidenceSignature = null;
  let lastEvidenceMadeProgress = true;
  let consecutiveNoProgressEvidence = 0;
  let missingResultRecoveryUsed = false;
  let lastResultFailureSignature = null;
  let equivalentResultFailureCount = 0;

  function observePlannerResultCall({ id = null, rawArguments, message = null } = {}) {
    resultAttempts += 1;
    const call = {
      id,
      rawArguments,
      message,
      admissionDecided: false,
      allowed: false,
      preValidationRejected: false,
      toolCallSeen: false,
      toolResultSeen: false,
    };
    observedResultCalls.push(call);
    finalizing = true;
    console.log(`PI_PLANNER_RESULT_ATTEMPT ${JSON.stringify({ resultAttempts, structuredCorrections, source: message ? 'pre_validation_message' : 'runtime' })}`);
    return call;
  }

  function admitPlannerResultCall(call) {
    if (call.admissionDecided) return call.allowed;
    call.admissionDecided = true;
    call.allowed = !resultSucceeded && !resultCallPending;
    if (call.allowed) {
      resultCallPending = true;
      recordPlannerResultState({ resultAttempts, structuredCorrections, repairStatus: 'finalizing' });
    }
    return call.allowed;
  }

  function recordPlannerResultRejection({
    repairKind,
    diagnostic,
    rawArguments,
    source = 'runtime',
    ctx = null,
  }) {
    structuredCorrections += 1;
    const failureSignature = plannerResultFailureSignature(repairKind, diagnostic, rawArguments);
    if (failureSignature === lastResultFailureSignature) equivalentResultFailureCount += 1;
    else {
      lastResultFailureSignature = failureSignature;
      equivalentResultFailureCount = 1;
    }

    recordPlannerResultState({
      resultAttempts,
      structuredCorrections,
      repairStatus: 'correction_required',
      repairDiagnostic: diagnostic,
      repairKind,
    });
    console.log(`PI_PLANNER_RESULT_REJECTION ${JSON.stringify({
      resultAttempts,
      structuredCorrections,
      kind: repairKind,
      source,
      equivalentNoProgress: equivalentResultFailureCount,
      diagnostic,
    })}`);

    if (equivalentResultFailureCount >= RESULT_EQUIVALENT_NO_PROGRESS_LIMIT) {
      recordPlannerResultState({
        resultAttempts,
        structuredCorrections,
        repairStatus: 'failed',
        repairDiagnostic: diagnostic,
        repairKind,
        failureKind: 'semantic_no_progress',
      });
      console.log(`PI_PLANNER_NO_PROGRESS ${JSON.stringify({
        kind: 'structured_output',
        resultAttempts,
        structuredCorrections,
        equivalentNoProgress: equivalentResultFailureCount,
      })}`);
      ctx?.abort?.();
      return false;
    }

    console.log(`PI_PLANNER_RESULT_CORRECTION ${JSON.stringify({
      resultAttempts,
      structuredCorrections,
      kind: repairKind,
    })}`);
    return true;
  }

  function preValidationRepairDiagnostic(rawArguments) {
    let args = rawArguments;
    if (typeof rawArguments === 'string') {
      try { args = JSON.parse(rawArguments); }
      catch {
        return 'structured_output arguments were rejected before runtime tool execution. Supply valid JSON with value as an object containing steps, facts, complexity, required_mutation_anchors, large_mutation, and reason.';
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, 'value')) {
      return 'structured_output was rejected before runtime tool execution: value is required and must be an object containing steps, facts, complexity, required_mutation_anchors, large_mutation, and reason.';
    }
    if (!args.value || typeof args.value !== 'object' || Array.isArray(args.value)) {
      return 'structured_output was rejected before runtime tool execution: value must be an object containing steps, facts, complexity, required_mutation_anchors, large_mutation, and reason.';
    }
    return 'structured_output arguments were rejected by schema validation before runtime tool execution. Correct only the reported result shape and retry structured_output.';
  }

  function reconcilePreValidationRejections(ctx = null) {
    let stopped = false;
    for (const call of observedResultCalls) {
      if (!call.message || call.admissionDecided || call.preValidationRejected || call.toolCallSeen || call.toolResultSeen) continue;
      call.preValidationRejected = true;
      const diagnostic = preValidationRepairDiagnostic(call.rawArguments);
      const canCorrect = recordPlannerResultRejection({
        repairKind: 'pre_validation_rejection',
        diagnostic,
        rawArguments: call.rawArguments,
        source: 'pre_validation_message',
        ctx,
      });
      if (!canCorrect) stopped = true;
    }
    return stopped;
  }

  recordEvidenceState({ used: 0 });
  console.log(`PI_PLANNER_CAT_WAITING ${JSON.stringify({ state: 'CAT_WAITING', event: 'start' })}`);

  pi.on('before_provider_request', (event, ctx) => {
    const payload = event?.payload;
    if (!finalizing || !payload) return payload;
    if (reconcilePreValidationRejections(ctx)) return payload;
    if (!Array.isArray(payload.tools)) return payload;
    const tools = payload.tools.filter(tool => (tool.function?.name ?? tool.name) === PLANNER_RESULT_TOOL);
    if (!tools.length) return payload;
    return { ...payload, tools, tool_choice: 'required' };
  });

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === PLANNER_RESULT_TOOL) {
      let observed = observedResultCalls.find(call => !call.preValidationRejected && !call.toolCallSeen && event.toolCallId && call.id === event.toolCallId);
      if (!observed) observed = observedResultCalls.find(call => !call.preValidationRejected && !call.toolCallSeen && !call.id);
      if (observed) observed.toolCallSeen = true;
      else {
        observed = observePlannerResultCall({ id: event.toolCallId ?? null });
        observed.toolCallSeen = true;
      }
      if (event.input && typeof event.input === 'object' && !Array.isArray(event.input)) {
        observed.rawArguments = structuredClone(event.input);
      }
      finalizing = true;
      if (typeof pi.setActiveTools === 'function') pi.setActiveTools([PLANNER_RESULT_TOOL]);
      if (!admitPlannerResultCall(observed)) {
        if (event.toolCallId) blockedResultCallIds.add(event.toolCallId);
        console.log(`PI_PLANNER_RESULT_DUPLICATE_BLOCKED ${JSON.stringify({ resultAttempts, reason: 'parallel_or_post_success_result' })}`);
        return { block: true, reason: 'Planner accepts one structured_output call at a time; wait for its validation result before correcting.' };
      }
      return undefined;
    }

    if (finalizing) {
      return { block: true, reason: 'Planner result finalization has started; repository evidence is closed.' };
    }

    let signature = null;
    if (PLANNER_EVIDENCE_TOOLS.includes(event.toolName)) {
      signature = plannerActionSignature(event.toolName, event.input);
      if (signature === lastEvidenceSignature && lastEvidenceMadeProgress === false) {
        const diagnostic = `Repeated equivalent ${event.toolName} action produced no new planning information.`;
        recordPlannerResultState({
          resultAttempts, structuredCorrections, repairStatus: 'failed',
          repairDiagnostic: diagnostic, failureKind: 'semantic_no_progress',
        });
        console.log(`PI_PLANNER_NO_PROGRESS ${JSON.stringify({ kind: 'evidence', tool: event.toolName, signature })}`);
        ctx?.abort?.();
        return { block: true, reason: `${diagnostic} Planner stopped by semantic no-progress protection.` };
      }
    }

    const admission = gate.admit(event.toolName);
    if (admission.evidence && admission.allowed) {
      recordEvidenceState(admission, { toolName: event.toolName });
      if (event.toolCallId) {
        pendingEvidence.set(event.toolCallId, { toolName: event.toolName, input: structuredClone(event.input ?? {}), admission, signature });
      }
      console.log(`PI_PLANNER_EVIDENCE ${JSON.stringify({ tool: event.toolName, action: admission.used })}`);
    }
    if (admission.allowed) return undefined;
    console.log(`PI_PLANNER_EVIDENCE_BLOCKED ${JSON.stringify({ tool: event.toolName, actions: admission.used })}`);
    return { block: true, reason: admission.reason };
  });

  pi.on('message_start', (event) => {
    if (event?.message?.role === 'assistant') streamedResultArguments = new Map();
  });

  pi.on('message_update', (event) => {
    const update = event?.assistantMessageEvent;
    if (update?.type !== 'toolcall_delta') return;
    const contentIndex = update.contentIndex;
    const block = update.partial?.content?.[contentIndex];
    if (block?.type !== 'toolCall' || block.name !== PLANNER_RESULT_TOOL) return;
    const key = block.id || `index:${contentIndex}`;
    streamedResultArguments.set(key, (streamedResultArguments.get(key) ?? '') + String(update.delta ?? ''));
  });

  pi.on('message_end', async (event, ctx) => {
    const message = event?.message;
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return;

    let sawAnyToolCall = false;
    let sawResultCall = false;
    for (let index = 0; index < message.content.length; index += 1) {
      const block = message.content[index];
      if (block?.type !== 'toolCall') continue;
      sawAnyToolCall = true;
      if (block.name !== PLANNER_RESULT_TOOL) continue;
      sawResultCall = true;
      const id = typeof block.id === 'string' && block.id ? block.id : null;
      if (id && observedResultCalls.some(call => !call.preValidationRejected && call.id === id)) continue;
      const key = id || `index:${index}`;
      const rawArguments = streamedResultArguments.has(key)
        ? streamedResultArguments.get(key)
        : Object.hasOwn(block, 'arguments') ? block.arguments : undefined;
      observePlannerResultCall({ id, rawArguments, message });
    }
    streamedResultArguments = new Map();

    if (sawAnyToolCall || sawResultCall || resultSucceeded || resultCallPending) return;
    const diagnostic = 'Assistant turn ended without calling structured_output.';
    if (!missingResultRecoveryUsed && !finalizing) {
      missingResultRecoveryUsed = true;
      finalizing = true;
      if (typeof pi.setActiveTools === 'function') pi.setActiveTools([PLANNER_RESULT_TOOL]);
      recordPlannerResultState({
        resultAttempts, structuredCorrections, repairStatus: 'correction_required',
        repairDiagnostic: diagnostic, repairKind: 'missing_structured_output',
      });
      console.log(`PI_PLANNER_RESULT_RECOVERY ${JSON.stringify({ kind: 'missing_structured_output', forced: true })}`);
      if (typeof pi.sendUserMessage === 'function') {
        await pi.sendUserMessage(
          'Your previous turn ended without structured_output. Repository evidence is now closed. Call structured_output now with the completed plan; do not answer with prose.',
          { deliverAs: 'steer' },
        );
      }
      return;
    }

    if (missingResultRecoveryUsed && finalizing) {
      recordPlannerResultState({
        resultAttempts, structuredCorrections, repairStatus: 'failed',
        repairDiagnostic: diagnostic, repairKind: 'missing_structured_output', failureKind: 'semantic_no_progress',
      });
      console.log(`PI_PLANNER_NO_PROGRESS ${JSON.stringify({ kind: 'missing_structured_output', repeated: true })}`);
      ctx?.abort?.();
    }
  });

  pi.on('tool_result', async (event, ctx) => {
    if (event?.toolName !== PLANNER_RESULT_TOOL) return undefined;
    if (event.toolCallId && blockedResultCallIds.delete(event.toolCallId)) return undefined;

    let observed = observedResultCalls.find(call => !call.preValidationRejected && !call.toolResultSeen && event.toolCallId && call.id === event.toolCallId);
    if (!observed && event.toolCallId) observed = observedResultCalls.find(call => !call.preValidationRejected && !call.toolResultSeen && !call.id);
    if (!observed) observed = observedResultCalls.find(call => !call.preValidationRejected && !call.toolResultSeen && call.toolCallSeen);
    if (!observed) observed = observePlannerResultCall({ id: event.toolCallId ?? null });
    observed.toolResultSeen = true;
    if (!admitPlannerResultCall(observed) || resultSucceeded) return undefined;
    resultCallPending = false;

    if (event.isError) {
      const rawArguments = observed.rawArguments;
      const diagnostic = plannerRepairDiagnostic(rawArguments, event);
      const rawArgumentsMalformed = typeof rawArguments === 'string' && (() => {
        try { JSON.parse(rawArguments); return false; } catch { return true; }
      })();
      const repairKind = rawArgumentsMalformed || /(?:unexpected end|unterminated|incomplete|invalid json|json parse|parse error)/i.test(diagnostic)
        ? 'malformed_arguments'
        : 'schema_rejection';
      const canCorrect = recordPlannerResultRejection({
        repairKind,
        diagnostic,
        rawArguments,
        source: 'runtime',
        ctx,
      });
      if (!canCorrect) {
        return { content: [{ type: 'text', text: `The same structured_output rejection repeated without material correction. Planner stopped by semantic no-progress protection. ${diagnostic}` }] };
      }
      return { content: [{ type: 'text', text: `structured_output was rejected by runtime validation. ${diagnostic} Repository evidence remains closed. Correct only the reported shape/serialization problem and call structured_output again.` }] };
    }

    const acceptedResult =
      event?.input?.value && typeof event.input.value === 'object' && !Array.isArray(event.input.value)
        ? structuredClone(event.input.value)
        : observed.rawArguments?.value && typeof observed.rawArguments.value === 'object' && !Array.isArray(observed.rawArguments.value)
          ? structuredClone(observed.rawArguments.value)
          : null;
    try {
      validateResolvedTargetPaths(acceptedResult, resolvedTargets);
    } catch (error) {
      const diagnostic = String(error?.message ?? error);
      const canCorrect = recordPlannerResultRejection({
        repairKind: 'resolved_target_mismatch',
        diagnostic,
        rawArguments: observed.rawArguments ?? event.input,
        source: 'runtime',
        ctx,
      });
      if (!canCorrect) {
        return { content: [{ type: 'text', text: `The same resolved-target mismatch repeated without material correction. Planner stopped by semantic no-progress protection. ${diagnostic}` }] };
      }
      return {
        content: [{
          type: 'text',
          text: `structured_output was rejected by runtime validation. ${diagnostic} Repository evidence remains closed. Keep the authoritative resolved target unchanged, correct only the conflicting returned path, and call structured_output again.`,
        }],
      };
    }

    resultSucceeded = true;
    const acceptedResultPersisted = recordPlannerResultState({
      resultAttempts,
      structuredCorrections,
      repairStatus: 'accepted',
      acceptedResult,
    });
    console.log(`PI_PLANNER_RESULT_SUCCESS ${JSON.stringify({ resultAttempts, structuredCorrections })}`);
    console.log(`PI_PLANNER_CAT_PETTED ${JSON.stringify({ state: 'CAT_PETTED', event: 'accepted', message: '🐈 You pet the cat. Planner complete.' })}`);
    // Abort only when the accepted result is durably recoverable from the sidecar. If persistence
    // failed, leave the successful structured_output lifecycle intact so pi-subagents can deliver
    // the accepted result directly without another provider request.
    if (acceptedResultPersisted) ctx?.abort?.();
    return undefined;
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    const pending = event.toolCallId ? pendingEvidence.get(event.toolCallId) : null;
    if (event.toolCallId) pendingEvidence.delete(event.toolCallId);
    if (!pending) return;
    const fact = event.isError ? null : plannerEvidenceFact(pending.toolName, pending.input, event.result);
    const madeProgress = Boolean(fact && !knownFacts.has(fact));
    if (madeProgress) {
      consecutiveNoProgressEvidence = 0;
      knownFacts.add(fact);
      recordEvidenceState(pending.admission, { fact, toolName: pending.toolName });
      console.log(`PI_PLANNER_EVIDENCE_FACT ${JSON.stringify({ tool: pending.toolName, fact })}`);
      console.log(`PI_PLANNER_CAT_WAITING ${JSON.stringify({ state: 'CAT_WAITING', event: 'progress' })}`);
      if (typeof pi.sendUserMessage === 'function') {
        await pi.sendUserMessage(
          '🐈 The cat is still waiting to be petted. Finish the plan as soon as you have enough evidence.',
          { deliverAs: 'steer' },
        );
      }
    } else {
      consecutiveNoProgressEvidence += 1;
      if (consecutiveNoProgressEvidence >= EVIDENCE_NO_PROGRESS_STREAK_LIMIT) {
        const diagnostic = `${consecutiveNoProgressEvidence} consecutive repository actions produced no new compact planning fact.`;
        recordPlannerResultState({
          resultAttempts, structuredCorrections, repairStatus: 'failed',
          repairDiagnostic: diagnostic, failureKind: 'semantic_no_progress',
        });
        console.log(`PI_PLANNER_NO_PROGRESS ${JSON.stringify({
          kind: 'evidence_streak', actions: pending.admission.used, consecutiveNoProgressEvidence,
        })}`);
        ctx?.abort?.();
      }
    }
    lastEvidenceSignature = pending.signature;
    lastEvidenceMadeProgress = madeProgress;
  });
}
function safeDiagnostic(event, maxLength = 400) {
  const pieces = [];
  for (const value of [event?.details, event?.content]) {
    if (typeof value === 'string') pieces.push(value);
    else if (Array.isArray(value)) pieces.push(value.map(item => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join(' '));
    else if (value && typeof value === 'object') pieces.push(JSON.stringify(value));
  }
  return sanitizeDiagnosticText(pieces.join(' '), maxLength)
    || 'The tool arguments failed schema validation; preserve the existing plan and facts.';
}

function plannerRepairDiagnostic(rawArguments, event) {
  // Reserve space for both channels. Put Pi's actionable validation error first, and bound the
  // argument preview independently so a large but valid JSON object cannot erase the error.
  const validation = safeDiagnostic(event, 220);
  const argumentText = typeof rawArguments === 'string'
    ? rawArguments
    : rawArguments === undefined ? '' : JSON.stringify(rawArguments);
  const argumentPreview = argumentText ? sanitizeDiagnosticText(argumentText, 150) : '';
  return `${validation}${argumentPreview ? ` | arguments preview: ${argumentPreview}` : ''}`.slice(0, 400);
}

function sanitizeDiagnosticText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted pem]')
    .replace(/\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{12,}\b/g, '[redacted credential]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s]+)/gi, '$1[redacted]')
    .slice(0, maxLength);
}

function recordPlannerResultState({
  resultAttempts,
  structuredCorrections = 0,
  repairStatus,
  repairDiagnostic = null,
  repairKind = null,
  failureKind = null,
  acceptedResult = null,
}) {
  const file = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  if (!file) return false;
  try {
    let previous = {};
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* state is initialized above */ }
    const next = { ...previous, resultAttempts, structuredCorrections };
    if (repairStatus) next.repairStatus = repairStatus;
    if (repairDiagnostic) next.repairDiagnostic = sanitizeDiagnosticText(repairDiagnostic, 400);
    if (repairKind) next.repairKind = repairKind;
    if (failureKind) next.failureKind = failureKind;
    if (acceptedResult && typeof acceptedResult === 'object' && !Array.isArray(acceptedResult)) {
      next.acceptedResult = structuredClone(acceptedResult);
    }
    fs.writeFileSync(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    console.warn(`PI_PLANNER_EVIDENCE_STATE_FAILED ${JSON.stringify({ error: String(error?.message ?? error) })}`);
    return false;
  }
}
