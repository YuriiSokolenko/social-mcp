import fs from 'node:fs';

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
    const state = {
      used: Math.max(previousUsed, admission.used), cap: Math.max(previousCap, gate.cap), facts,
      ...(previous?.repairStatus ? { repairStatus: previous.repairStatus } : {}),
      ...(previous?.resultAttempts ? { resultAttempts: previous.resultAttempts } : {}),
      ...(previous?.repairDiagnostic ? { repairDiagnostic: previous.repairDiagnostic } : {}),
      ...(previous?.repairKind ? { repairKind: previous.repairKind } : {}),
      ...(previous?.repairFailureKind ? { repairFailureKind: previous.repairFailureKind } : {}),
    };
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn(`PI_PLANNER_EVIDENCE_STATE_FAILED ${JSON.stringify({ error: String(error?.message ?? error) })}`);
  }
}

export default function (pi) {
  const outputOnly = plannerOutputOnly();
  let repairActive = false;
  let repairAttempted = false;
  let resultAttempts = 0;
  let resultSubmitted = false;
  let resultCallPending = false;
  let resultSucceeded = false;
  const blockedResultCallIds = new Set();
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

  pi.on('before_provider_request', (event) => {
    const payload = event?.payload;
    if (!payload || !Array.isArray(payload.tools)) return payload;
    if (!repairActive && !outputOnly) return { ...payload, parallel_tool_calls: false };
    const tools = payload.tools.filter(tool => (tool.function?.name ?? tool.name) === PLANNER_RESULT_TOOL);
    if (!tools.length) return payload;
    return {
      ...payload,
      tools,
      tool_choice: 'required',
      parallel_tool_calls: false,
      chat_template_kwargs: { ...(payload.chat_template_kwargs ?? {}), enable_thinking: false },
    };
  });

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === PLANNER_RESULT_TOOL) {
      resultAttempts += 1;
      resultSubmitted = true;
      resultCallPending = true;
      if (outputOnly && resultAttempts > 1) {
        if (!resultSucceeded) {
          const diagnostic = 'Output-only Planner recovery attempted structured_output more than once.';
          recordPlannerResultState({ resultAttempts, repairStatus: 'failed', repairDiagnostic: diagnostic, repairKind: 'output_only_attempt_limit' });
        }
        console.log(`PI_PLANNER_RESULT_REPAIR_FAILURE ${JSON.stringify({ resultAttempts, repairAttempts: 0, reason: resultSucceeded ? 'extra_result_after_success' : 'output_only_second_result_blocked' })}`);
        if (event.toolCallId) blockedResultCallIds.add(event.toolCallId);
        if (!resultSucceeded) ctx?.abort?.();
        return { block: true, reason: 'Output-only Planner recovery allows exactly one structured_output call.' };
      }
      if (!repairActive && !outputOnly && resultAttempts > 1) {
        console.log(`PI_PLANNER_RESULT_REPAIR_FAILURE ${JSON.stringify({ resultAttempts, repairAttempts: 0, reason: 'first_attempt_second_result_blocked' })}`);
        if (event.toolCallId) blockedResultCallIds.add(event.toolCallId);
        if (!resultSucceeded) ctx?.abort?.();
        return { block: true, reason: 'Planner allows one initial structured_output call before repair.' };
      }
      if (repairActive && repairAttempted) {
        console.log(`PI_PLANNER_RESULT_REPAIR_FAILURE ${JSON.stringify({ resultAttempts, repairAttempts: 1, reason: 'second_result_call_blocked' })}`);
        if (event.toolCallId) blockedResultCallIds.add(event.toolCallId);
        return { block: true, reason: 'Planner result repair is limited to one structured_output attempt; stop now.' };
      }
      if (repairActive) repairAttempted = true;
      console.log(`PI_PLANNER_RESULT_ATTEMPT ${JSON.stringify({ resultAttempts, repair: repairActive })}`);
      recordPlannerResultState({ resultAttempts, repairStatus: repairActive ? 'started' : null });
      return undefined;
    }
    if (resultSubmitted) {
      return { block: true, reason: 'Planner result finalization has started; repository evidence is closed.' };
    }
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

  pi.on('tool_result', async (event, ctx) => {
    if (event?.toolName !== PLANNER_RESULT_TOOL) return undefined;
    if (event.toolCallId && blockedResultCallIds.delete(event.toolCallId)) {
      resultCallPending = false;
      return undefined;
    }
    if (resultSucceeded) return undefined;
    resultSubmitted = true;
    if (resultCallPending) resultCallPending = false;
    else {
      resultAttempts += 1;
      console.log(`PI_PLANNER_RESULT_ATTEMPT ${JSON.stringify({ resultAttempts, repair: repairActive, source: 'tool_result_without_tool_call' })}`);
      recordPlannerResultState({ resultAttempts, repairStatus: repairActive ? 'started' : null });
    }
    if (event.isError) {
      const diagnostic = safeDiagnostic(event);
      const repairKind = /(?:unexpected end|unterminated|incomplete|invalid json|json parse|parse error)/i.test(diagnostic)
        ? 'malformed_arguments'
        : 'schema_rejection';
      if (!repairActive && !outputOnly) {
        repairActive = true;
        if (typeof pi.setActiveTools === 'function') pi.setActiveTools([PLANNER_RESULT_TOOL]);
        recordPlannerResultState({ resultAttempts, repairStatus: 'started', repairDiagnostic: diagnostic, repairKind });
        console.log(`PI_PLANNER_RESULT_REJECTION ${JSON.stringify({ resultAttempts, repairAttempts: 0, kind: repairKind, diagnostic })}`);
        console.log(`PI_PLANNER_RESULT_REPAIR_STARTED ${JSON.stringify({ resultAttempts, repairAttempts: 1, kind: repairKind })}`);
        return { content: [{ type: 'text', text: `The structured_output call was rejected by runtime validation. ${diagnostic} Make exactly one corrected structured_output call now. Do not call repository tools.` }] };
      }
      recordPlannerResultState({ resultAttempts, repairStatus: 'failed', repairDiagnostic: diagnostic, repairKind });
      console.log(`PI_PLANNER_RESULT_REPAIR_FAILURE ${JSON.stringify({ resultAttempts, repairAttempts: 1, kind: repairKind, diagnostic })}`);
      // Abort this child after the one repair rejection. The parent can use its bounded
      // output-only retry/fallback; the child never gets a third result-tool turn.
      ctx?.abort?.();
      return { content: [{ type: 'text', text: `The single structured_output repair was rejected. ${diagnostic} Stop; do not retry.` }] };
    }
    resultSucceeded = true;
    console.log(`PI_PLANNER_RESULT_SUCCESS ${JSON.stringify({ resultAttempts, repairAttempts: repairAttempted ? 1 : 0 })}`);
    recordPlannerResultState({ resultAttempts, repairStatus: repairActive ? 'succeeded' : 'first_call_succeeded' });
    return undefined;
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

function safeDiagnostic(event) {
  const pieces = [];
  for (const value of [event?.details, event?.content]) {
    if (typeof value === 'string') pieces.push(value);
    else if (Array.isArray(value)) pieces.push(value.map(item => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join(' '));
    else if (value && typeof value === 'object') pieces.push(JSON.stringify(value));
  }
  const diagnostic = pieces.join(' ').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (diagnostic || 'The tool arguments failed schema validation; preserve the existing plan and facts.')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted pem]')
    .replace(/\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{12,}\b/g, '[redacted credential]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s]+)/gi, '$1[redacted]')
    .slice(0, 400);
}

function recordPlannerResultState({ resultAttempts, repairStatus, repairDiagnostic = null, repairKind = null }) {
  const file = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  if (!file) return;
  try {
    let previous = {};
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* state is initialized above */ }
    const next = { ...previous, resultAttempts };
    if (repairStatus) next.repairStatus = repairStatus;
    if (repairDiagnostic) {
      const combined = previous.repairDiagnostic && !previous.repairDiagnostic.includes(repairDiagnostic)
        ? `${previous.repairDiagnostic} | ${repairDiagnostic}`
        : repairDiagnostic;
      next.repairDiagnostic = combined.slice(0, 400);
    }
    if (repairKind && !next.repairKind) next.repairKind = repairKind;
    if (repairKind && repairStatus === 'failed') next.repairFailureKind = repairKind;
    fs.writeFileSync(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn(`PI_PLANNER_EVIDENCE_STATE_FAILED ${JSON.stringify({ error: String(error?.message ?? error) })}`);
  }
}
