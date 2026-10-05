import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Type } from 'typebox';

import { repoSearch } from './pi-common/repo-search.mjs';

// Loaded only inside the implementation-planner pi-subagents child via .pi/settings.json.
// Enforces the trusted planner evidence cap and read-only surface at tool-call time, so the
// planner cannot explore past its budget or call anything but the allowlisted evidence tools.
// The cap arrives from the bootstrap (stage config) through the child environment.
import {
  PLANNER_EVIDENCE_BUDGET_ENV,
  PLANNER_EVIDENCE_STATE_FILE_ENV,
  PLANNER_OUTPUT_ONLY_ENV,
  PLANNER_RESULT_TOOL,
  MAX_PLANNER_FACTS,
  createPlannerEvidenceGate,
  plannerEvidenceFact,
} from './pi-common/implementation-planner.mjs';

const PLANNER_GRAPH_MAX_CHARS = 16000;
const PLANNER_GRAPH_COMMAND_TIMEOUT_MS = 5000;

function plannerOutputOnly(env = process.env) {
  return env[PLANNER_OUTPUT_ONLY_ENV] === 'true';
}

function evidenceBudget(env = process.env) {
  const value = Number(env[PLANNER_EVIDENCE_BUDGET_ENV]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${PLANNER_EVIDENCE_BUDGET_ENV} must be a non-negative integer`);
  }
  return value;
}

function localCommand(command, args, cwd, execFile = execFileSync) {
  return execFile(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: PLANNER_GRAPH_COMMAND_TIMEOUT_MS,
    maxBuffer: 512 * 1024,
    env: { ...process.env, ORBIT_TELEMETRY_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function canonicalPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function boundedGraphText(text) {
  const value = String(text ?? '').trim();
  if (value.length <= PLANNER_GRAPH_MAX_CHARS) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, PLANNER_GRAPH_MAX_CHARS)}\n[planner_code_graph output truncated]`,
    truncated: true,
  };
}

export function plannerCodeGraph(cwd, params, { execFile = execFileSync } = {}) {
  const target = String(params?.target ?? '').trim();
  const question = String(params?.question ?? '').trim();
  if (!target || target.length > 400 || target.startsWith('-') || /[\u0000-\u001f\u007f]/.test(target)) {
    throw new Error('planner_code_graph target must be one concrete symbol/path target (1-400 printable characters)');
  }
  if (!question || question.length > 400 || /[\u0000-\u001f\u007f]/.test(question)) {
    throw new Error('planner_code_graph question must be one concise planning question (1-400 printable characters)');
  }

  const root = canonicalPath(cwd);
  let head;
  let rows;
  try {
    head = String(localCommand('git', ['rev-parse', 'HEAD'], cwd, execFile)).trim();
    rows = JSON.parse(localCommand('orbit', ['list', '-F', 'json'], cwd, execFile));
  } catch (error) {
    throw new Error(`planner_code_graph unavailable: ${String(error?.message ?? error).split('\n')[0]}`);
  }

  const indexed = Array.isArray(rows)
    ? rows.find(row => canonicalPath(row?.repo_path) === root)
    : null;
  if (!indexed) {
    throw new Error('planner_code_graph unavailable: current worktree is not present in the Orbit index');
  }
  if (indexed.status !== 'indexed') {
    throw new Error(`planner_code_graph unavailable: Orbit index status is ${String(indexed.status ?? 'unknown')}`);
  }
  if (!head || String(indexed.commit_sha ?? '') !== head) {
    throw new Error('planner_code_graph unavailable: Orbit index is stale for the current worktree HEAD');
  }

  let raw;
  try {
    raw = localCommand('orbit', ['context', target], cwd, execFile);
  } catch (error) {
    throw new Error(`planner_code_graph query failed: ${String(error?.message ?? error).split('\n')[0]}`);
  }
  const bounded = boundedGraphText(raw);
  return {
    target,
    question,
    text: bounded.text,
    truncated: bounded.truncated,
  };
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
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('path')])),
      query: Type.String({ minLength: 1, maxLength: 300 }),
      pathPrefix: Type.Optional(Type.String({ maxLength: 300 })),
      extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 12 })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = repoSearchFn(ctx.cwd, params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: 'planner_code_graph',
    label: 'Planner code graph',
    description: 'Read-only bounded structural context for one concrete symbol/path in the current trusted Orbit index. Use for callers, references, implementations, dependencies, related tests, or blast-radius questions.',
    parameters: Type.Object({
      target: Type.String({ minLength: 1, maxLength: 400 }),
      question: Type.String({ minLength: 1, maxLength: 400 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = plannerCodeGraphFn(ctx.cwd, params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}

function recordEvidenceState(gate, admission, { fact = null, env = process.env } = {}) {
  const file = env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  if (!file) return;
  try {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first attempt / inaccessible prior state */ }
    const previousUsed = Number.isSafeInteger(previous?.used) && previous.used >= 0 ? previous.used : 0;
    const previousCap = Number.isSafeInteger(previous?.cap) && previous.cap >= 0 ? previous.cap : 0;
    const previousFacts = Array.isArray(previous?.facts)
      ? previous.facts.filter(item => typeof item === 'string' && item.trim()).slice(0, MAX_PLANNER_FACTS)
      : [];
    const facts = [...previousFacts];
    if (fact && !facts.includes(fact) && facts.length < MAX_PLANNER_FACTS) facts.push(fact);
    // The same sidecar spans structured-output retries. A retry receives cap=0 and must never
    // erase evidence or bounded facts already captured by the first attempt.
    const state = { used: Math.max(previousUsed, admission.used), cap: Math.max(previousCap, gate.cap), facts };
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn(`PI_PLANNER_EVIDENCE_STATE_FAILED ${JSON.stringify({ error: String(error?.message ?? error) })}`);
  }
}

export default function (pi) {
  registerPlannerEvidenceTools(pi);

  const outputOnly = plannerOutputOnly();
  const gate = createPlannerEvidenceGate(evidenceBudget());
  const pendingEvidence = new Map();
  // Write an explicit zero before any evidence call. If the child cannot see/write the
  // parent's sidecar path, the parent reports evidenceUsed=null rather than a false zero.
  recordEvidenceState(gate, { used: 0 });

  if (outputOnly) {
    // Best-effort UX hardening: when pi exposes active-tool control in the child, hide the
    // repository evidence tools entirely on retry. The call-time gate below remains authoritative
    // if the result tool is not visible yet at resources_discover.
    pi.on('resources_discover', async () => {
      const active = typeof pi.getActiveTools === 'function' ? pi.getActiveTools() : null;
      if (Array.isArray(active) && active.includes(PLANNER_RESULT_TOOL) && typeof pi.setActiveTools === 'function') {
        pi.setActiveTools([PLANNER_RESULT_TOOL]);
        console.log(`PI_PLANNER_OUTPUT_ONLY_SURFACE ${JSON.stringify({ active: [PLANNER_RESULT_TOOL] })}`);
      } else {
        console.warn(`PI_PLANNER_OUTPUT_ONLY_SURFACE ${JSON.stringify({ active: null, fallback: 'tool_call_gate' })}`);
      }
    });
  }

  if (outputOnly) {
    pi.on('before_provider_request', (event) => {
      const payload = event?.payload;
      if (!payload || !Array.isArray(payload.tools)) return payload;
      const tools = payload.tools.filter(tool => (tool.function?.name ?? tool.name) === PLANNER_RESULT_TOOL);
      if (!tools.length) return payload;
      return { ...payload, tools, tool_choice: 'required' };
    });
  }

  pi.on('tool_call', async (event) => {
    if (outputOnly && event.toolName !== PLANNER_RESULT_TOOL) {
      console.log(`PI_PLANNER_EVIDENCE_BLOCKED ${JSON.stringify({ tool: event.toolName, used: 0, cap: 0, outputOnly: true })}`);
      return { block: true, reason: 'Planner retry is output-only; repository evidence is closed. Call structured_output now.' };
    }
    const admission = gate.admit(event.toolName);
    if (admission.evidence && admission.allowed) {
      recordEvidenceState(gate, admission);
      if (event.toolCallId) pendingEvidence.set(event.toolCallId, { toolName: event.toolName, input: structuredClone(event.input ?? {}), admission });
      console.log(`PI_PLANNER_EVIDENCE ${JSON.stringify({ tool: event.toolName, used: admission.used, remaining: admission.remaining })}`);
    }
    if (admission.allowed) return undefined;
    console.log(`PI_PLANNER_EVIDENCE_BLOCKED ${JSON.stringify({ tool: event.toolName, used: admission.used, cap: gate.cap })}`);
    return { block: true, reason: admission.reason };
  });

  pi.on('tool_execution_end', async (event) => {
    const pending = event.toolCallId ? pendingEvidence.get(event.toolCallId) : null;
    if (event.toolCallId) pendingEvidence.delete(event.toolCallId);
    if (!pending || event.isError) return;
    const fact = plannerEvidenceFact(pending.toolName, pending.input, event.result);
    if (!fact) return;
    recordEvidenceState(gate, pending.admission, { fact });
    console.log(`PI_PLANNER_EVIDENCE_FACT ${JSON.stringify({ tool: pending.toolName, fact })}`);
  });
}
