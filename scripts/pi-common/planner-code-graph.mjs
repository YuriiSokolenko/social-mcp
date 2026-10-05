import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PLANNER_CODE_GRAPH_RELATIONS = Object.freeze([
  'callers',
  'callees',
  'references',
  'implementations',
  'dependencies',
  'dependents',
  'related_tests',
  'blast_radius',
]);

export const PLANNER_CODE_GRAPH_MAX_BYTES = 16 * 1024;
const COMMAND_TIMEOUT_MS = 4_000;
const COMMAND_MAX_BUFFER = PLANNER_CODE_GRAPH_MAX_BYTES + 4 * 1024;

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function safePlannerText(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 300 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} must contain 1-300 printable characters`);
  }
  if (text.startsWith('-')) throw new Error(`${label} must not start with "-"`);
  return text;
}

function defaultRunner(command, args, options) {
  return spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    env: { ...process.env, ORBIT_TELEMETRY_ENABLED: 'false' },
  });
}

function checkedRun(runner, command, args, cwd, purpose) {
  const result = runner(command, args, { cwd });
  if (result?.error?.code === 'ENOENT') {
    throw new Error(`Planner code graph unavailable: ${command} is not installed`);
  }
  if (result?.error?.code === 'ENOBUFS') {
    throw new Error(`Planner code graph response exceeded ${PLANNER_CODE_GRAPH_MAX_BYTES} bytes; narrow the target/question`);
  }
  if (result?.error) {
    throw new Error(`Planner code graph unavailable: ${purpose} failed (${String(result.error.message ?? result.error)})`);
  }
  if (result?.status !== 0) {
    const detail = String(result?.stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`Planner code graph unavailable: ${purpose} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result?.stdout ?? '');
}

function orbitRows(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Planner code graph unavailable: Orbit index inventory was not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Planner code graph unavailable: Orbit index inventory was not an array');
  }
  return parsed;
}

export function assertFreshPlannerOrbitIndex(cwd, { runner = defaultRunner } = {}) {
  const root = canonicalPath(cwd);
  const head = checkedRun(runner, 'git', ['rev-parse', 'HEAD'], root, 'current HEAD lookup').trim();
  if (!/^[0-9a-f]{7,64}$/i.test(head)) {
    throw new Error('Planner code graph unavailable: current HEAD could not be resolved');
  }

  const rows = orbitRows(checkedRun(runner, 'orbit', ['list', '-F', 'json'], root, 'Orbit index inventory'));
  const row = rows.find(item =>
    typeof item?.repo_path === 'string' &&
    item.repo_path.trim() &&
    canonicalPath(item.repo_path) === root
  );
  if (!row) {
    throw new Error('Planner code graph unavailable: current Planner worktree is not indexed by Orbit');
  }
  if (row.status !== 'indexed') {
    const detail = String(row.error_message ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    throw new Error(`Planner code graph unavailable: Orbit index status is ${String(row.status ?? 'unknown')}${detail ? ` (${detail})` : ''}`);
  }
  const indexedCommit = String(row.commit_sha ?? '').trim();
  if (!indexedCommit || !(head === indexedCommit || head.startsWith(indexedCommit) || indexedCommit.startsWith(head))) {
    throw new Error(`Planner code graph stale: indexed commit ${indexedCommit || 'missing'} does not match current HEAD ${head}`);
  }
  return { repoPath: root, head, indexedCommit };
}

export function plannerCodeGraph(cwd, {
  relation,
  target,
  question,
} = {}, { runner = defaultRunner } = {}) {
  if (!PLANNER_CODE_GRAPH_RELATIONS.includes(relation)) {
    throw new Error(`relation must be one of: ${PLANNER_CODE_GRAPH_RELATIONS.join(', ')}`);
  }
  const boundedTarget = safePlannerText(target, 'target');
  const boundedQuestion = safePlannerText(question, 'question');
  const freshness = assertFreshPlannerOrbitIndex(cwd, { runner });

  // Orbit context is a local graph read. The relation/question stay explicit in the returned
  // envelope so the Planner must answer one bounded planning question rather than roam the graph.
  const context = checkedRun(runner, 'orbit', ['context', boundedTarget], freshness.repoPath, 'Orbit context query').trim();
  if (!context) {
    throw new Error(`Planner code graph unavailable: Orbit returned no context for ${boundedTarget}`);
  }
  if (Buffer.byteLength(context, 'utf8') > PLANNER_CODE_GRAPH_MAX_BYTES) {
    throw new Error(`Planner code graph response exceeded ${PLANNER_CODE_GRAPH_MAX_BYTES} bytes; narrow the target/question`);
  }

  return {
    relation,
    target: boundedTarget,
    question: boundedQuestion,
    indexed_commit: freshness.indexedCommit,
    context,
  };
}
