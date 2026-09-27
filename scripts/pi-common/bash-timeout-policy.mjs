/**
 * Shared deterministic timeout policy for model-issued shell commands.
 *
 * This is safety/operational policy, not agent reasoning. Centralizing it keeps
 * every model stage under the same command-time budget and avoids prompt-only
 * enforcement.
 */

// Pi's bash tool has an optional timeout, but no default. Always supply a
// bounded value, even when the model omits it or requests a longer one.
export function bashTimeout(requested, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('PI_BASH_TIMEOUT_SECONDS must be a positive integer');
  }
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, limit)
    : limit;
}

export function registerTimedBash(pi, createBashTool, limit, cwd = process.cwd()) {
  const original = createBashTool(cwd);
  pi.registerTool({
    name: 'bash',
    label: original.label,
    description: original.description,
    parameters: original.parameters,
    execute(toolCallId, params, signal, onUpdate, context) {
      return original.execute(toolCallId, {
        ...params,
        timeout: bashTimeout(params.timeout, limit),
      }, signal, onUpdate, context);
    },
  });
}
