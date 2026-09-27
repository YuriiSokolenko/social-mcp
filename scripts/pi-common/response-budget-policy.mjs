// Per-turn model output budgets. Task complexity controls how much work the agent
// may explore; this policy controls how verbose one model response may be.
export const RESPONSE_BUDGETS = Object.freeze({
  short: 2048,
  normal: 4096,
  deep: 8192,
});

export function responseBudget(level) {
  const maxTokens = RESPONSE_BUDGETS[level];
  if (!maxTokens) throw new Error(`Unknown response budget: ${level}`);
  return maxTokens;
}

export function withResponseBudget(model, level) {
  if (!model) throw new Error('Cannot set a response budget without an active model');
  return { ...model, maxTokens: responseBudget(level) };
}
