import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveMutationTarget } from './mutation-target.mjs';
import { assertImplementerFileSet } from './implementer-result.mjs';
import { appendCheckRecord, resolveValidationRunId } from './validation-ledger.mjs';

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

// One file per action, no model-supplied command, recursion, glob, or Git ref.
export function recoverWorktree({ cwd, action, path: requestedPath, expected_files, reason, base = 'HEAD', ledgerPath }) {
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
    fs.unlinkSync(target.absolutePath);
  } else {
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
      fileSet = { status: 'invalid', changed_files: changed, summary: error.message };
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
