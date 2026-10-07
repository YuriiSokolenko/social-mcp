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
  if (target.split('/').includes('..')) return null;
  return target;
}

function looksLikeOrbitTarget(value) {
  if (value.includes('/')) return true;
  if (value.includes('_')) return true;
  if (/[A-Z]/.test(value)) return true;
  if (/^[A-Za-z_]\w*(?:(?:\.|::|#)[A-Za-z_]\w*)+$/.test(value)) return true;
  return false;
}

export function plannerOrbitSeedTargets(issue, { layoutHint = null } = {}) {
  const text = `${String(issue?.title ?? '')}\n${String(issue?.body ?? '')}`;
  const targets = [];
  const seen = new Set();
  const add = (value, { trustedHint = false } = {}) => {
    const target = sanitizeTarget(value);
    if (!target || (!trustedHint && !looksLikeOrbitTarget(target)) || seen.has(target)) return;
    seen.add(target);
    targets.push(target);
  };

  for (const match of text.matchAll(/\`([^\`\r\n]{1,400})\`/g)) add(match[1]);
  for (const match of text.matchAll(/\b((?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+)\b/g)) add(match[1], { trustedHint: true });

  for (const key of ['dottedTarget', 'sourceTarget', 'sourceConvention', 'testTarget', 'testConvention']) {
    add(layoutHint?.[key], { trustedHint: true });
  }
  return targets;
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
  const requestedTargets = plannerOrbitSeedTargets(issue, { layoutHint });
  const initial = await plannerOrbitIndexState(cwd, { execFile: execFileFn, signal, deadlineAt, now });
  const base = {
    fresh: initial.fresh,
    currentHead: initial.currentHead,
    indexedHead: initial.indexedHead,
    indexStatus: initial.indexStatus,
    requestedTargets,
    queriedTargets: [],
    targets: [],
    serializedBytes: 0,
    truncated: false,
    queryFailures: 0,
    timeBudgetMs: boundedBudgetMs,
    durationMs: Math.max(0, now() - startedAt),
  };
  if (!initial.fresh) return { ...base, present: false, reason: initial.reason };
  if (requestedTargets.length === 0) return { ...base, present: false, reason: 'no_task_targets' };

  const sections = [];
  let queryFailures = 0;
  for (const target of requestedTargets) {
    const aborted = abortError(signal);
    if (aborted) throw aborted;
    const remaining = remainingBudgetMs(deadlineAt, now);
    if (remaining <= 0) {
      return {
        ...base,
        present: false,
        queriedTargets: sections.map(section => section.target),
        queryFailures,
        durationMs: Math.max(0, now() - startedAt),
        reason: 'seed_time_budget_exhausted',
      };
    }
    try {
      const raw = String(await localCommand('orbit', ['context', target], cwd, execFileFn, {
        signal,
        timeoutMs: remaining,
      })).trim();
      if (!raw) {
        queryFailures += 1;
        continue;
      }
      sections.push({ target, text: raw });
    } catch (error) {
      const externalAbort = abortError(signal);
      if (externalAbort) throw externalAbort;
      if (now() >= deadlineAt || error?.code === 'PI_PLANNER_ORBIT_SEED_BUDGET_EXHAUSTED') {
        return {
          ...base,
          present: false,
          queriedTargets: sections.map(section => section.target),
          queryFailures,
          durationMs: Math.max(0, now() - startedAt),
          reason: 'seed_time_budget_exhausted',
        };
      }
      queryFailures += 1;
    }
  }

  // HEAD/index may change while context queries are running. Discard the whole seed rather than
  // mixing graph data from different repository states.
  const finalState = await plannerOrbitIndexState(cwd, { execFile: execFileFn, signal, deadlineAt, now });
  if (finalState.reason === 'seed_time_budget_exhausted') {
    return {
      ...base,
      present: false,
      queriedTargets: sections.map(section => section.target),
      queryFailures,
      durationMs: Math.max(0, now() - startedAt),
      reason: 'seed_time_budget_exhausted',
    };
  }
  if (!finalState.fresh || finalState.currentHead !== initial.currentHead) {
    return {
      ...base,
      present: false,
      fresh: false,
      indexedHead: finalState.indexedHead,
      indexStatus: finalState.indexStatus,
      queriedTargets: sections.map(section => section.target),
      queryFailures,
      durationMs: Math.max(0, now() - startedAt),
      reason: 'head_or_index_changed',
    };
  }
  if (sections.length === 0) {
    return {
      ...base,
      present: false,
      queryFailures,
      durationMs: Math.max(0, now() - startedAt),
      reason: 'context_unavailable',
    };
  }

  const serialized = serializeSeedSections(sections, maxChars);
  return {
    ...base,
    present: true,
    fresh: true,
    indexedHead: finalState.indexedHead,
    indexStatus: finalState.indexStatus,
    queriedTargets: sections.map(section => section.target),
    targets: serialized.targets,
    serializedBytes: Buffer.byteLength(serialized.text, 'utf8'),
    truncated: serialized.truncated,
    queryFailures,
    durationMs: Math.max(0, now() - startedAt),
    reason: null,
    text: serialized.text,
  };
}
