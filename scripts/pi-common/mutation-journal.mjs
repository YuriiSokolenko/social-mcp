import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { isControlPlanePath } from './control-plane-policy.mjs';
import { resolveMutationTarget } from './mutation-target.mjs';

const JOURNAL_SCHEMA_VERSION = 1;
export const MUTATION_JOURNAL_MAX_ENTRIES = 256;
export const MUTATION_JOURNAL_MAX_PRIOR_BYTES = 2 * 1024 * 1024;
export const MUTATION_JOURNAL_MAX_TOTAL_PRIOR_BYTES = 16 * 1024 * 1024;
export const MUTATION_JOURNAL_MAX_CHECKPOINT_BYTES = 80 * 1024;

const CAPACITY_ERROR_CODES = new Set([
  'mutation_journal_full',
  'mutation_journal_snapshot_too_large',
]);

const states = new Map();

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function journalError(code, message, extra = {}) {
  const error = new Error(JSON.stringify({ code, ...extra, message }));
  error.code = code;
  return error;
}

function sidecarPath(env) {
  const value = String(env?.PI_MUTATION_JOURNAL_FILE ?? '').trim();
  return value || null;
}

function canonicalPath(cwd, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    throw journalError('mutation_path_invalid', 'mutation journal path must be a non-empty string');
  }
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, requestedPath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
    throw journalError('mutation_path_invalid', 'mutation journal path escapes the current worktree', { path: requestedPath });
  }
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (relative === '.git' || relative.startsWith('.git/')) {
    throw journalError('mutation_path_invalid', 'mutation journal cannot target .git', { path: relative });
  }
  return relative;
}

function normalizeFingerprint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.exists === false) return { exists: false };
  if (
    input.exists !== true ||
    !Number.isSafeInteger(input.mode) ||
    input.mode < 0 ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    typeof input.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  ) return null;
  return {
    exists: true,
    mode: input.mode,
    size: input.size,
    sha256: input.sha256,
  };
}

function normalizePrior(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.existed === false) return { existed: false };
  if (
    input.existed !== true ||
    !Number.isSafeInteger(input.mode) ||
    input.mode < 0 ||
    typeof input.content_base64 !== 'string'
  ) return null;
  let content;
  try {
    content = Buffer.from(input.content_base64, 'base64');
  } catch {
    return null;
  }
  if (content.length > MUTATION_JOURNAL_MAX_PRIOR_BYTES) return null;
  return {
    existed: true,
    mode: input.mode,
    content_base64: content.toString('base64'),
  };
}

function normalizeEntry(cwd, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (typeof input.id !== 'string' || !/^mutation-[a-f0-9-]{36}$/.test(input.id)) return null;
  const prior = normalizePrior(input.prior);
  const post = normalizeFingerprint(input.post);
  if (!prior || !post) return null;
  let relative;
  try {
    relative = canonicalPath(cwd, input.path);
  } catch {
    return null;
  }
  const disposition = ['publishable', 'temporary', 'baseline-recovery'].includes(input.disposition)
    ? input.disposition
    : 'unknown';
  return {
    id: input.id,
    path: relative,
    tool: typeof input.tool === 'string' ? input.tool.slice(0, 80) : 'unknown',
    disposition,
    prior,
    post,
  };
}

function normalizeLocalOnlyBarrier(cwd, input) {
  if (input == null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (typeof input.id !== 'string' || !/^local-only-[a-f0-9-]{36}$/.test(input.id)) return null;
  const post = normalizeFingerprint(input.post);
  if (!post) return null;
  let relative;
  try {
    relative = canonicalPath(cwd, input.path);
  } catch {
    return null;
  }
  return {
    id: input.id,
    path: relative,
    tool: typeof input.tool === 'string' ? input.tool.slice(0, 80) : 'unknown',
    post,
  };
}

function priorBytes(entry) {
  return entry.prior.existed ? Buffer.from(entry.prior.content_base64, 'base64').length : 0;
}

export function normalizeMutationJournalState(cwd, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.schema_version !== JOURNAL_SCHEMA_VERSION || !Array.isArray(input.entries)) return null;
  if (input.entries.length > MUTATION_JOURNAL_MAX_ENTRIES) return null;

  const entries = [];
  const ids = new Set();
  let totalPriorBytes = 0;
  for (const raw of input.entries) {
    const entry = normalizeEntry(cwd, raw);
    if (!entry || ids.has(entry.id)) return null;
    ids.add(entry.id);
    totalPriorBytes += priorBytes(entry);
    if (totalPriorBytes > MUTATION_JOURNAL_MAX_TOTAL_PRIOR_BYTES) return null;
    entries.push(entry);
  }
  const localOnlyBarrier = normalizeLocalOnlyBarrier(cwd, input.local_only_barrier);
  if (input.local_only_barrier != null && !localOnlyBarrier) return null;
  return {
    schema_version: JOURNAL_SCHEMA_VERSION,
    entries,
    ...(localOnlyBarrier ? { local_only_barrier: localOnlyBarrier } : {}),
  };
}

function stateFromJson(cwd, raw) {
  if (!raw) return null;
  try {
    return normalizeMutationJournalState(cwd, JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readMutationJournalFile(cwd, target) {
  if (!target || !fs.existsSync(target) || !fs.statSync(target).size) return null;
  const state = stateFromJson(cwd, fs.readFileSync(target, 'utf8'));
  if (!state) {
    throw journalError('mutation_journal_corrupt', 'persisted mutation journal is invalid; refusing to discard undo provenance', {
      journal_file: target,
    });
  }
  return state;
}

function bootstrapState(cwd, env) {
  const raw = String(env?.PI_MUTATION_JOURNAL_STATE ?? '').trim();
  if (!raw) return null;
  const state = stateFromJson(cwd, raw);
  if (!state) {
    throw journalError('mutation_journal_corrupt', 'bootstrap mutation journal state is invalid; refusing to discard undo provenance');
  }
  return state;
}

function stateFor(cwd, env = process.env) {
  const root = path.resolve(cwd);
  const persisted = readMutationJournalFile(root, sidecarPath(env));
  if (persisted) {
    states.set(root, persisted);
    return persisted;
  }
  const cached = states.get(root);
  if (cached) return cached;
  const state = bootstrapState(root, env) ?? { schema_version: JOURNAL_SCHEMA_VERSION, entries: [] };
  states.set(root, state);
  persistState(root, state, env);
  return state;
}

function persistState(cwd, state, env) {
  const root = path.resolve(cwd);
  const normalized = normalizeMutationJournalState(root, state);
  if (!normalized) throw journalError('mutation_journal_invalid', 'mutation journal state is invalid');
  const target = sidecarPath(env);
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  }
  // The in-process state becomes authoritative only after the durable sidecar write succeeds.
  states.set(root, normalized);
  return normalized;
}

export function writeMutationJournalFile(cwd, target, state) {
  if (!target) throw new Error('mutation journal target is required');
  const normalized = normalizeMutationJournalState(cwd, state);
  if (!normalized) throw journalError('mutation_journal_invalid', 'mutation journal state is invalid');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
  return normalized;
}

export function mutationJournalState(cwd, env = process.env) {
  return structuredClone(stateFor(cwd, env));
}

export function encodeMutationJournalState(cwd, state) {
  const normalized = normalizeMutationJournalState(cwd, state);
  if (!normalized) throw journalError('mutation_journal_invalid', 'mutation journal state is invalid');
  return gzipSync(Buffer.from(JSON.stringify(normalized), 'utf8'), { level: 9 }).toString('base64url');
}

export function decodeMutationJournalState(cwd, encoded) {
  if (typeof encoded !== 'string' || !encoded) return null;
  try {
    const decoded = gunzipSync(Buffer.from(encoded, 'base64url')).toString('utf8');
    return stateFromJson(cwd, decoded);
  } catch {
    return null;
  }
}

export function snapshotFingerprint(snapshot) {
  if (!snapshot || snapshot.existed === false) return { exists: false };
  if (!Buffer.isBuffer(snapshot.content) || !Number.isSafeInteger(snapshot.mode)) {
    throw journalError('mutation_snapshot_invalid', 'mutation snapshot is missing bytes or mode');
  }
  return {
    exists: true,
    mode: snapshot.mode,
    size: snapshot.content.length,
    sha256: digest(snapshot.content),
  };
}

export function currentMutationFingerprint(cwd, requestedPath) {
  const target = resolveMutationTarget(cwd, requestedPath);
  if (!target.exists) return { exists: false };
  const stat = fs.lstatSync(target.absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw journalError('mutation_undo_unsafe_target', 'mutation undo requires a regular non-symlink file', { path: target.relative });
  }
  if (stat.nlink > 1) {
    throw journalError('mutation_undo_unsafe_target', 'mutation undo refuses hard-linked files', { path: target.relative });
  }
  const content = fs.readFileSync(target.absolutePath);
  return {
    exists: true,
    mode: stat.mode & 0o7777,
    size: content.length,
    sha256: digest(content),
  };
}

function fingerprintsEqual(left, right) {
  if (!left || !right || left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return left.mode === right.mode && left.size === right.size && left.sha256 === right.sha256;
}

function priorFingerprint(prior) {
  if (!prior?.existed) return { exists: false };
  const content = Buffer.from(prior.content_base64, 'base64');
  return {
    exists: true,
    mode: prior.mode,
    size: content.length,
    sha256: digest(content),
  };
}

export function isMutationJournalCapacityError(error) {
  return CAPACITY_ERROR_CODES.has(String(error?.code ?? ''));
}

export function mutationJournalCapacityStatus(args) {
  try {
    assertMutationJournalCapacity(args);
    return { journalable: true, code: null, reason: null };
  } catch (error) {
    if (!isMutationJournalCapacityError(error)) throw error;
    return {
      journalable: false,
      code: error.code,
      reason: String(error?.message ?? error),
    };
  }
}

export function assertMutationJournalCapacity({ cwd, snapshot, env = process.env }) {
  if (!snapshot) throw journalError('mutation_snapshot_invalid', 'mutation snapshot is required');
  const state = stateFor(cwd, env);
  const bytes = snapshot.existed && Buffer.isBuffer(snapshot.content) ? snapshot.content.length : 0;
  if (bytes > MUTATION_JOURNAL_MAX_PRIOR_BYTES) {
    throw journalError(
      'mutation_journal_snapshot_too_large',
      `target is too large for bounded selective undo (${bytes} bytes)`,
      { path: canonicalPath(cwd, snapshot.path), max_bytes: MUTATION_JOURNAL_MAX_PRIOR_BYTES },
    );
  }
  const total = state.entries.reduce((sum, entry) => sum + priorBytes(entry), 0);
  if (state.entries.length >= MUTATION_JOURNAL_MAX_ENTRIES) {
    throw journalError('mutation_journal_full', 'bounded mutation journal entry limit reached', { max_entries: MUTATION_JOURNAL_MAX_ENTRIES });
  }
  if (total + bytes > MUTATION_JOURNAL_MAX_TOTAL_PRIOR_BYTES) {
    throw journalError(
      'mutation_journal_full',
      'bounded mutation journal byte limit reached',
      { max_bytes: MUTATION_JOURNAL_MAX_TOTAL_PRIOR_BYTES },
    );
  }

  // Keep the checkpoint representation bounded as a recovery-metadata policy even though commit
  // messages are now supplied through -F rather than argv. Use deterministic high-entropy
  // placeholder id/hash values: repeated zeros compress unrealistically well and can understate
  // the encoded size near the soft checkpoint limit.
  const relative = canonicalPath(cwd, snapshot.path);
  const projectionSeed = digest(Buffer.from(
    `${relative}\0${state.entries.length}\0${bytes}\0${snapshot.existed ? digest(snapshot.content) : 'missing'}`,
    'utf8',
  ));
  const projectedId =
    `mutation-${projectionSeed.slice(0, 8)}-${projectionSeed.slice(8, 12)}-${projectionSeed.slice(12, 16)}-${projectionSeed.slice(16, 20)}-${projectionSeed.slice(20, 32)}`;
  const projectedPostSha = digest(Buffer.from(`post:${projectionSeed}`, 'utf8'));
  const projected = {
    schema_version: JOURNAL_SCHEMA_VERSION,
    entries: [...state.entries, {
      id: projectedId,
      path: relative,
      tool: 'structural_edit',
      disposition: 'baseline-recovery',
      prior: snapshot.existed
        ? { existed: true, mode: snapshot.mode, content_base64: snapshot.content.toString('base64') }
        : { existed: false },
      post: snapshot.existed
        ? { exists: true, mode: snapshot.mode, size: snapshot.content.length, sha256: projectedPostSha }
        : { exists: true, mode: 0o644, size: 0, sha256: projectedPostSha },
    }],
  };
  const encodedBytes = Buffer.byteLength(encodeMutationJournalState(cwd, projected), 'utf8');
  if (encodedBytes > MUTATION_JOURNAL_MAX_CHECKPOINT_BYTES) {
    throw journalError(
      'mutation_journal_full',
      'bounded mutation journal checkpoint representation limit reached',
      { max_checkpoint_bytes: MUTATION_JOURNAL_MAX_CHECKPOINT_BYTES, projected_checkpoint_bytes: encodedBytes },
    );
  }
  return true;
}

export function recordSuccessfulMutation({
  cwd,
  before,
  after,
  tool,
  disposition = 'unknown',
  env = process.env,
}) {
  if (!before || !after) throw journalError('mutation_snapshot_invalid', 'before and after snapshots are required');
  assertMutationJournalCapacity({ cwd, snapshot: before, env });
  const relative = canonicalPath(cwd, before.path);
  const state = stateFor(cwd, env);
  const entry = {
    id: `mutation-${randomUUID()}`,
    path: relative,
    tool: typeof tool === 'string' ? tool.slice(0, 80) : 'unknown',
    disposition: ['publishable', 'temporary', 'baseline-recovery'].includes(disposition) ? disposition : 'unknown',
    prior: before.existed
      ? { existed: true, mode: before.mode, content_base64: before.content.toString('base64') }
      : { existed: false },
    post: snapshotFingerprint(after),
  };
  const nextState = {
    schema_version: JOURNAL_SCHEMA_VERSION,
    entries: [...state.entries, entry],
    // A newly journaled mutation is now the shared latest mutation, so any older local-only
    // barrier is superseded. Do not carry it forward.
  };
  persistState(cwd, nextState, env);
  return structuredClone(entry);
}

export function markMutationJournalLocalOnly({
  cwd,
  after,
  tool,
  env = process.env,
}) {
  if (!after) throw journalError('mutation_snapshot_invalid', 'post-mutation snapshot is required');
  const state = stateFor(cwd, env);
  const marker = {
    id: `local-only-${randomUUID()}`,
    path: canonicalPath(cwd, after.path),
    tool: typeof tool === 'string' ? tool.slice(0, 80) : 'unknown',
    post: snapshotFingerprint(after),
  };
  persistState(cwd, {
    schema_version: JOURNAL_SCHEMA_VERSION,
    entries: state.entries,
    local_only_barrier: marker,
  }, env);
  return structuredClone(marker);
}

export function clearMutationJournalLocalOnly({
  cwd,
  markerId,
  env = process.env,
}) {
  if (typeof markerId !== 'string' || !markerId) {
    throw journalError('mutation_local_only_marker_required', 'local-only marker id is required');
  }
  const state = stateFor(cwd, env);
  const marker = state.local_only_barrier ?? null;
  if (!marker) return null;
  if (marker.id !== markerId) {
    throw journalError(
      'mutation_local_only_marker_changed',
      'the shared latest local-only mutation changed; refusing to clear a newer barrier',
      { expected_marker_id: markerId, actual_marker_id: marker.id },
    );
  }
  persistState(cwd, {
    schema_version: JOURNAL_SCHEMA_VERSION,
    entries: state.entries,
  }, env);
  return structuredClone(marker);
}

function entryById(cwd, mutationId, env) {
  const state = stateFor(cwd, env);
  return { state, entry: state.entries.find(item => item.id === mutationId) ?? null };
}

export function actionableMutationEntries(cwd, env = process.env, { paths = null } = {}) {
  const allowedPaths = paths ? new Set(paths.map(item => canonicalPath(cwd, item))) : null;
  const state = stateFor(cwd, env);
  const result = [];
  for (const entry of state.entries) {
    if (allowedPaths && !allowedPaths.has(entry.path)) continue;
    if (isControlPlanePath(entry.path)) continue;
    try {
      const current = currentMutationFingerprint(cwd, entry.path);
      if (fingerprintsEqual(current, entry.post)) result.push(structuredClone(entry));
    } catch {
      // Unsafe or missing target state is deliberately not advertised as actionable.
    }
  }
  return result;
}

export function latestActionableMutation(cwd, env = process.env) {
  return actionableMutationEntries(cwd, env).at(-1) ?? null;
}

export function mutationCleanupHints(cwd, paths, env = process.env) {
  return actionableMutationEntries(cwd, env, { paths }).map(entry => ({
    mutation_id: entry.id,
    path: entry.path,
    disposition: entry.disposition,
    action: 'undo_mutation',
  }));
}

function restorePrior(target, prior) {
  if (!prior.existed) {
    if (fs.existsSync(target.absolutePath)) fs.unlinkSync(target.absolutePath);
    return 'delete';
  }
  const content = Buffer.from(prior.content_base64, 'base64');
  fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
  const temp = `${target.absolutePath}.pi-undo-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temp, content, { mode: prior.mode });
  fs.chmodSync(temp, prior.mode);
  fs.renameSync(temp, target.absolutePath);
  return 'restore';
}

export function undoMutation({
  cwd,
  mutationId,
  reason,
  ledgerPath = null,
  env = process.env,
}) {
  if (typeof mutationId !== 'string' || !mutationId) throw journalError('mutation_id_required', 'mutation_id is required');
  if (typeof reason !== 'string' || !reason.trim()) throw journalError('mutation_undo_reason_required', 'mutation undo requires a reason');
  const { state, entry } = entryById(cwd, mutationId, env);
  if (!entry) throw journalError('mutation_not_found', 'mutation id is not active in the journal', { mutation_id: mutationId });

  const target = resolveMutationTarget(cwd, entry.path);
  if (isControlPlanePath(entry.path)) {
    throw journalError('mutation_undo_protected_path', 'selective undo cannot modify a protected control-plane path', {
      mutation_id: mutationId,
      path: entry.path,
    });
  }
  if (ledgerPath) fs.closeSync(fs.openSync(ledgerPath, 'a', 0o600));

  const current = currentMutationFingerprint(cwd, entry.path);
  const expectedPrior = priorFingerprint(entry.prior);
  let action;
  let alreadyRestored = false;
  if (fingerprintsEqual(current, entry.post)) {
    action = restorePrior(target, entry.prior);
  } else if (fingerprintsEqual(current, expectedPrior)) {
    // A previous undo may have restored the file successfully and then failed while persisting
    // the journal update. Treat that prior-state as an idempotent retry, not a stale conflict.
    action = entry.prior.existed ? 'restore' : 'delete';
    alreadyRestored = true;
  } else {
    throw journalError('mutation_undo_conflict', 'current file state matches neither this mutation post-state nor its exact prior-state; refusing to overwrite intervening work', {
      mutation_id: mutationId,
      path: entry.path,
      expected_post: entry.post,
      expected_prior: expectedPrior,
      actual: current,
    });
  }

  const nextState = {
    schema_version: JOURNAL_SCHEMA_VERSION,
    entries: state.entries.filter(item => item.id !== mutationId),
    ...(state.local_only_barrier ? { local_only_barrier: state.local_only_barrier } : {}),
  };
  try {
    persistState(cwd, nextState, env);
  } catch (error) {
    throw journalError(
      'mutation_undo_persist_failed',
      'file state is already restored but the journal update could not be persisted; retry the same mutation_id to finish idempotently',
      {
        mutation_id: mutationId,
        path: entry.path,
        already_restored: true,
        cause: String(error?.message ?? error),
      },
    );
  }
  return {
    status: 'recovered',
    action,
    already_restored: alreadyRestored,
    mutation_id: mutationId,
    path: entry.path,
    disposition: entry.disposition,
    reason: reason.trim(),
  };
}
