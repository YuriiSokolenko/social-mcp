// Session-local response ceiling provenance. Never use process.env for phase transitions.
// Pi extension instances are distinct per child session; WeakMap also prevents collisions
// in an in-process/concurrent test harness.
const originalModelLimits = new WeakMap();
export function rememberPlannerModelLimit(pi, maxTokens) {
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) originalModelLimits.set(pi, maxTokens);
}
export function plannerModelLimit(pi) {
  return originalModelLimits.get(pi) ?? null;
}
export function plannerBudgetSupported(pi, requested) {
  const limit = plannerModelLimit(pi);
  return Number.isSafeInteger(requested) && requested > 0 && limit !== null && limit >= requested;
}
