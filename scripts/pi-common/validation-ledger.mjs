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

/**
 * The checks.final pipeline is a fixed sequence of steps (e.g. Ruff, then
 * `git diff --check`, then pytest). A per-step `checks_final` record for one
 * step is not proof the whole pipeline ran — a process that dies between
 * steps would otherwise leave an early step's `pass` looking like "final
 * checks ran." Only this reserved source, appended once after every step in
 * the pipeline has completed without error, counts as that proof.
 */
export const FINAL_PIPELINE_COMPLETE_SOURCE = 'checks_final_complete';

const RECORD_SOURCES = Object.freeze(['run_check', 'checks_final', FINAL_PIPELINE_COMPLETE_SOURCE]);

/**
 * Fail-closed ingestion: a record missing the fields that identify what was
 * checked and where it came from is rejected outright rather than accepted
 * with holes. `status` is checked against `LEDGER_STATUSES` separately by
 * the caller, before this runs.
 */
function assertIngestible(record) {
  if (typeof record.kind !== 'string' || !record.kind.trim()) {
    throw new Error('validation ledger record requires a non-empty kind');
  }
  if (!record.scope || typeof record.scope !== 'object' || Array.isArray(record.scope)) {
    throw new Error('validation ledger record requires an object scope');
  }
  if (!RECORD_SOURCES.includes(record.source)) {
    throw new Error(`validation ledger record has an unknown source: ${record.source}`);
  }
  if (typeof record.stage !== 'string' || !record.stage.trim()) {
    throw new Error('validation ledger record requires a non-empty stage');
  }
  if (typeof record.backend !== 'string' || !record.backend.trim()) {
    throw new Error('validation ledger record requires a non-empty backend');
  }
}

export function appendCheckRecord(ledgerPath, record) {
  if (!ledgerPath) throw new Error('validation ledger path is not configured');
  if (!LEDGER_STATUSES.includes(record.status)) {
    throw new Error(`Unknown validation ledger status: ${record.status}`);
  }
  assertIngestible(record);
  const { records: existing } = readValidationLedger(ledgerPath);
  const entry = {
    seq: existing.length,
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

/**
 * Returns every well-formed record plus a `corrupted` flag. A ledger is the
 * authoritative record of what actually ran; a line that cannot be parsed —
 * including a partially-written trailing line from a killed process — is
 * never silently dropped, because the dropped line could be exactly the
 * fail/infra_error record that made an unrelated `pass` untrustworthy.
 * Callers must treat `corrupted: true` as "verification cannot be trusted,"
 * never as "proceed with what parsed."
 */
export function readValidationLedger(ledgerPath) {
  if (!ledgerPath || !fs.existsSync(ledgerPath)) return { records: [], corrupted: false };
  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n');
  const records = [];
  let corrupted = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      corrupted = true;
    }
  }
  return { records, corrupted };
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
    // The pipeline-completion marker is not an individual check: it never
    // appears as its own "Validation" bullet.
    if (record.source === FINAL_PIPELINE_COMPLETE_SOURCE) continue;
    groups.set(groupKey(record.kind, record.scope), record);
  }
  return [...groups.values()];
}

/**
 * Returns the single active exact-scope run_check recovery obligation.
 *
 * A recoverable `fail` opens one obligation. While it is open, unrelated
 * broader/different scopes never satisfy it and never create a queue of stale
 * obligations behind it. Only another authoritative run_check for the exact
 * same kind+scope can close that recovery episode:
 * - pass: recovered successfully;
 * - timeout/invalid/infra_error: stop forcing retries and leave the ledger's
 *   normal fail-closed verification projection to report the blocked state;
 * - fail: keep recovery open, with the newest exact failure as its evidence.
 *
 * This intentionally models recovery as one state machine rather than deriving
 * a backlog from every historical failed scope in the append-only ledger.
 * Callers may scope the scan to one runtime run/attempt; final verification
 * still reconciles the complete shared ledger across attempts.
 */
export function latestUnresolvedRunCheckFailure(records, { runId = null, attemptId = null } = {}) {
  let recovery = null;
  let recoveryKey = null;

  for (const record of records) {
    if (record.source !== 'run_check') continue;
    if (runId != null && record.run_id !== runId) continue;
    if (attemptId != null && record.attempt_id !== attemptId) continue;

    if (!recovery) {
      if (record.status === 'fail') {
        recovery = record;
        recoveryKey = groupKey(record.kind, record.scope);
      }
      continue;
    }

    if (groupKey(record.kind, record.scope) !== recoveryKey) {
      // A broader/different scope cannot satisfy or replace the current exact
      // recovery obligation.
      continue;
    }

    if (record.status === 'fail') {
      recovery = record;
      continue;
    }

    // Any exact non-fail outcome closes the forced-retry episode. pass means
    // successful recovery; timeout/invalid/infra_error remain fail-closed in
    // computeVerificationState via normal exact-group reconciliation.
    recovery = null;
    recoveryKey = null;
  }

  return recovery;
}

/**
 * Reconstruct the closed run_check request for a ledger record. Scope
 * normalization may reorder or deduplicate entries, but preserves the exact
 * semantic kind+scope used for reconciliation.
 */
export function runCheckRequestForRecord(record) {
  if (!record || typeof record.kind !== 'string' || !record.scope || typeof record.scope !== 'object') {
    throw new Error('cannot reconstruct run_check request from an invalid ledger record');
  }
  if (Array.isArray(record.scope.paths) && record.scope.paths.length) {
    return { kind: record.kind, paths: [...record.scope.paths] };
  }
  if (Array.isArray(record.scope.targets) && record.scope.targets.length) {
    return { kind: record.kind, targets: [...record.scope.targets] };
  }
  if (typeof record.scope.profile === 'string' && record.scope.profile) {
    return { kind: record.kind, profile: record.scope.profile };
  }
  throw new Error(`cannot reconstruct run_check request for ${record.kind}: unsupported scope`);
}

/**
 * `corrupted` (from `readValidationLedger`) always wins: a ledger that lost
 * even one line cannot be trusted to have kept every fail/infra_error record,
 * so it is never treated as evidence of VERIFIED. "Did the final checks.final
 * pipeline run to completion" is likewise derived from the ledger's own
 * contents — specifically the reserved `FINAL_PIPELINE_COMPLETE_SOURCE`
 * marker, never from the mere presence of an individual `checks_final` step
 * record. A single early step (e.g. Ruff) passing and then the process dying
 * before the rest of the pipeline runs must not look like "final checks ran."
 */
export function computeVerificationState(records, { corrupted = false } = {}) {
  if (corrupted) return VERIFICATION_STATES.BLOCKED_INFRA;
  const groups = reconcile(records);
  if (!groups.length) return VERIFICATION_STATES.NOT_APPLICABLE;
  if (groups.some(group => group.status === 'fail')) return VERIFICATION_STATES.FAILED;
  if (groups.some(group => BLOCKING_STATUSES.has(group.status))) return VERIFICATION_STATES.BLOCKED_INFRA;
  const finalChecksRan = records.some(record => record.source === FINAL_PIPELINE_COMPLETE_SOURCE);
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
export function renderValidationSection(records, { corrupted = false } = {}) {
  const state = computeVerificationState(records, { corrupted });
  if (corrupted) {
    return [
      '- The validation ledger could not be fully read (a record failed to parse).',
      `- Overall verification state: ${state}`,
    ].join('\n');
  }
  const groups = reconcile(records);
  if (!groups.length) {
    return ['- No authoritative checks were recorded for this change.', `- Overall verification state: ${state}`].join('\n');
  }
  return [...groups.map(describeGroup), `- Overall verification state: ${state}`].join('\n');
}
