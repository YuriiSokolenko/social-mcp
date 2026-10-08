import fs from 'node:fs';

// Session-local response ceiling provenance. Never use process.env for phase transitions.
// Pi extension instances are distinct per child session; WeakMap also prevents collisions
// in an in-process/concurrent test harness.
const originalModelLimits = new WeakMap();
export function rememberPlannerModelLimit(pi, maxTokens) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) return;
  originalModelLimits.set(pi, maxTokens);
  // Pi may give each extension a different API object. Its child-unique state file is the
  // shared session identity, not a process-global model budget or a singleton variable.
  const file = process.env.PI_PLANNER_EVIDENCE_STATE_FILE;
  if (!file) return;
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new session */ }
  fs.writeFileSync(file, JSON.stringify({ ...previous, originalModelMaxTokens: maxTokens }) + '\\n', { mode: 0o600 });
}
export function plannerModelLimit(pi) {
  const file = process.env.PI_PLANNER_EVIDENCE_STATE_FILE;
  if (file) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')).originalModelMaxTokens;
      if (Number.isSafeInteger(value) && value > 0) return value;
    } catch { /* no persisted limit */ }
  }
  return originalModelLimits.get(pi) ?? null;
}
export function plannerBudgetSupported(pi, requested) {
  const limit = plannerModelLimit(pi);
  return Number.isSafeInteger(requested) && requested > 0 && limit !== null && limit >= requested;
}
