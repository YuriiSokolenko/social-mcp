// The pinned pi-subagents foreground adapter reads this process environment
// variable while it classifies a coding child's terminal toolUse. Its API does
// not accept a per-delegation context, so Implementer delegations in the same
// Node process MUST be single-flight from binding through receipt handling.
// Independent GitHub runner processes have separate env objects and module state.
const TERMINAL_SESSION_KEY = 'PI_IMPLEMENTER_SUBAGENT_TERMINAL_SESSION_ID';
let activeLease = null;

export function acquireImplementerTerminalSession(sessionId, env = process.env) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new TypeError('A non-empty coding terminal session ID is required');
  }
  // Reject synchronously, before changing env or launching another fork.
  // No wait queue: a concurrent/reentrant call cannot deadlock the owner.
  if (activeLease !== null) {
    const error = new Error('An Implementer coding-session delegation is already active in this process');
    error.code = 'PI_IMPLEMENTER_TERMINAL_SESSION_OVERLAP';
    throw error;
  }

  const hadPrevious = Object.prototype.hasOwnProperty.call(env, TERMINAL_SESSION_KEY);
  const previous = env[TERMINAL_SESSION_KEY];
  env[TERMINAL_SESSION_KEY] = sessionId;
  const lease = { sessionId };
  activeLease = lease;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (hadPrevious) env[TERMINAL_SESSION_KEY] = previous;
      else delete env[TERMINAL_SESSION_KEY];
    } finally {
      // Release even if restoration fails, so future invocations cannot deadlock.
      if (activeLease === lease) activeLease = null;
    }
  };
}
