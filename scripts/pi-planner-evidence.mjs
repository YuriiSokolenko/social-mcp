import fs from 'node:fs';

import { Type } from 'typebox';

import { repoSearch } from './pi-common/repo-search.mjs';
import {
  PLANNER_CODE_GRAPH_RELATIONS,
  plannerCodeGraph,
} from './pi-common/planner-code-graph.mjs';

// Loaded only inside the implementation-planner pi-subagents child via .pi/settings.json.
// Enforces the trusted planner evidence cap and read-only surface at tool-call time, so the
// planner cannot explore past its budget or call anything but the allowlisted evidence tools.
// The cap arrives from the bootstrap (stage config) through the child environment.
import {
  PLANNER_EVIDENCE_BUDGET_ENV,
  PLANNER_EVIDENCE_STATE_FILE_ENV,
  PLANNER_OUTPUT_ONLY_ENV,
  PLANNER_RESULT_TOOL,
  PLANNER_CUSTOM_EVIDENCE_TOOLS,
  MAX_PLANNER_FACTS,
  createPlannerEvidenceGate,
  plannerEvidenceFact,
} from './pi-common/implementation-planner.mjs';

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

function registerPlannerEvidenceTools(pi) {
  if (typeof pi.registerTool !== 'function') {
    throw new Error('Planner evidence extension requires trusted tool registration');
  }

  pi.registerTool({
    name: 'repo_search',
    label: 'Repository search',
    description: 'Read-only deterministic search over tracked paths/content in the current Planner worktree. Use when the exact path or text location is unknown.',
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('path')])),
      query: Type.String({ minLength: 1, maxLength: 300 }),
      pathPrefix: Type.Optional(Type.String({ maxLength: 300 })),
      extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 12 })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = repoSearch(ctx?.cwd ?? process.cwd(), params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: 'planner_code_graph',
    label: 'Planner code graph',
    description: 'Read-only bounded relationship lookup in the fresh Orbit Local index for this Planner worktree. Use only for one concrete target/question about callers, references, implementations, dependencies, related tests, or blast radius.',
    parameters: Type.Object({
      relation: Type.Union(PLANNER_CODE_GRAPH_RELATIONS.map(relation => Type.Literal(relation))),
      target: Type.String({ minLength: 1, maxLength: 300 }),
      question: Type.String({ minLength: 1, maxLength: 300 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = plannerCodeGraph(ctx?.cwd ?? process.cwd(), params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}

export default function (pi) {
  registerPlannerEvidenceTools(pi);
  const registered = new Set(PLANNER_CUSTOM_EVIDENCE_TOOLS);
  if (registered.size !== PLANNER_CUSTOM_EVIDENCE_TOOLS.length) {
    throw new Error('Planner custom evidence tool contract contains duplicate names');
  }

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

  if (outputOnly) {
    // Replace the normal agent prompt for the retry so the provider is not told that repository
    // evidence tools exist after the lifecycle has closed them.
    pi.on('before_agent_start', () => ({
      systemPrompt: `You are the Social MCP implementation planner on an output-only retry.

Repository evidence is closed. Only structured_output is available. Do not inspect the repository or attempt any other tool. Use the issue plus preserved facts from the retry task, correct only the result envelope/schema, and call structured_output immediately. Return no prose.`,
    }));
  }
}
