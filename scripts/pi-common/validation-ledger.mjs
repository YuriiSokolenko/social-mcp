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

export function resolveRunArtifactId(env = process.env) {
  const githubRunId = String(env.GITHUB_RUN_ID ?? '').trim();
  const githubRunAttempt = String(env.GITHUB_RUN_ATTEMPT ?? '1').trim() || '1';
  return `${githubRunId || `local-${process.pid}`}-${githubRunAttempt}`;
}

export function resolveValidationRunId(env = process.env) {
  const explicit = String(env.PI_VALIDATION_RUN_ID ?? '').trim();
  if (explicit) return explicit;
  return resolveRunArtifactId(env);
}

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
 * Returns the most recent unresolved exact-scope run_check failure for the
 * selected workflow run.
 *
 * Recovery state is tracked independently per exact kind+scope:
 * - fail: that scope requires exact recovery;
 * - pass: resolves that exact scope;
 * - timeout/invalid/infra_error: stop forcing retry for that exact scope while
 *   normal ledger reconciliation remains fail-closed;
 * - broader/different scopes never resolve each other.
 *
 * Multiple failed scopes may therefore remain outstanding within one workflow
 * run. The most recently failed unresolved scope is offered first; after it is
 * resolved, an older unresolved scope becomes active. Scoping by runId prevents
 * failures from earlier workflow runs from leaking into the current session.
 */
export function latestUnresolvedRunCheckFailure(records, { runId = null, stage = null } = {}) {
  const stateByGroup = new Map();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.source !== 'run_check') continue;
    if (runId != null && record.run_id !== runId) continue;
    if (stage != null && record.stage !== stage) continue;

    const key = groupKey(record.kind, record.scope);
    if (record.status === 'fail') {
      stateByGroup.set(key, { record, index });
    } else if (record.status === 'pass' || BLOCKING_STATUSES.has(record.status)) {
      stateByGroup.delete(key);
    }
  }

  const candidates = [...stateByGroup.values()].sort((left, right) => right.index - left.index);
  for (const candidate of candidates) {
    try {
      // Recovery can only select a record that the deterministic retry tool
      // can faithfully reconstruct. Malformed/legacy records stay in the
      // ledger for final fail-closed verification but never mask an older,
      // valid recovery obligation.
      runCheckRequestForRecord(candidate.record);
      return candidate.record;
    } catch {
      // Try the next unresolved exact scope.
    }
  }
  return null;
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

  const hasPaths = Array.isArray(record.scope.paths) && record.scope.paths.length > 0;
  const hasTargets = Array.isArray(record.scope.targets) && record.scope.targets.length > 0;
  const hasProfile = typeof record.scope.profile === 'string' && record.scope.profile.length > 0;
  const scopeFieldCount = Number(hasPaths) + Number(hasTargets) + Number(hasProfile);
  if (scopeFieldCount !== 1 || record.scope.whole_repo === true) {
    throw new Error(`cannot reconstruct run_check request for ${record.kind}: ambiguous or unsupported scope`);
  }

  if ((record.kind === 'python_compile' || record.kind === 'ruff') && hasPaths) {
    return { kind: record.kind, paths: [...record.scope.paths] };
  }
  if (record.kind === 'pytest' && hasTargets) {
    return { kind: record.kind, targets: [...record.scope.targets] };
  }
  if (record.kind === 'profile' && hasProfile) {
    return { kind: record.kind, profile: record.scope.profile };
  }
  throw new Error(`cannot reconstruct run_check request for ${record.kind}: scope does not match check kind`);
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
