// Loaded only inside pi-subagents scout children via .pi/settings.json.
// It mirrors the parent agent's current response ceiling without changing
// child context size, tool access, or total usage accounting.

function responseBudget(env = process.env) {
  const value = Number(env.PI_SUBAGENT_RESPONSE_MAX_TOKENS);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('PI_SUBAGENT_RESPONSE_MAX_TOKENS must be a positive integer');
  }
  return value;
}

export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.model) throw new Error('Scout child has no active model for response budgeting');
    const requested = responseBudget();
    const modelLimit = Number.isSafeInteger(ctx.model.maxTokens) && ctx.model.maxTokens > 0
      ? ctx.model.maxTokens
      : requested;
    const maxTokens = Math.min(requested, modelLimit);
    const changed = await pi.setModel({ ...ctx.model, maxTokens });
    if (!changed) throw new Error(`Failed to apply scout response budget ${maxTokens}`);
    console.log(`PI_SUBAGENT_BUDGET ${JSON.stringify({ maxTokens })}`);
  });
}
