import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveMutationTarget } from './mutation-target.mjs';
import { assertImplementerFileSet } from './implementer-result.mjs';
import { appendCheckRecord, resolveValidationRunId } from './validation-ledger.mjs';
import { isControlPlanePath } from './control-plane-policy.mjs';
import { worktreeFingerprint } from './worktree-baseline.mjs';

function git(cwd, args, encoding = 'utf8') {
  return execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd, encoding, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
  });
}
const paths = value => value.split('\0').filter(Boolean);

export function worktreeChangedFiles(cwd, base) {
  return [...new Set([
    ...paths(git(cwd, ['diff', '--no-renames', '--name-only', '-z', base])),
    ...paths(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ])].sort();
}

function recoveryRefusal(code, message, extra = {}) {
  const error = new Error(JSON.stringify({ code, ...extra, message }));
  error.code = code;
  return error;
}

// Ownership evidence for deleting an untracked path that has no mutation id (#438). `baseline` is
// the trusted run-start untracked set (null = identity unavailable), `acceptedPaths` the accepted
// task scope, `journalPaths` a Map path -> mutation_id for journaled mutations (#424/#436).
function untrackedOwnership(relative, { baseline, acceptedPaths, journalPaths }) {
  if (isControlPlanePath(relative)) return { owned: false, code: 'recovery_protected_path', reason: 'protected control-plane path' };
  if (journalPaths?.has(relative)) {
    return { owned: false, code: 'recovery_use_undo_mutation', reason: 'path is journaled; use undo_mutation', mutation_id: journalPaths.get(relative) };
  }
  if (!baseline) return { owned: false, code: 'recovery_baseline_unavailable', reason: 'run-start baseline is unavailable, so ownership cannot be proven' };
  if (baseline.untracked.has(relative)) return { owned: false, code: 'recovery_preexisting_path', reason: 'path existed before this stage started' };
  if (acceptedPaths?.has(relative)) return { owned: false, code: 'recovery_accepted_scope_path', reason: 'path is part of the accepted task scope' };
  return { owned: true };
}

// A tracked restore discards the current bytes, so require proof they are this stage's own: the
// path is not journaled (undo_mutation owns that), and it was clean against HEAD at run start.
function trackedRestoreOwnership(relative, { baseline, journalPaths, observed, cwd }) {
  if (isControlPlanePath(relative)) return { owned: false, code: 'recovery_protected_path', reason: 'protected control-plane path' };
  if (journalPaths?.has(relative)) {
    return { owned: false, code: 'recovery_use_undo_mutation', reason: 'path is journaled; use undo_mutation', mutation_id: journalPaths.get(relative) };
  }
  if (!baseline) return { owned: false, code: 'recovery_baseline_unavailable', reason: 'run-start baseline is unavailable, so the current bytes cannot be proven safe to discard' };
  if (baseline.trackedDirty.has(relative)) return { owned: false, code: 'recovery_preexisting_path', reason: 'tracked path already differed from HEAD before this stage started' };
  // Clean at run start is not enough: the current bytes must still equal the post-state the
  // runtime observed after a stage action, otherwise an external rewrite would be discarded.
  if (!observed) return { owned: false, code: 'recovery_baseline_unavailable', reason: 'observed post-state is unavailable, so the current bytes cannot be proven safe to discard' };
  if (observed.tainted.has(relative)) return { owned: false, code: 'recovery_externally_modified', reason: 'tracked path changed outside an observed stage action' };
  const expected = observed.fingerprints.get(relative);
  if (!expected) return { owned: false, code: 'recovery_unobserved_change', reason: 'tracked change was not observed as the result of a stage action' };
  if (worktreeFingerprint(cwd, relative) !== expected) return { owned: false, code: 'recovery_externally_modified', reason: 'current bytes differ from the observed stage post-state' };
  return { owned: true };
}

// Classify every unexpected changed path so diagnostics name the exact callable recovery action:
// journaled (undo_mutation), safely-cleanable unjournaled (recover_worktree), or unknown/protected.
export function classifyWorktreeDrift({ cwd, changed, expectedFiles = [], baseline = null, acceptedPaths = null, journalPaths = null, observed = null }) {
  const expected = new Set(expectedFiles);
  const result = [];
  for (const file of changed) {
    if (expected.has(file)) continue;
    if (isControlPlanePath(file)) {
      result.push({ path: file, class: 'unknown', reason: 'protected control-plane path' });
      continue;
    }
    if (journalPaths?.has(file)) {
      result.push({ path: file, class: 'journaled', action: 'undo_mutation', mutation_id: journalPaths.get(file) });
      continue;
    }
    const inHead = paths(git(cwd, ['ls-tree', '-z', 'HEAD', '--', file])).length > 0;
    if (inHead) {
      const ownership = trackedRestoreOwnership(file, { baseline, journalPaths, observed, cwd });
      result.push(ownership.owned
        ? { path: file, class: 'unjournaled_restorable', action: 'recover_worktree', recover_action: 'revert_tracked' }
        : { path: file, class: 'unknown', reason: ownership.reason });
      continue;
    }
    const tracked = paths(git(cwd, ['ls-files', '-z', '--', file])).length > 0;
    if (tracked) {
      result.push({ path: file, class: 'unknown', reason: 'staged addition has no baseline in HEAD' });
      continue;
    }
    const ownership = untrackedOwnership(file, { baseline, acceptedPaths, journalPaths });
    result.push(ownership.owned
      ? { path: file, class: 'unjournaled_cleanable', action: 'recover_worktree', recover_action: 'delete_untracked' }
      : { path: file, class: 'unknown', reason: ownership.reason });
  }
  return result;
}

// One file per action, no model-supplied command, recursion, glob, or Git ref.
export function recoverWorktree({ cwd, action, path: requestedPath, expected_files, reason, base = 'HEAD', ledgerPath, baseline = null, acceptedPaths = null, journalPaths = null, observed = null }) {
  if (!ledgerPath) throw new Error('Recovery requires the runtime validation ledger');
  if (!Array.isArray(expected_files) || expected_files.some(file => typeof file !== 'string')) {
    throw new Error('expected_files must declare the intended final file set');
  }
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Recovery requires a reason');
  if (!['delete_untracked', 'revert_tracked'].includes(action)) throw new Error('Unknown recovery action');
  const target = resolveMutationTarget(cwd, requestedPath);
  const parts = target.relative.split(path.sep);
  if (parts.includes('.git') || parts.includes('.gitignore')) throw new Error('Recovery cannot modify Git metadata or ignore policy');
  // Refuse embedded repositories too; their index/HEAD is a separate authority.
  for (let i = 1; i < parts.length; i++) {
    if (fs.existsSync(path.join(target.root, ...parts.slice(0, i), '.git'))) throw new Error('Recovery cannot enter an embedded repository');
  }
  if (isControlPlanePath(target.relative)) {
    throw recoveryRefusal('recovery_protected_path', 'Recovery cannot modify protected control-plane paths', { path: target.relative });
  }
  if (target.exists && fs.statSync(target.absolutePath).nlink > 1) throw new Error('Recovery refuses hard-linked files');
  // Resolve the base before mutating, so invalid refs never leave a partial cleanup.
  git(cwd, ['rev-parse', '--verify', `${base}^{commit}`]);
  const tracked = paths(git(cwd, ['ls-files', '-z', '--', target.relative]));
  // Refuse recovery before changing files when the audit destination is unavailable.
  fs.closeSync(fs.openSync(ledgerPath, 'a', 0o600));
  if (action === 'delete_untracked') {
    if (tracked.length || !target.exists) throw new Error('delete_untracked requires an existing untracked regular file');
    const untracked = paths(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', target.relative]));
    if (!untracked.includes(target.relative)) throw new Error('Recovery refuses ignored files');
    const ownership = untrackedOwnership(target.relative, { baseline, acceptedPaths, journalPaths });
    if (!ownership.owned) {
      const { owned: _owned, ...detail } = ownership;
      throw recoveryRefusal(ownership.code, `Refusing to delete ${target.relative}: ${ownership.reason}`, { path: target.relative, ...detail });
    }
    fs.unlinkSync(target.absolutePath);
  } else {
    const ownership = trackedRestoreOwnership(target.relative, { baseline, journalPaths, observed, cwd });
    if (!ownership.owned) {
      const { owned: _owned, ...detail } = ownership;
      throw recoveryRefusal(ownership.code, `Refusing to restore ${target.relative}: ${ownership.reason}`, { path: target.relative, ...detail });
    }
    const entries = paths(git(cwd, ['ls-tree', '-z', 'HEAD', '--', target.relative]));
    const entry = entries.find(item => item.split('\t')[1] === target.relative);
    if (!entry || !/^100(?:644|755) blob /.test(entry)) throw new Error('revert_tracked requires a regular file tracked in HEAD');
    const oid = entry.split(' ')[2].split('\t')[0];
    const content = git(cwd, ['cat-file', 'blob', oid], null);
    // Restore both index and worktree, including deleted files and executable mode.
    git(cwd, ['reset', '-q', 'HEAD', '--', target.relative]);
    fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
    fs.writeFileSync(target.absolutePath, content);
    fs.chmodSync(target.absolutePath, entry.startsWith('100755') ? 0o755 : 0o644);
  }
  let fileSet;
  try {
    const changed = worktreeChangedFiles(cwd, base);
    try {
      assertImplementerFileSet(changed, expected_files);
      fileSet = { status: 'pass', changed_files: changed };
    } catch (error) {
      fileSet = {
        status: 'invalid',
        changed_files: changed,
        summary: error.message,
        drift: classifyWorktreeDrift({ cwd, changed, expectedFiles: expected_files, baseline, acceptedPaths, journalPaths, observed }),
      };
    }
  } catch (error) {
    fileSet = { status: 'infra_error', summary: error.message };
  }
  const result = { status: 'recovered', action, path: target.relative, reason, file_set: fileSet };
  appendCheckRecord(ledgerPath, {
    run_id: resolveValidationRunId(), stage: 'implementer', backend: 'pi', source: 'worktree_recovery',
    kind: action, scope: { paths: [target.relative] }, status: 'pass', summary: reason,
    mutation: result,
  });
  return result;
}
