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

export default function (pi) {
  registerPlannerEvidenceTools(pi);

  const gate = createPlannerEvidenceGate();
  const pendingEvidence = new Map();
  const knownFacts = new Set();
  let finalizing = false;
  let evidenceProgressContinuationPending = false;
  let lastEvidenceSignature = null;
  let lastEvidenceMadeProgress = true;
  let consecutiveNoProgressEvidence = 0;

  const closeForFinalization = (source) => {
    if (finalizing) return;
    finalizing = true;
    if (evidenceProgressContinuationPending) {
      evidenceProgressContinuationPending = false;
      console.log(`PI_PLANNER_EVIDENCE_CONTINUATION ${JSON.stringify({ action: 'cancelled', source })}`);
    }
    if (typeof pi.setActiveTools === 'function') pi.setActiveTools([]);
    console.log(`PI_PLANNER_FINALIZATION_TRANSITION ${JSON.stringify({ from: 'planning', to: 'finalizing', source })}`);
  };

  recordEvidenceState({ used: 0 });
  console.log(`PI_PLANNER_CAT_WAITING ${JSON.stringify({ state: 'CAT_WAITING', event: 'start' })}`);
  pi.on('before_provider_request', (event) => {
    const payload = event?.payload;
    if (!finalizing) return payload;
    if (!payload) return payload;
    // The repair child may be loaded before Pi has bound the session. Deactivate tools only
    // once a provider request is actually being built, then omit tool fields entirely so
    // OpenAI-compatible backends never receive an empty tools array.
    if (typeof pi.setActiveTools === 'function') pi.setActiveTools([]);
    const { tools: _tools, tool_choice: _toolChoice, ...withoutTools } = payload;
    return withoutTools;
  });

  pi.on('tool_call', async (event, ctx) => {
    if (finalizing) {
      return { block: true, reason: 'Planner finalization has started; repository evidence is closed.' };
    }

    let signature = null;
    if (PLANNER_EVIDENCE_TOOLS.includes(event.toolName)) {
      signature = plannerActionSignature(event.toolName, event.input);
      if (signature === lastEvidenceSignature && lastEvidenceMadeProgress === false) {
        const diagnostic = `Repeated equivalent ${event.toolName} action produced no new planning information.`;
        recordEvidenceFailure({ failureKind: 'semantic_no_progress', diagnostic });
        console.log(`PI_PLANNER_NO_PROGRESS ${JSON.stringify({ kind: 'evidence', tool: event.toolName, signature })}`);
        ctx?.abort?.();
        return { block: true, reason: `${diagnostic} Planner stopped by semantic no-progress protection.` };
      }
    }

    const admission = gate.admit(event.toolName);
    if (admission.evidence && admission.allowed) {
      recordEvidenceState(admission, { toolName: event.toolName });
      if (event.toolCallId) {
        pendingEvidence.set(event.toolCallId, {
          toolName: event.toolName,
          input: structuredClone(event.input ?? {}),
          admission,
          signature,
        });
      }
      console.log(`PI_PLANNER_EVIDENCE ${JSON.stringify({ tool: event.toolName, action: admission.used })}`);
    }
    if (admission.allowed) return undefined;
    console.log(`PI_PLANNER_EVIDENCE_BLOCKED ${JSON.stringify({ tool: event.toolName, actions: admission.used })}`);
    return { block: true, reason: admission.reason };
  });

  pi.on('message_end', (event) => {
    const message = event?.message;
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
    if (message.content.some(block => block?.type === 'toolCall')) return;
    const text = message.content
      .map(block => typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : '')
      .join('')
      .trim();
    if (text) closeForFinalization('assistant_content');
  });

  pi.on('turn_end', (event) => {
    if (finalizing) {
      evidenceProgressContinuationPending = false;
      return undefined;
    }
    if (!evidenceProgressContinuationPending) return undefined;

    evidenceProgressContinuationPending = false;
    console.log(`PI_PLANNER_EVIDENCE_CONTINUATION ${JSON.stringify({ action: 'delivered', source: 'turn_end' })}`);
    return {
      entries: [
        ...(Array.isArray(event?.entries) ? event.entries : []),
        {
          type: 'custom_message',
          customType: 'planner-evidence-progress',
          content: '🐈 The cat is still waiting to be petted. Finish the plan as soon as you have enough evidence.',
          display: false,
        },
      ],
      continue: true,
    };
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
      if (!finalizing && !evidenceProgressContinuationPending) {
        // Defer the reminder to the turn_end lifecycle boundary instead of Pi's steer queue.
        // That keeps one continuation per evidence-producing turn while allowing terminal
        // assistant content to invalidate it before another provider request can be scheduled.
        evidenceProgressContinuationPending = true;
        console.log(`PI_PLANNER_EVIDENCE_CONTINUATION ${JSON.stringify({ action: 'queued', source: 'evidence_progress' })}`);
      }
    } else {
      consecutiveNoProgressEvidence += 1;
      if (consecutiveNoProgressEvidence >= EVIDENCE_NO_PROGRESS_STREAK_LIMIT) {
        const diagnostic = `${consecutiveNoProgressEvidence} consecutive repository actions produced no new compact planning fact.`;
        recordEvidenceFailure({ failureKind: 'semantic_no_progress', diagnostic });
        console.log(`PI_PLANNER_NO_PROGRESS ${JSON.stringify({
          kind: 'evidence_streak',
          actions: pending.admission.used,
          consecutiveNoProgressEvidence,
        })}`);
        ctx?.abort?.();
      }
    }
    lastEvidenceSignature = pending.signature;
    lastEvidenceMadeProgress = madeProgress;
  });
}

function sanitizeDiagnosticText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted pem]')
    .replace(/\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{12,}\b/g, '[redacted credential]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s]+)/gi, '$1[redacted]')
    .slice(0, maxLength);
}
