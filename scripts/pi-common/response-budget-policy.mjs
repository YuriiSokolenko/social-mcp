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

export function nextResponseBudgetLevel(currentLevel, outputTokens, budgets = RESPONSE_BUDGETS, { madeProgress = false } = {}) {
  const ceiling = budgets[currentLevel];
  if (!ceiling) throw new Error(`Unknown response budget: ${currentLevel}`);
  if (!Number.isFinite(outputTokens) || outputTokens < 0) throw new Error('outputTokens must be a non-negative number');

  if (outputTokens < ceiling) return 'short';
  // A ceiling hit by itself is not evidence that the model needs more room.
  // Laguna can consume every extra token while reconsidering the same decision.
  // Automatic escalation is therefore earned only by a turn that also made a
  // successful repository-changing/terminal action. The model can still use
  // set_response_budget explicitly when a genuinely larger next response is needed.
  if (!madeProgress) return 'short';
  if (currentLevel === 'short') return 'normal';
  if (currentLevel === 'normal') return 'deep';
  return 'short';
}

export function withResponseBudget(model, level) {
  if (!model) throw new Error('Cannot set a response budget without an active model');
  return { ...model, maxTokens: responseBudget(level) };
}
