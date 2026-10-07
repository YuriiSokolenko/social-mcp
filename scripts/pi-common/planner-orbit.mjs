import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PLANNER_ORBIT_COMMAND_TIMEOUT_MS = 5000;

// Safety-only serialization boundary for model input. This is not an evidence-action,
// Orbit-query, repository-fact, or Planner -> Main handoff limit.
export const PLANNER_ORBIT_SEED_MAX_CHARS = 48000;

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

async function localCommand(command, args, cwd, execFileFn = execFileAsync) {
  const result = await execFileFn(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: PLANNER_ORBIT_COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ORBIT_TELEMETRY_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
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

export function plannerOrbitSeedTargets(issue, { layoutHint = null } = {}) {
  const text = `${String(issue?.title ?? '')}\n${String(issue?.body ?? '')}`;
  const targets = [];
  const seen = new Set();
  const add = value => {
    const target = sanitizeTarget(value);
    if (!target || seen.has(target)) return;
    seen.add(target);
    targets.push(target);
  };

  for (const match of text.matchAll(/`([^`\r\n]{1,400})`/g)) add(match[1]);
  for (const match of text.matchAll(/\b((?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+)\b/g)) add(match[1]);

  for (const key of ['dottedTarget', 'sourceTarget', 'sourceConvention', 'testTarget', 'testConvention']) {
    add(layoutHint?.[key]);
  }
  return targets;
}

export async function plannerOrbitIndexState(cwd, { execFile: execFileFn = execFileAsync } = {}) {
  const root = canonicalPath(cwd);
  let currentHead = null;
  let rows;
  try {
    currentHead = String(await localCommand('git', ['rev-parse', 'HEAD'], cwd, execFileFn)).trim() || null;
    rows = JSON.parse(await localCommand('orbit', ['list', '-F', 'json'], cwd, execFileFn));
  } catch (error) {
    return {
      available: false,
      fresh: false,
      currentHead,
      indexedHead: null,
      indexStatus: null,
      reason: 'orbit_unavailable',
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

export async function plannerOrbitContext(cwd, target, { execFile: execFileFn = execFileAsync } = {}) {
  const state = await plannerOrbitIndexState(cwd, { execFile: execFileFn });
  if (!state.fresh) {
    throw new Error(`planner_code_graph unavailable: ${graphUnavailableMessage(state)}`);
  }
  try {
    const text = String(await localCommand('orbit', ['context', target], cwd, execFileFn)).trim();
    return {
      text,
      currentHead: state.currentHead,
      indexedHead: state.indexedHead,
      indexStatus: state.indexStatus,
    };
  } catch (error) {
    throw new Error(`planner_code_graph query failed: ${String(error?.message ?? error).split('\n')[0]}`);
  }
}

export async function buildPlannerOrbitSeed(cwd, issue, {
  layoutHint = null,
  execFile: execFileFn = execFileAsync,
  maxChars = PLANNER_ORBIT_SEED_MAX_CHARS,
} = {}) {
  const requestedTargets = plannerOrbitSeedTargets(issue, { layoutHint });
  const initial = await plannerOrbitIndexState(cwd, { execFile: execFileFn });
  const base = {
    fresh: initial.fresh,
    currentHead: initial.currentHead,
    indexedHead: initial.indexedHead,
    indexStatus: initial.indexStatus,
    requestedTargets,
    targets: [],
    serializedBytes: 0,
    truncated: false,
    queryFailures: 0,
  };
  if (!initial.fresh) return { ...base, present: false, reason: initial.reason };
  if (requestedTargets.length === 0) return { ...base, present: false, reason: 'no_task_targets' };

  const sections = [];
  let queryFailures = 0;
  for (const target of requestedTargets) {
    try {
      const raw = String(await localCommand('orbit', ['context', target], cwd, execFileFn)).trim();
      if (!raw) {
        queryFailures += 1;
        continue;
      }
      sections.push({ target, text: raw });
    } catch {
      queryFailures += 1;
    }
  }

  // HEAD/index may change while context queries are running. Discard the whole seed rather than
  // mixing graph data from different repository states.
  const finalState = await plannerOrbitIndexState(cwd, { execFile: execFileFn });
  if (!finalState.fresh || finalState.currentHead !== initial.currentHead) {
    return {
      ...base,
      present: false,
      fresh: false,
      indexedHead: finalState.indexedHead,
      indexStatus: finalState.indexStatus,
      queryFailures,
      reason: 'head_or_index_changed',
    };
  }
  if (sections.length === 0) {
    return { ...base, present: false, queryFailures, reason: 'context_unavailable' };
  }

  const serialized = sections
    .map(section => `### Orbit target: ${section.target}\n${section.text}`)
    .join('\n\n');
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : PLANNER_ORBIT_SEED_MAX_CHARS;
  const truncated = serialized.length > limit;
  const text = truncated
    ? `${serialized.slice(0, limit)}\n[Orbit seed truncated for safety]`
    : serialized;

  return {
    ...base,
    present: true,
    fresh: true,
    indexedHead: finalState.indexedHead,
    indexStatus: finalState.indexStatus,
    targets: sections.map(section => section.target),
    serializedBytes: Buffer.byteLength(text, 'utf8'),
    truncated,
    queryFailures,
    reason: null,
    text,
  };
}
