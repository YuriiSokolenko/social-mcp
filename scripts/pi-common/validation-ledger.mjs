import fs from 'node:fs';
import path from 'node:path';

import { CHECK_STATUSES } from './run-check.mjs';

/**
 * Backend-neutral, append-only record of every authoritative check that ran
 * during an implementer attempt: focused `run_check` calls and the final
 * `checks.final` pipeline. This is the sole source of truth for what may be
 * reported as "validated" — PR bodies and job summaries must render from it,
 * never from model prose or a static template.
 *
 * One JSON object per line (JSONL), so concurrent attempts within one stage
 * (e.g. a validation-repair sub-run) can append additively without needing to
 * read-modify-write the whole file.
 */

export const LEDGER_STATUSES = Object.freeze([...CHECK_STATUSES, 'not_run']);

export const VERIFICATION_STATES = Object.freeze({
  NOT_APPLICABLE: 'VERIFICATION_NOT_APPLICABLE',
  PENDING: 'VERIFICATION_PENDING',
  BLOCKED_INFRA: 'VERIFICATION_BLOCKED_INFRA',
  VERIFIED: 'VERIFIED',
  FAILED: 'VERIFICATION_FAILED',
});

const BLOCKING_STATUSES = new Set(['infra_error', 'timeout', 'invalid', 'not_run']);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Reduce a run_check call's own params (or a final-check step) to a scope
 * that is stable regardless of whether the agent supplied a relative or an
 * absolute-in-worktree path. Pure: no filesystem access, so it never throws
 * on a path that does not exist.
 */
export function normalizeScope({ kind, paths, targets, profile } = {}, cwd = process.cwd()) {
  const normalizePathLike = entry => {
    const [file, ...rest] = String(entry).split('::');
    const relative = path.isAbsolute(file) ? path.relative(cwd, file) : path.normalize(file);
    return rest.length ? [relative, ...rest].join('::') : relative;
  };
  if (Array.isArray(paths) && paths.length) {
    return { paths: [...new Set(paths.map(normalizePathLike))].sort() };
  }
  if (Array.isArray(targets) && targets.length) {
    return { targets: [...new Set(targets.map(normalizePathLike))].sort() };
  }
  if (typeof profile === 'string' && profile) return { profile };
  return { whole_repo: true };
}

export function groupKey(kind, scope) {
  return `${kind}:${stableStringify(scope)}`;
}

export function appendCheckRecord(ledgerPath, record) {
  if (!ledgerPath) throw new Error('validation ledger path is not configured');
  if (!LEDGER_STATUSES.includes(record.status)) {
    throw new Error(`Unknown validation ledger status: ${record.status}`);
  }
  const entry = {
    seq: readValidationLedger(ledgerPath).length,
    timestamp: new Date().toISOString(),
    exit_code: null,
    diagnostics_count: 0,
    summary: '',
    infrastructure: null,
    ...record,
  };
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  return entry;
}

export function readValidationLedger(ledgerPath) {
  if (!ledgerPath || !fs.existsSync(ledgerPath)) return [];
  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n');
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially-written trailing line (e.g. a killed process) is skipped,
      // never treated as a parse failure for the whole ledger.
    }
  }
  return records;
}

/**
 * One entry per distinct (kind, scope) group, holding the most recently
 * appended record for that group. A later authoritative check for the exact
 * same kind+scope resolves an earlier infra_error/timeout/not_run; a broader
 * check (different scope, e.g. whole_repo) is a different group and can
 * never resolve a narrower one.
 */
export function reconcile(records) {
  const groups = new Map();
  // Last-write-wins per (kind, scope) group, by array/file order — not by the
  // `seq`/`timestamp` field, since two records appended in the same
  // millisecond must still resolve deterministically to "the later one."
  // A Map key's insertion position never moves on re-`set`, so this also
  // naturally yields the groups in first-seen order for rendering.
  for (const record of records) {
    groups.set(groupKey(record.kind, record.scope), record);
  }
  return [...groups.values()];
}

export function computeVerificationState(records, { finalChecksRan = true } = {}) {
  const groups = reconcile(records);
  if (!groups.length) return VERIFICATION_STATES.NOT_APPLICABLE;
  if (groups.some(group => group.status === 'fail')) return VERIFICATION_STATES.FAILED;
  if (groups.some(group => BLOCKING_STATUSES.has(group.status))) return VERIFICATION_STATES.BLOCKED_INFRA;
  if (!finalChecksRan) return VERIFICATION_STATES.PENDING;
  return VERIFICATION_STATES.VERIFIED;
}

function describeGroup(group) {
  const scope = group.scope?.whole_repo
    ? ''
    : group.scope?.profile
      ? `(${group.scope.profile})`
      : group.scope?.paths?.length
        ? `(${group.scope.paths.join(', ')})`
        : group.scope?.targets?.length
          ? `(${group.scope.targets.join(', ')})`
          : '';
  const label = `${group.kind}${scope}`;
  if (group.status === 'pass') return `- ${label}: passed`;
  if (group.status === 'infra_error') {
    const code = group.infrastructure?.code ? ` (${group.infrastructure.code})` : '';
    return `- ${label}: INFRASTRUCTURE ERROR${code} — not verified`;
  }
  if (group.status === 'not_run') return `- ${label}: not run — not verified`;
  if (group.status === 'timeout') return `- ${label}: timed out — not verified`;
  if (group.status === 'invalid') return `- ${label}: invalid request — not verified`;
  return `- ${label}: failed`;
}

/**
 * Pure rendering of the PR/job "Validation" section from recorded checks
 * only. Never accepts model metadata/prose: there is nothing here for a
 * model-authored claim to override.
 */
export function renderValidationSection(records, { finalChecksRan = true } = {}) {
  const groups = reconcile(records);
  const state = computeVerificationState(records, { finalChecksRan });
  if (!groups.length) {
    return ['- No authoritative checks were recorded for this change.', `- Overall verification state: ${state}`].join('\n');
  }
  return [...groups.map(describeGroup), `- Overall verification state: ${state}`].join('\n');
}
