import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyWorktreeDrift, recoverWorktree, worktreeChangedFiles } from '../scripts/pi-common/worktree-recovery.mjs';
import { assertImplementerFileSet, normalizeImplementerResult } from '../scripts/pi-common/implementer-result.mjs';
import { readValidationLedger, computeVerificationState, VERIFICATION_STATES } from '../scripts/pi-common/validation-ledger.mjs';
import { ProgressController } from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';
import { captureWorktreeBaseline, observeWorktreeDrift, readWorktreeBaseline, readWorktreeObserved, worktreeFingerprint } from '../scripts/pi-common/worktree-baseline.mjs';

const cleanBaseline = (untracked = [], trackedDirty = []) => ({ untracked: new Set(untracked), trackedDirty: new Set(trackedDirty) });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-430-'));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(cwd, 'product.py'), 'original\n');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'ignored.txt\n');
  git('add', '.'); git('commit', '-qm', 'initial');
  const ledgerPath = path.join(root, 'ledger.jsonl');
  const observeNow = () => ({ tainted: new Set(), fingerprints: new Map(worktreeChangedFiles(cwd, 'HEAD').map(file => [file, worktreeFingerprint(cwd, file)])) });
  const recover = params => recoverWorktree({ cwd, ledgerPath, baseline: cleanBaseline(), observed: observeNow(), reason: 'Remove accidental scratch', expected_files: ['product.py'], ...params });
  return { root, cwd, git, recover, ledgerPath };
}

test('#399 removes two root scratch files with direct recovery and validates after each action', t => {
  const { cwd, recover, ledgerPath, git } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'product.py'), 'intended change\n');
  for (const file of ['.probe.txt', '.probe2.txt']) fs.writeFileSync(path.join(cwd, file), 'scratch\n');
  assert.throws(() => assertImplementerFileSet(worktreeChangedFiles(cwd, 'HEAD'), ['product.py']), /scratch artifacts/);
  const first = recover({ action: 'delete_untracked', path: '.probe.txt' });
  assert.equal(first.status, 'recovered'); assert.equal(first.file_set.status, 'invalid');
  const second = recover({ action: 'delete_untracked', path: '.probe2.txt' });
  assert.equal(second.file_set.status, 'pass');
  assert.equal(git('diff', '--', '.gitignore'), '');
  const { records, corrupted } = readValidationLedger(ledgerPath);
  assert.equal(corrupted, false); assert.equal(records.length, 2);
  assert.equal(records[0].source, 'worktree_recovery');
  assert.equal(records[1].mutation.file_set.status, 'pass');
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.NOT_APPLICABLE, 'cleanup is not validation evidence');
  const config = stageConfig('implementer');
  const controller = new ProgressController({ ...config, requireComplexity: false, productiveProgress: { ...config.productiveProgress, startState: 'action_required' } });
  assert.equal(controller.checkToolCall('recover_worktree', {}), undefined);
  controller.onToolExecutionEnd('recover_worktree', false);
  assert.equal(controller.turnMadeProgress, true);
  assert.equal(controller.verificationPermitted(), true);
  assert.ok(config.productiveProgress.codingSessionTools.includes('recover_worktree'));
});

test('recovery restores staged, unstaged and deleted tracked files to HEAD', t => {
  const { cwd, git, recover } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'product.py'), 'staged\n'); git('add', 'product.py');
  fs.writeFileSync(path.join(cwd, 'product.py'), 'unstaged\n');
  assert.equal(recover({ action: 'revert_tracked', path: 'product.py', expected_files: [] }).file_set.status, 'pass');
  assert.equal(fs.readFileSync(path.join(cwd, 'product.py'), 'utf8'), 'original\n');
  assert.equal(git('status', '--porcelain'), '');
  git('rm', '-q', 'product.py');
  recover({ action: 'revert_tracked', path: 'product.py', expected_files: [] });
  assert.equal(git('status', '--porcelain'), '');
});

test('recovery refuses metadata, escapes, links, ignored files, directories and staged additions', t => {
  const { root, cwd, git, recover } = fixture(t);
  fs.writeFileSync(path.join(root, 'outside'), 'outside');
  fs.symlinkSync(root, path.join(cwd, 'link'));
  fs.writeFileSync(path.join(cwd, 'ignored.txt'), 'ignored');
  fs.mkdirSync(path.join(cwd, 'folder'));
  fs.writeFileSync(path.join(cwd, 'added.txt'), 'added'); git('add', 'added.txt');
  fs.linkSync(path.join(root, 'outside'), path.join(cwd, 'hardlink'));
  for (const file of ['.git/config', '.gitignore', '../outside', path.join(root, 'outside'), 'link/outside', 'ignored.txt', 'folder', 'product.py', 'added.txt', 'hardlink']) {
    assert.throws(() => recover({ action: 'delete_untracked', path: file }), undefined, file);
  }
  assert.throws(() => recover({ action: 'revert_tracked', path: 'added.txt' }), /tracked in HEAD/);
  assert.throws(() => recover({ action: 'delete_untracked', path: 'added.txt', ledgerPath: null }), /ledger/);
  assert.equal(fs.readFileSync(path.join(root, 'outside'), 'utf8'), 'outside');
  assert.equal(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8'), 'ignored.txt\n');
});

test('#396 scratch artifacts cannot be declared into successful fresh, restored or repair results', () => {
  for (const file of ['.pi-tmp-placeholder.py', '.probe.txt', '.probe2.txt']) {
    assert.throws(() => assertImplementerFileSet(['product.py', file], ['product.py']), /scratch artifacts/);
    assert.throws(() => normalizeImplementerResult({ title: 'Restored', summary: 'Candidate', changes: ['Recovered work'], files: ['product.py', file] }), /scratch artifacts/);
  }
});

test('an unavailable audit destination cannot leave a cleanup without a ledger record', t => {
  const { cwd, recover } = fixture(t);
  fs.writeFileSync(path.join(cwd, '.probe.txt'), 'scratch');
  assert.throws(() => recover({ action: 'delete_untracked', path: '.probe.txt', ledgerPath: cwd }));
  assert.equal(fs.readFileSync(path.join(cwd, '.probe.txt'), 'utf8'), 'scratch');
});

test('#438 refuses to delete pre-existing untracked user files and unprovable ownership', t => {
  const { cwd, recover } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'user-notes.txt'), 'mine\n');
  fs.writeFileSync(path.join(cwd, 'accepted.py'), 'scope\n');
  fs.writeFileSync(path.join(cwd, 'journaled.txt'), 'j\n');
  const evidence = { baseline: cleanBaseline(['user-notes.txt']), acceptedPaths: new Set(['accepted.py']), journalPaths: new Map([['journaled.txt', 'mutation-x']]) };
  assert.throws(() => recover({ action: 'delete_untracked', path: 'user-notes.txt', ...evidence }), /recovery_preexisting_path/);
  assert.throws(() => recover({ action: 'delete_untracked', path: 'accepted.py', ...evidence }), /recovery_accepted_scope_path/);
  assert.throws(() => recover({ action: 'delete_untracked', path: 'journaled.txt', ...evidence }), /recovery_use_undo_mutation/);
  assert.throws(() => recover({ action: 'delete_untracked', path: 'user-notes.txt', baseline: null }), /recovery_baseline_unavailable/);
  for (const file of ['user-notes.txt', 'accepted.py', 'journaled.txt']) assert.ok(fs.existsSync(path.join(cwd, file)), file);
});

test('#438 deletes a bash-created scratch file proven absent from the run-start baseline', t => {
  const { root, cwd, recover } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'user-notes.txt'), 'mine\n');
  const env = { PI_WORKTREE_BASELINE_FILE: path.join(root, 'baseline.json') };
  assert.equal(captureWorktreeBaseline(cwd, env), true);
  fs.writeFileSync(path.join(cwd, 'scratch.tmp'), 'made by bounded bash\n');
  assert.equal(captureWorktreeBaseline(cwd, env), false, 'baseline is write-once so a fork cannot absorb scratch');
  const baseline = readWorktreeBaseline(env);
  assert.deepEqual([...baseline.untracked], ['user-notes.txt']);
  assert.deepEqual([...baseline.trackedDirty], []);
  const result = recover({ action: 'delete_untracked', path: 'scratch.tmp', baseline, expected_files: [] });
  assert.equal(result.status, 'recovered');
  assert.ok(!fs.existsSync(path.join(cwd, 'scratch.tmp')));
  assert.ok(fs.existsSync(path.join(cwd, 'user-notes.txt')));
  assert.equal(readWorktreeBaseline({}), null);
});

test('#438 refuses protected control-plane paths and restores a tracked file without a journal entry', t => {
  const { cwd, git, recover } = fixture(t);
  fs.mkdirSync(path.join(cwd, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.github', 'workflows', 'x.yml'), 'x');
  assert.throws(() => recover({ action: 'delete_untracked', path: '.github/workflows/x.yml' }), /recovery_protected_path/);
  fs.writeFileSync(path.join(cwd, 'product.py'), 'bash edit\n');
  assert.equal(recover({ action: 'revert_tracked', path: 'product.py', expected_files: [] }).file_set.status, 'invalid');
  assert.equal(git('diff', '--', 'product.py'), '');
});

test('#438 file-set diagnostics distinguish journaled, unjournaled and unknown paths', t => {
  const { cwd, recover } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'product.py'), 'edited\n');
  for (const file of ['journaled.txt', 'scratch.tmp', 'user-notes.txt']) fs.writeFileSync(path.join(cwd, file), 'x');
  const evidence = { baseline: cleanBaseline(['user-notes.txt']), acceptedPaths: new Set(), journalPaths: new Map([['journaled.txt', 'mutation-1']]) };
  const changed = worktreeChangedFiles(cwd, 'HEAD');
  const observed = { tainted: new Set(), fingerprints: new Map([['product.py', worktreeFingerprint(cwd, 'product.py')]]) };
  const drift = classifyWorktreeDrift({ cwd, changed, expectedFiles: [], observed, ...evidence });
  const byPath = Object.fromEntries(drift.map(item => [item.path, item]));
  assert.equal(byPath['journaled.txt'].class, 'journaled');
  assert.equal(byPath['journaled.txt'].action, 'undo_mutation');
  assert.equal(byPath['journaled.txt'].mutation_id, 'mutation-1');
  assert.equal(byPath['scratch.tmp'].class, 'unjournaled_cleanable');
  assert.equal(byPath['product.py'].recover_action, 'revert_tracked');
  assert.equal(byPath['user-notes.txt'].class, 'unknown');
  const result = recover({ action: 'delete_untracked', path: 'scratch.tmp', expected_files: ['product.py'], ...evidence });
  assert.equal(result.file_set.status, 'invalid');
  assert.deepEqual(result.file_set.drift.map(item => item.path).sort(), ['journaled.txt', 'user-notes.txt']);
});

test('#438 revert_tracked refuses journaled, pre-existing-dirty and baseline-less restores', t => {
  const { root, cwd, recover } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'product.py'), 'edited\n');
  assert.throws(() => recover({ action: 'revert_tracked', path: 'product.py', journalPaths: new Map([['product.py', 'mutation-9']]) }), /recovery_use_undo_mutation.*mutation-9/s);
  assert.throws(() => recover({ action: 'revert_tracked', path: 'product.py', baseline: cleanBaseline([], ['product.py']) }), /recovery_preexisting_path/);
  assert.throws(() => recover({ action: 'revert_tracked', path: 'product.py', baseline: null }), /recovery_baseline_unavailable/);
  assert.equal(fs.readFileSync(path.join(cwd, 'product.py'), 'utf8'), 'edited\n');
  // Baseline captured with a dirty tracked file records it; a v1 sidecar fails closed.
  const env = { PI_WORKTREE_BASELINE_FILE: path.join(root, 'b.json') };
  captureWorktreeBaseline(cwd, env);
  assert.deepEqual([...readWorktreeBaseline(env).trackedDirty], ['product.py']);
  fs.writeFileSync(env.PI_WORKTREE_BASELINE_FILE, JSON.stringify({ schema_version: 1, untracked: [] }));
  assert.equal(readWorktreeBaseline(env), null);
});

test('#438 revert_tracked refuses an external rewrite after the observed stage post-state', t => {
  const { root, cwd, recover } = fixture(t);
  const env = { PI_WORKTREE_BASELINE_FILE: path.join(root, 'b.json') };
  captureWorktreeBaseline(cwd, env);
  // Stage-owned unjournaled change (bounded bash), observed right after the call.
  observeWorktreeDrift(cwd, env, 'before');
  fs.writeFileSync(path.join(cwd, 'product.py'), 'bash edit\n');
  observeWorktreeDrift(cwd, env, 'after');
  // External process rewrites the file afterwards.
  fs.writeFileSync(path.join(cwd, 'product.py'), 'external rewrite\n');
  const evidence = { baseline: readWorktreeBaseline(env), observed: readWorktreeObserved(env) };
  assert.throws(() => recover({ action: 'revert_tracked', path: 'product.py', ...evidence }), /recovery_externally_modified/);
  assert.equal(fs.readFileSync(path.join(cwd, 'product.py'), 'utf8'), 'external rewrite\n');
  // The next bash call taints it permanently; a later observation cannot absorb the rewrite.
  observeWorktreeDrift(cwd, env, 'before');
  observeWorktreeDrift(cwd, env, 'after');
  assert.ok(readWorktreeObserved(env).tainted.has('product.py'));
  assert.throws(() => recover({ action: 'revert_tracked', path: 'product.py', baseline: readWorktreeBaseline(env), observed: readWorktreeObserved(env) }), /recovery_externally_modified/);
  assert.equal(fs.readFileSync(path.join(cwd, 'product.py'), 'utf8'), 'external rewrite\n');
});

test('#438 revert_tracked restores a stage-owned bash change and refuses unobserved or missing evidence', t => {
  const { root, cwd, git, recover } = fixture(t);
  const env = { PI_WORKTREE_BASELINE_FILE: path.join(root, 'b.json') };
  captureWorktreeBaseline(cwd, env);
  fs.writeFileSync(path.join(cwd, 'product.py'), 'unobserved\n');
  const baseline = readWorktreeBaseline(env);
  assert.throws(() => recover({ action: 'revert_tracked', path: 'product.py', baseline, observed: readWorktreeObserved(env) }), /recovery_unobserved_change/);
  assert.throws(() => recover({ action: 'revert_tracked', path: 'product.py', baseline, observed: null }), /recovery_baseline_unavailable/);
  observeWorktreeDrift(cwd, env, 'after');
  const result = recover({ action: 'revert_tracked', path: 'product.py', baseline, observed: readWorktreeObserved(env), expected_files: [] });
  assert.equal(result.status, 'recovered');
  assert.equal(git('diff', '--', 'product.py'), '');
});

test('#438 an external rewrite before an unrelated bash call is never recorded as stage-owned', t => {
  const { root, cwd, recover } = fixture(t);
  const env = { PI_WORKTREE_BASELINE_FILE: path.join(root, 'b.json') };
  captureWorktreeBaseline(cwd, env);
  fs.writeFileSync(path.join(cwd, 'product.py'), 'external rewrite\n');
  observeWorktreeDrift(cwd, env, 'before');
  observeWorktreeDrift(cwd, env, 'after'); // unrelated bash changed nothing
  assert.ok(readWorktreeObserved(env).tainted.has('product.py'));
  assert.throws(() => recover({ action: 'revert_tracked', path: 'product.py', baseline: readWorktreeBaseline(env), observed: readWorktreeObserved(env) }), /recovery_externally_modified/);
  assert.equal(fs.readFileSync(path.join(cwd, 'product.py'), 'utf8'), 'external rewrite\n');
});
