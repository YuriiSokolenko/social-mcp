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
  createPlannerEvidenceGate,
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

function recordEvidenceState(gate, admission, env = process.env) {
  const file = env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  if (!file) return;
  try {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first attempt / inaccessible prior state */ }
    const previousUsed = Number.isSafeInteger(previous?.used) && previous.used >= 0 ? previous.used : 0;
    const previousCap = Number.isSafeInteger(previous?.cap) && previous.cap >= 0 ? previous.cap : 0;
    // The same sidecar spans structured-output retries. A retry receives cap=0 and must never
    // erase evidence already spent by the first attempt.
    const state = { used: Math.max(previousUsed, admission.used), cap: Math.max(previousCap, gate.cap) };
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn(`PI_PLANNER_EVIDENCE_STATE_FAILED ${JSON.stringify({ error: String(error?.message ?? error) })}`);
  }
}

export default function (pi) {
  const outputOnly = plannerOutputOnly();
  const gate = createPlannerEvidenceGate(evidenceBudget());
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

  pi.on('tool_call', async (event) => {
    if (outputOnly && event.toolName !== PLANNER_RESULT_TOOL) {
      console.log(`PI_PLANNER_EVIDENCE_BLOCKED ${JSON.stringify({ tool: event.toolName, used: 0, cap: 0, outputOnly: true })}`);
      return { block: true, reason: 'Planner retry is output-only; repository evidence is closed. Call structured_output now.' };
    }
    const admission = gate.admit(event.toolName);
    if (admission.evidence && admission.allowed) {
      recordEvidenceState(gate, admission);
      console.log(`PI_PLANNER_EVIDENCE ${JSON.stringify({ tool: event.toolName, used: admission.used, remaining: admission.remaining })}`);
    }
    if (admission.allowed) return undefined;
    console.log(`PI_PLANNER_EVIDENCE_BLOCKED ${JSON.stringify({ tool: event.toolName, used: admission.used, cap: gate.cap })}`);
    return { block: true, reason: admission.reason };
  });
}
