import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PLANNER_ORBIT_COMMAND_TIMEOUT_MS = 5000;

// Safety-only boundaries for the pre-request seed. Neither value limits Planner evidence,
// later planner_code_graph calls, repository facts, or the Planner -> Main handoff.
export const PLANNER_ORBIT_SEED_MAX_CHARS = 48000;
export const PLANNER_ORBIT_SEED_TIME_BUDGET_MS = 30000;
const PLANNER_ORBIT_FAILURE_DIAGNOSTIC_LIMIT = 5;
const PLANNER_ORBIT_DIAGNOSTIC_MAX_CHARS = 240;

function canonicalPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function abortError(signal) {
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error ? signal.reason : new Error('Planner Orbit operation aborted');
}

function remainingBudgetMs(deadlineAt, now = Date.now) {
  if (!Number.isFinite(deadlineAt)) return PLANNER_ORBIT_COMMAND_TIMEOUT_MS;
  return Math.max(0, Math.min(PLANNER_ORBIT_COMMAND_TIMEOUT_MS, Math.ceil(deadlineAt - now())));
}

async function localCommand(command, args, cwd, execFileFn = execFileAsync, {
  signal = null,
  timeoutMs = PLANNER_ORBIT_COMMAND_TIMEOUT_MS,
} = {}) {
  const aborted = abortError(signal);
  if (aborted) throw aborted;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const error = new Error('Planner Orbit seed time budget exhausted');
    error.code = 'PI_PLANNER_ORBIT_SEED_BUDGET_EXHAUSTED';
    throw error;
  }
  const result = await execFileFn(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: Math.min(PLANNER_ORBIT_COMMAND_TIMEOUT_MS, Math.ceil(timeoutMs)),
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ORBIT_TELEMETRY_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(signal ? { signal } : {}),
  });
  return typeof result === 'string' ? result : result?.stdout ?? '';
}

function sanitizeTarget(value) {
  const target = String(value ?? '').trim()
    .replace(/^[`"'([{<]+/, '')
    .replace(/[`"',;:)\]}>]+$/, '');
  if (!target || target.length > 400 || target.startsWith('-') || /[\u0000-\u001f\u007f\s]/.test(target)) return null;
  if (/^(?:https?:|github\.com\/|api\.github\.com\/|raw\.githubusercontent\.com\/)/i.test(target)) return null;
  if (target.includes('\\') || target.startsWith('/') || target.split('/').includes('..')) return null;
  return target;
}

function repositoryTargetPath(target) {
  const lineRange = target.match(/^(.*?):\d+(?:-\d+)?$/);
  return lineRange ? lineRange[1] : target;
}

function existingRepositoryTarget(cwd, value, { trustedHint = false } = {}) {
  const target = sanitizeTarget(value);
  if (!target) return null;
  const pathTarget = repositoryTargetPath(target);
  const normalized = path.posix.normalize(pathTarget);
  if (!pathTarget || normalized !== pathTarget || normalized === '..' || normalized.startsWith('../')) return null;

  if (!cwd) {
    // Without a worktree, only retain unmistakable file paths. Runtime seeding always supplies cwd,
    // so directories and root files are validated against the real worktree before querying Orbit.
    if (!trustedHint && (!target.includes('/') || !/\.[A-Za-z0-9]{1,12}(?::\d+(?:-\d+)?)?$/.test(target))) return null;
    return target;
  }

  const root = canonicalPath(cwd);
  if (!root) return null;
  const absolute = path.resolve(cwd, pathTarget);
  try {
    // Resolve the candidate itself, not just its lexical path. A symlink located inside the
    // repository must not make an external file/directory eligible for Orbit seeding.
    const realTarget = fs.realpathSync(absolute);
    if (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`)) return null;
    const stat = fs.statSync(realTarget);
    if (!stat.isFile() && !stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return target;
}

export function plannerOrbitSeedTargets(issue, { layoutHint = null, cwd = null } = {}) {
  const text = `${String(issue?.title ?? '')}\n${String(issue?.body ?? '')}`;
  const targets = [];
  const seen = new Set();
  const add = (value, options = {}) => {
    const target = existingRepositoryTarget(cwd, value, options);
    if (!target || seen.has(target)) return;
    seen.add(target);
    targets.push(target);
  };

  // Layout hints are already model-free current-worktree observations. For additive work, query
  // existing convention files/directories before the not-yet-created target paths.
  for (const key of ['sourceConvention', 'sourceDirectory', 'testConvention', 'testDirectory', 'sourceTarget', 'testTarget']) {
    add(layoutHint?.[key], { trustedHint: true });
  }

  for (const match of text.matchAll(/\`([^\`\r\n]{1,400})\`/g)) add(match[1]);
  for (const match of text.matchAll(/\b((?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+(?::\d+(?:-\d+)?)?)\b/g)) add(match[1]);
  return targets;
}

function sanitizeFailureDiagnostic(value) {
  const text = String(value ?? '')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted pem]')
    .replace(/\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{12,}\b/g, '[redacted credential]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)["']?[^,\s"']+["']?/gi, '$1[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, PLANNER_ORBIT_DIAGNOSTIC_MAX_CHARS) : null;
}

function firstFailureLine(error) {
  const values = [error?.stderr, error?.message, error];
  for (const value of values) {
    const first = String(value ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
    const sanitized = sanitizeFailureDiagnostic(first);
    if (sanitized) return sanitized;
  }
  return null;
}

function seedFailureDiagnostic(target, error, { budgetExhausted = false, emptyOutput = false } = {}) {
  const diagnostic = emptyOutput ? 'Orbit context returned empty output' : firstFailureLine(error);
  const code = error?.code;
  const exitCode = Number.isInteger(code)
    ? code
    : Number.isInteger(error?.exitCode) ? error.exitCode : null;
  const timedOut = !emptyOutput && (
    code === 'ETIMEDOUT' ||
    error?.killed === true ||
    /\b(?:timed?\s*out|timeout)\b/i.test(diagnostic ?? '')
  );

  let category = 'unknown';
  if (emptyOutput) category = 'empty_output';
  else if (budgetExhausted) category = 'budget_exhausted';
  else if (timedOut) category = 'timeout';
  else if (typeof code === 'string' && ['ENOENT', 'EACCES', 'EPERM'].includes(code)) category = 'spawn_error';
  else if (/(?:does not exist|no such file|not found)/i.test(diagnostic ?? '')) category = 'not_found';
  else if (exitCode !== null || /\b(?:orbit|graph|index)\b/i.test(diagnostic ?? '')) category = 'graph_error';

  return {
    target,
    category,
    exitCode,
    timedOut,
    budgetExhausted: Boolean(budgetExhausted),
    diagnostic,
  };
}

export async function plannerOrbitIndexState(cwd, {
  execFile: execFileFn = execFileAsync,
  signal = null,
  deadlineAt = null,
  now = Date.now,
} = {}) {
  const root = canonicalPath(cwd);
  let currentHead = null;
  let rows;
  try {
    const commandOptions = () => ({
      signal,
      timeoutMs: remainingBudgetMs(deadlineAt, now),
    });
    currentHead = String(await localCommand('git', ['rev-parse', 'HEAD'], cwd, execFileFn, commandOptions())).trim() || null;
    rows = JSON.parse(await localCommand('orbit', ['list', '-F', 'json'], cwd, execFileFn, commandOptions()));
  } catch (error) {
    const aborted = abortError(signal);
    if (aborted) throw aborted;
    const budgetExpired = error?.code === 'PI_PLANNER_ORBIT_SEED_BUDGET_EXHAUSTED' ||
      (Number.isFinite(deadlineAt) && now() >= deadlineAt);
    return {
      available: false,
      fresh: false,
      currentHead,
      indexedHead: null,
      indexStatus: null,
      reason: budgetExpired ? 'seed_time_budget_exhausted' : 'orbit_unavailable',
      diagnostic: String(error?.message ?? error).split('\n')[0].slice(0, 200),
    };
  }

  if (!currentHead) {
    return {
      available: true, fresh: false, currentHead: null, indexedHead: null,
      indexStatus: null, reason: 'head_unavailable',
    };
  }

  const worktreeRows = Array.isArray(rows)
    ? rows.filter(row => canonicalPath(row?.repo_path) === root)
    : [];
  if (worktreeRows.length === 0) {
    return {
      available: true, fresh: false, currentHead, indexedHead: null,
      indexStatus: null, reason: 'worktree_missing',
    };
  }

  const matchingRows = worktreeRows.filter(row => String(row?.commit_sha ?? '') === currentHead);
  const indexed = matchingRows.find(row => row?.status === 'indexed');
  if (indexed) {
    return {
      available: true,
      fresh: true,
      currentHead,
      indexedHead: currentHead,
      indexStatus: 'indexed',
      reason: null,
    };
  }

  const indexedHeads = [...new Set(worktreeRows
    .filter(row => row?.status === 'indexed')
    .map(row => String(row?.commit_sha ?? '').trim())
    .filter(Boolean))].sort();
  const statuses = [...new Set(matchingRows.map(row => String(row?.status ?? 'unknown')))].sort();
  return {
    available: true,
    fresh: false,
    currentHead,
    indexedHead: indexedHeads[0] ?? null,
    indexStatus: statuses[0] ?? null,
    reason: matchingRows.length === 0 ? 'stale_index' : 'index_not_ready',
  };
}

function graphUnavailableMessage(state) {
  if (state.reason === 'worktree_missing') return 'current worktree is not present in the Orbit index';
  if (state.reason === 'head_unavailable') return 'current worktree HEAD is unavailable';
  if (state.reason === 'stale_index') return 'Orbit index is stale for the current worktree HEAD';
  if (state.reason === 'index_not_ready') return `Orbit index status is ${state.indexStatus ?? 'unknown'}`;
  return state.diagnostic || 'Orbit index is unavailable';
}

export async function plannerOrbitContext(cwd, target, {
  execFile: execFileFn = execFileAsync,
  signal = null,
} = {}) {
  const state = await plannerOrbitIndexState(cwd, { execFile: execFileFn, signal });
  if (!state.fresh) {
    throw new Error(`planner_code_graph unavailable: ${graphUnavailableMessage(state)}`);
  }
  try {
    const text = String(await localCommand('orbit', ['context', target], cwd, execFileFn, { signal })).trim();
    return {
      text,
      currentHead: state.currentHead,
      indexedHead: state.indexedHead,
      indexStatus: state.indexStatus,
    };
  } catch (error) {
    const aborted = abortError(signal);
    if (aborted) throw aborted;
    throw new Error(`planner_code_graph query failed: ${String(error?.message ?? error).split('\n')[0]}`);
  }
}

function serializeSeedSections(sections, maxChars) {
  const serialized = sections
    .map(section => `### Orbit target: ${section.target}\n${section.text}`)
    .join('\n\n');
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : PLANNER_ORBIT_SEED_MAX_CHARS;
  if (serialized.length <= limit) {
    return {
      text: serialized,
      targets: sections.map(section => section.target),
      truncated: false,
    };
  }

  const marker = '\n[Orbit seed truncated for safety]';
  const contentLimit = Math.max(0, limit - marker.length);
  let text = '';
  const targets = [];
  for (const section of sections) {
    const chunk = `${text ? '\n\n' : ''}### Orbit target: ${section.target}\n${section.text}`;
    if (text.length + chunk.length <= contentLimit) {
      text += chunk;
      targets.push(section.target);
      continue;
    }
    if (!text && contentLimit > 0) {
      text = chunk.slice(0, contentLimit);
      targets.push(section.target);
    }
    break;
  }
  return { text: `${text}${marker}`, targets, truncated: true };
}

export async function buildPlannerOrbitSeed(cwd, issue, {
  layoutHint = null,
  execFile: execFileFn = execFileAsync,
  maxChars = PLANNER_ORBIT_SEED_MAX_CHARS,
  timeBudgetMs = PLANNER_ORBIT_SEED_TIME_BUDGET_MS,
  signal = null,
  now = Date.now,
} = {}) {
  const startedAt = now();
  const boundedBudgetMs = Number.isFinite(timeBudgetMs) && timeBudgetMs > 0
    ? Math.ceil(timeBudgetMs)
    : PLANNER_ORBIT_SEED_TIME_BUDGET_MS;
  const deadlineAt = startedAt + boundedBudgetMs;
  const requestedTargets = plannerOrbitSeedTargets(issue, { layoutHint, cwd });
  const initial = await plannerOrbitIndexState(cwd, { execFile: execFileFn, signal, deadlineAt, now });

  const attemptedTargets = [];
  const sections = [];
  let queryFailures = 0;
  const failureCategoryCounts = {};
  const failureDiagnostics = [];

  const recordFailure = (target, error, options = {}) => {
    queryFailures += 1;
    const diagnostic = seedFailureDiagnostic(target, error, options);
    failureCategoryCounts[diagnostic.category] = (failureCategoryCounts[diagnostic.category] ?? 0) + 1;
    if (failureDiagnostics.length < PLANNER_ORBIT_FAILURE_DIAGNOSTIC_LIMIT) failureDiagnostics.push(diagnostic);
  };

  const snapshot = () => {
    const successfulTargets = sections.map(section => section.target);
    return {
      fresh: initial.fresh,
      currentHead: initial.currentHead,
      indexedHead: initial.indexedHead,
      indexStatus: initial.indexStatus,
      requestedTargets,
      attemptedTargets: [...attemptedTargets],
      attemptedTargetCount: attemptedTargets.length,
      successfulTargets,
      // Compatibility: queriedTargets historically meant successful non-empty context queries.
      queriedTargets: successfulTargets,
      targets: [],
      serializedBytes: 0,
      truncated: false,
      queryFailures,
      failureCategoryCounts: { ...failureCategoryCounts },
      failureDiagnostics: [...failureDiagnostics],
      timeBudgetMs: boundedBudgetMs,
      durationMs: Math.max(0, now() - startedAt),
    };
  };

  if (!initial.fresh) return { ...snapshot(), present: false, reason: initial.reason };
  if (requestedTargets.length === 0) return { ...snapshot(), present: false, reason: 'no_task_targets' };

  for (const target of requestedTargets) {
    const aborted = abortError(signal);
    if (aborted) throw aborted;
    const remaining = remainingBudgetMs(deadlineAt, now);
    if (remaining <= 0) {
      return { ...snapshot(), present: false, reason: 'seed_time_budget_exhausted' };
    }

    attemptedTargets.push(target);
    try {
      const raw = String(await localCommand('orbit', ['context', target], cwd, execFileFn, {
        signal,
        timeoutMs: remaining,
      })).trim();
      if (!raw) {
        recordFailure(target, null, { emptyOutput: true });
        continue;
      }
      sections.push({ target, text: raw });
    } catch (error) {
      const externalAbort = abortError(signal);
      if (externalAbort) throw externalAbort;
      const budgetExhausted = now() >= deadlineAt || error?.code === 'PI_PLANNER_ORBIT_SEED_BUDGET_EXHAUSTED';
      recordFailure(target, error, { budgetExhausted });
      if (budgetExhausted) {
        return { ...snapshot(), present: false, reason: 'seed_time_budget_exhausted' };
      }
    }
  }

  // HEAD/index may change while context queries are running. Discard the whole seed rather than
  // mixing graph data from different repository states.
  const finalState = await plannerOrbitIndexState(cwd, { execFile: execFileFn, signal, deadlineAt, now });
  if (finalState.reason === 'seed_time_budget_exhausted') {
    return { ...snapshot(), present: false, reason: 'seed_time_budget_exhausted' };
  }
  if (!finalState.fresh || finalState.currentHead !== initial.currentHead) {
    return {
      ...snapshot(),
      present: false,
      fresh: false,
      indexedHead: finalState.indexedHead,
      indexStatus: finalState.indexStatus,
      targets: [],
      reason: 'head_or_index_changed',
    };
  }
  if (sections.length === 0) {
    return { ...snapshot(), present: false, reason: 'context_unavailable' };
  }

  const serialized = serializeSeedSections(sections, maxChars);
  return {
    ...snapshot(),
    present: true,
    fresh: true,
    indexedHead: finalState.indexedHead,
    indexStatus: finalState.indexStatus,
    targets: serialized.targets,
    serializedBytes: Buffer.byteLength(serialized.text, 'utf8'),
    truncated: serialized.truncated,
    durationMs: Math.max(0, now() - startedAt),
    reason: null,
    text: serialized.text,
  };
}
