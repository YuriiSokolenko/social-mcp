import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Runtime-owned record of capabilities a coding-session fork attempted but could not use.
// The fork writes the sidecar from its own tool_call gate; the parent reads it after the fork
// ends. Nothing here depends on the model declaring `required_capability`.

function readAttempts(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.unavailable_tools) ? parsed.unavailable_tools.map(String) : [];
  } catch {
    return [];
  }
}

export function recordUnavailableCapabilityAttempt(file, toolName) {
  const name = String(toolName ?? '').trim();
  if (!file || !name) return;
  const attempts = readAttempts(file);
  if (attempts.includes(name)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify({ schema_version: 1, unavailable_tools: [...attempts, name].sort() })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(tempFile, file);
}

/** Reads and removes the fork's sidecar. A missing or malformed sidecar means "no evidence". */
export function consumeUnavailableCapabilityAttempts(file) {
  if (!file) return [];
  try {
    return readAttempts(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * A fork that ended without a final submission after attempting tools outside the coding-session
 * capability contract was incapable of the work it was launched for. Tools that are part of the
 * contract but were hidden in the fork's current state are not evidence: a later state may expose
 * them inside the fork.
 */
export function incapableCodingSessionRecord({ submitted, attemptedTools = [], contractTools = [], repositoryState = null }) {
  if (submitted) return null;
  const contract = [...new Set(contractTools)].sort();
  const unreachable = [...new Set(attemptedTools)].filter(name => !contract.includes(name)).sort();
  if (!unreachable.length) return null;
  return { unreachable, contractTools: contract, repositoryState };
}

/**
 * Returns the previous incapable record when a new launch would be equivalent: the fork still
 * cannot expose any capability the previous fork lacked and no repository-state transition is
 * proven since then. Returns null when the launch may proceed.
 */
export function equivalentIncapableCodingSession(previous, { contractTools = [], repositoryState = null }) {
  if (!previous) return null;
  if (previous.unreachable.some(name => contractTools.includes(name))) return null;
  const stateTransition =
    previous.repositoryState != null &&
    repositoryState != null &&
    previous.repositoryState !== repositoryState;
  return stateTransition ? null : previous;
}
