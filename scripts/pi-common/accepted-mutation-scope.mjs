import fs from 'node:fs';
import path from 'node:path';

import { runGit as git } from './git.mjs';
import { baseRef } from './project-config.mjs';

const SCOPE_SCHEMA_VERSION = 1;
const states = new Map();

const gitPaths = text => text.split('\0').filter(Boolean);

function scopePathError(message) {
  const error = new Error(message);
  error.code = 'scope_invalid_path';
  return error;
}

function canonicalPath(cwd, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    throw scopePathError('mutation scope paths must be non-empty strings');
  }
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, requestedPath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
    throw scopePathError(`mutation scope path escapes the current worktree: ${requestedPath}`);
  }
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (relative === '.git' || relative.startsWith('.git/')) {
    throw scopePathError('mutation scope cannot target .git');
  }
  return relative;
}

function changedPaths(cwd, base = baseRef()) {
  const tracked = gitPaths(git(['diff', '--no-renames', '--name-only', '-z', base, '--'], { cwd }).out);
  const untracked = gitPaths(git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd }).out);
  return [...new Set([...tracked, ...untracked])].sort();
}

function normalizeEntries(cwd, entries) {
  if (!Array.isArray(entries)) return [];
  const result = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rationale = typeof entry.rationale === 'string' ? entry.rationale.trim() : '';
    if (!rationale) continue;
    const normalized = canonicalPath(cwd, entry.path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ path: normalized, rationale });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export function normalizeMutationScopeReceipt(cwd, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.schema_version !== SCOPE_SCHEMA_VERSION) return null;
  return {
    schema_version: SCOPE_SCHEMA_VERSION,
    accepted: normalizeEntries(cwd, input.accepted),
    temporary: normalizeEntries(cwd, input.temporary),
    baseline: Array.isArray(input.baseline)
      ? [...new Set(input.baseline.map(item => canonicalPath(cwd, item)))].sort()
      : [],
  };
}

function receiptFromJson(cwd, raw) {
  if (!raw) return null;
  try {
    return normalizeMutationScopeReceipt(cwd, JSON.parse(raw));
  } catch {
    return null;
  }
}

function bootstrapReceipt(cwd, env) {
  return receiptFromJson(cwd, String(env?.PI_ACCEPTED_MUTATION_SCOPE_STATE ?? '').trim());
}

function sidecarPath(env) {
  const value = String(env?.PI_ACCEPTED_MUTATION_SCOPE_FILE ?? '').trim();
  return value || null;
}

export function readMutationScopeReceiptFile(cwd, target) {
  if (!target || !fs.existsSync(target) || !fs.statSync(target).size) return null;
  try {
    return normalizeMutationScopeReceipt(cwd, JSON.parse(fs.readFileSync(target, 'utf8')));
  } catch {
    return null;
  }
}

function persistedReceipt(cwd, env) {
  return readMutationScopeReceiptFile(cwd, sidecarPath(env));
}

function mergeReceiptIntoState(state, receipt) {
  if (!receipt) return state;
  for (const entry of receipt.accepted ?? []) state.accepted.set(entry.path, entry.rationale);
  for (const entry of receipt.temporary ?? []) state.temporary.set(entry.path, entry.rationale);
  for (const item of receipt.baseline ?? []) state.baseline.add(item);
  return state;
}

function receiptFromState(state) {
  const entries = map => [...map.entries()]
    .map(([path, rationale]) => ({ path, rationale }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema_version: SCOPE_SCHEMA_VERSION,
    accepted: entries(state.accepted),
    temporary: entries(state.temporary),
    baseline: [...state.baseline].sort(),
  };
}

function persistState(state, env) {
  const target = sidecarPath(env);
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(receiptFromState(state), null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
}

function refreshPersistedState(state, env) {
  mergeReceiptIntoState(state, persistedReceipt(state.root, env));
  return state;
}

export function initializeMutationScope(cwd, env = process.env) {
  const root = path.resolve(cwd);
  const existing = states.get(root);
  if (existing) return refreshPersistedState(existing, env);

  const state = {
    root,
    accepted: new Map(),
    temporary: new Map(),
    baseline: new Set(changedPaths(root)),
  };
  mergeReceiptIntoState(state, bootstrapReceipt(root, env));
  mergeReceiptIntoState(state, persistedReceipt(root, env));
  states.set(root, state);
  persistState(state, env);
  return state;
}

export function mutationScopeReceipt(cwd, env = process.env) {
  return receiptFromState(initializeMutationScope(cwd, env));
}

export function registerMutationScope({
  cwd,
  paths,
  disposition = 'publishable',
  rationale,
  env = process.env,
}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('accept_mutation_scope requires at least one path');
  }
  if (!['publishable', 'temporary'].includes(disposition)) {
    throw new Error('mutation scope disposition must be publishable or temporary');
  }
  const reason = typeof rationale === 'string' ? rationale.trim() : '';
  if (reason.length < 8) throw new Error('mutation scope rationale must explain why the paths are needed');

  const state = initializeMutationScope(cwd, env);
  const normalized = [...new Set(paths.map(item => canonicalPath(state.root, item)))].sort();
  const changed = new Set(changedPaths(state.root));
  const alreadyKnown = pathName => state.accepted.has(pathName) || state.temporary.has(pathName);

  if (disposition === 'publishable') {
    const retroactive = normalized.filter(pathName => changed.has(pathName) && !alreadyKnown(pathName));
    if (retroactive.length) {
      const error = new Error(JSON.stringify({
        code: 'scope_retroactive_publishable_rejected',
        paths: retroactive,
        recovery: 'Remove or restore these paths first. A publishable scope amendment must be accepted before the path becomes changed. Restored baseline paths without a trusted receipt cannot be retroactively authorized; delete or restore them to dev.',
      }));
      error.code = 'scope_retroactive_publishable_rejected';
      throw error;
    }
  }

  const destination = disposition === 'publishable' ? state.accepted : state.temporary;
  for (const pathName of normalized) {
    if (disposition === 'publishable' && state.temporary.has(pathName)) {
      if (!changed.has(pathName)) {
        // A temporary path becomes eligible again only after it is fully absent/restored.
        // Removing the old temporary receipt makes the documented cleanup route real:
        // accept it again *before* a new publishable mutation.
        state.temporary.delete(pathName);
      } else {
        const error = new Error(JSON.stringify({
          code: 'scope_temporary_promotion_rejected',
          paths: [pathName],
          recovery: 'Temporary paths cannot be promoted while they are changed. Remove or restore the temporary artifact, then accept the clean path before a new publishable mutation.',
        }));
        error.code = 'scope_temporary_promotion_rejected';
        throw error;
      }
    }
    destination.set(pathName, reason);
  }

  persistState(state, env);
  return {
    disposition,
    paths: normalized,
    receipt: receiptFromState(state),
  };
}

export function assertMutationPathAuthorized({ cwd, requestedPath, env = process.env }) {
  const state = initializeMutationScope(cwd, env);
  const pathName = canonicalPath(state.root, requestedPath);
  if (state.accepted.has(pathName)) return { path: pathName, disposition: 'publishable' };
  if (state.temporary.has(pathName)) return { path: pathName, disposition: 'temporary' };
  if (state.baseline.has(pathName)) return { path: pathName, disposition: 'baseline-recovery' };

  const error = new Error(JSON.stringify({
    code: 'mutation_scope_required',
    path: pathName,
    recovery: 'Call accept_mutation_scope before mutating a new publishable path. For scratch work, register it as temporary; temporary paths must be removed before publication.',
  }));
  error.code = 'mutation_scope_required';
  throw error;
}

export function assertAcceptedMutationScope({ cwd, receipt, base = baseRef() }) {
  const normalized = normalizeMutationScopeReceipt(cwd, receipt);
  if (!normalized) {
    throw new Error(JSON.stringify({
      code: 'accepted_scope_missing',
      unexpected_paths: changedPaths(cwd, base),
      recovery: 'A trusted accepted mutation scope receipt is required before publication.',
    }));
  }

  const changed = changedPaths(cwd, base);
  const accepted = new Set(normalized.accepted.map(entry => entry.path));
  const temporary = new Set(normalized.temporary.map(entry => entry.path));
  const baseline = new Set(normalized.baseline);

  const temporaryPaths = changed.filter(pathName => temporary.has(pathName));
  const unexpectedPaths = changed.filter(pathName => !accepted.has(pathName) && !temporary.has(pathName));
  const baselinePaths = unexpectedPaths.filter(pathName => baseline.has(pathName));

  if (temporaryPaths.length || unexpectedPaths.length) {
    throw new Error(JSON.stringify({
      code: 'accepted_scope_violation',
      unexpected_paths: unexpectedPaths,
      temporary_paths: temporaryPaths,
      baseline_unaccepted_paths: baselinePaths,
      recovery: 'Remove or restore every unexpected/temporary path. Publishable scope cannot be granted retroactively after a path is already changed. Baseline paths restored without a trusted receipt are cleanup-only: delete them or restore them to dev.',
    }));
  }
  return changed;
}
