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
  return resolveMutationTarget(cwd, requestedPath).relative.split(path.sep).join('/');
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
  return { schema_version: JOURNAL_SCHEMA_VERSION, entries };
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
  return stateFromJson(cwd, fs.readFileSync(target, 'utf8'));
}

function bootstrapState(cwd, env) {
  return stateFromJson(cwd, String(env?.PI_MUTATION_JOURNAL_STATE ?? '').trim());
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
  states.set(root, normalized);
  const target = sidecarPath(env);
  if (!target) return normalized;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
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
  state.entries.push(entry);
  persistState(cwd, state, env);
  return structuredClone(entry);
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
  if (!fingerprintsEqual(current, entry.post)) {
    throw journalError('mutation_undo_conflict', 'current file state no longer matches this mutation post-state; refusing to overwrite intervening work', {
      mutation_id: mutationId,
      path: entry.path,
      expected_post: entry.post,
      actual: current,
    });
  }

  const action = restorePrior(target, entry.prior);
  const index = state.entries.findIndex(item => item.id === mutationId);
  state.entries.splice(index, 1);
  persistState(cwd, state, env);
  return {
    status: 'recovered',
    action,
    mutation_id: mutationId,
    path: entry.path,
    disposition: entry.disposition,
    reason: reason.trim(),
  };
}
