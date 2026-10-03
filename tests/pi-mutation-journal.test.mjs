import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { captureMutationSnapshot } from '../scripts/pi-common/mutation-snapshot.mjs';
import { mutationJournalStateFromRef } from '../scripts/pi-common/issue-worktree.mjs';
import {
  MUTATION_JOURNAL_MAX_PRIOR_BYTES,
  actionableMutationEntries,
  assertMutationJournalCapacity,
  decodeMutationJournalState,
  encodeMutationJournalState,
  mutationCleanupHints,
  mutationJournalState,
  recordSuccessfulMutation,
  undoMutation,
  writeMutationJournalFile,
} from '../scripts/pi-common/mutation-journal.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-journal-424-'));
  const sidecar = root + '.journal.json';
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sidecar, { force: true });
  });
  const env = { PI_MUTATION_JOURNAL_FILE: sidecar };
  return { root, sidecar, env };
}

function mutate({ root, env }, relative, content, { mode = 0o644, tool = 'write', disposition = 'temporary' } = {}) {
  const before = captureMutationSnapshot(root, relative);
  assertMutationJournalCapacity({ cwd: root, snapshot: before, env });
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  fs.chmodSync(absolute, mode);
  const after = captureMutationSnapshot(root, relative);
  return recordSuccessfulMutation({ cwd: root, before, after, tool, disposition, env });
}

test('#424 selectively removes early scratch after later useful module and test edits', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'module.py'), 'value = 1\n');

  const scratch = mutate(f, '.probe.txt', 'temporary\n');
  mutate(f, 'module.py', 'value = 2\n', { disposition: 'publishable', tool: 'safe_edit' });
  mutate(f, 'test_module.py', 'def test_value():\n    assert True\n', { disposition: 'publishable' });

  const moduleBytes = fs.readFileSync(path.join(f.root, 'module.py'));
  const testBytes = fs.readFileSync(path.join(f.root, 'test_module.py'));
  const result = undoMutation({
    cwd: f.root,
    mutationId: scratch.id,
    reason: 'Remove accidental scratch without touching useful edits',
    env: f.env,
  });

  assert.equal(result.action, 'delete');
  assert.equal(fs.existsSync(path.join(f.root, '.probe.txt')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'module.py')), moduleBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'test_module.py')), testBytes);
  assert.equal(mutationJournalState(f.root, f.env).entries.some(entry => entry.id === scratch.id), false);
});

test('#424 parent and coding fork share mutation provenance through the sidecar', t => {
  const f = fixture(t);
  const parentScratch = mutate(f, 'parent.tmp', 'parent scratch\n');
  const moduleUrl = new URL('../scripts/pi-common/mutation-journal.mjs', import.meta.url).href;
  const snapshotUrl = new URL('../scripts/pi-common/mutation-snapshot.mjs', import.meta.url).href;
  const program = `
    const fs = await import('node:fs');
    const path = await import('node:path');
    const journal = await import(${JSON.stringify(moduleUrl)});
    const snapshots = await import(${JSON.stringify(snapshotUrl)});
    const root = process.argv[1];
    journal.undoMutation({
      cwd: root,
      mutationId: process.argv[2],
      reason: 'fork cleans parent scratch',
      env: process.env,
    });
    const relative = 'fork.tmp';
    const before = snapshots.captureMutationSnapshot(root, relative);
    fs.writeFileSync(path.join(root, relative), 'fork scratch\\n');
    const after = snapshots.captureMutationSnapshot(root, relative);
    const entry = journal.recordSuccessfulMutation({
      cwd: root, before, after, tool: 'write', disposition: 'temporary', env: process.env,
    });
    process.stdout.write(entry.id);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program, f.root, parentScratch.id], {
    encoding: 'utf8',
    env: { ...process.env, PI_MUTATION_JOURNAL_FILE: f.sidecar },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(path.join(f.root, 'parent.tmp')), false);
  assert.match(child.stdout, /^mutation-/);

  const forkMutationId = child.stdout.trim();
  assert.ok(mutationJournalState(f.root, f.env).entries.some(entry => entry.id === forkMutationId));
  undoMutation({
    cwd: f.root,
    mutationId: forkMutationId,
    reason: 'parent cleans fork scratch',
    env: f.env,
  });
  assert.equal(fs.existsSync(path.join(f.root, 'fork.tmp')), false);
});

test('#424 checkpoint encoding restores actionable provenance in a new worktree', t => {
  const first = fixture(t);
  const entry = mutate(first, 'resume.tmp', 'saved scratch\n');
  const encoded = encodeMutationJournalState(first.root, mutationJournalState(first.root, first.env));

  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-journal-resume-424-'));
  const secondSidecar = secondRoot + '.journal.json';
  t.after(() => {
    fs.rmSync(secondRoot, { recursive: true, force: true });
    fs.rmSync(secondSidecar, { force: true });
  });
  fs.writeFileSync(path.join(secondRoot, 'resume.tmp'), 'saved scratch\n');
  const restored = decodeMutationJournalState(secondRoot, encoded);
  assert.ok(restored);
  writeMutationJournalFile(secondRoot, secondSidecar, restored);

  const env = { PI_MUTATION_JOURNAL_FILE: secondSidecar };
  assert.equal(actionableMutationEntries(secondRoot, env).at(-1).id, entry.id);
  undoMutation({
    cwd: secondRoot,
    mutationId: entry.id,
    reason: 'restored attempt cleans saved scratch',
    env,
  });
  assert.equal(fs.existsSync(path.join(secondRoot, 'resume.tmp')), false);
});

test('#424 existing-file undo restores exact bytes and mode and rejects stale post-state', t => {
  const f = fixture(t);
  const target = path.join(f.root, 'script.sh');
  fs.writeFileSync(target, Buffer.from('#!/bin/sh\necho old\n'));
  fs.chmodSync(target, 0o755);

  const entry = mutate(f, 'script.sh', Buffer.from('#!/bin/sh\necho new\n'), {
    mode: 0o644,
    disposition: 'publishable',
    tool: 'safe_edit',
  });

  fs.writeFileSync(target, '#!/bin/sh\necho intervening\n');
  fs.chmodSync(target, 0o644);
  assert.throws(
    () => undoMutation({ cwd: f.root, mutationId: entry.id, reason: 'must not clobber newer work', env: f.env }),
    error => error.code === 'mutation_undo_conflict',
  );
  assert.match(fs.readFileSync(target, 'utf8'), /intervening/);

  fs.writeFileSync(target, '#!/bin/sh\necho new\n');
  fs.chmodSync(target, 0o644);
  const result = undoMutation({ cwd: f.root, mutationId: entry.id, reason: 'restore exact prior state', env: f.env });
  assert.equal(result.action, 'restore');
  assert.equal(fs.readFileSync(target, 'utf8'), '#!/bin/sh\necho old\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
});

test('#424 pre-existing untracked files are restored, never deleted as agent-created scratch', t => {
  const f = fixture(t);
  const target = path.join(f.root, 'local-notes.txt');
  fs.writeFileSync(target, 'human bytes\n');
  const entry = mutate(f, 'local-notes.txt', 'agent bytes\n', { disposition: 'baseline-recovery' });

  const result = undoMutation({
    cwd: f.root,
    mutationId: entry.id,
    reason: 'restore pre-existing untracked content',
    env: f.env,
  });
  assert.equal(result.action, 'restore');
  assert.equal(fs.readFileSync(target, 'utf8'), 'human bytes\n');
});

test('#424 unsafe and protected targets cannot be removed by selective cleanup', t => {
  const f = fixture(t);

  const protectedEntry = mutate(f, '.agent-harness.json', '{"changed":true}\n');
  assert.throws(
    () => undoMutation({ cwd: f.root, mutationId: protectedEntry.id, reason: 'must remain protected', env: f.env }),
    error => error.code === 'mutation_undo_protected_path',
  );

  const symlinkEntry = mutate(f, 'scratch.txt', 'scratch\n');
  fs.rmSync(path.join(f.root, 'scratch.txt'));
  fs.writeFileSync(path.join(f.root, 'outside.txt'), 'scratch\n');
  fs.symlinkSync(path.join(f.root, 'outside.txt'), path.join(f.root, 'scratch.txt'));
  assert.throws(
    () => undoMutation({ cwd: f.root, mutationId: symlinkEntry.id, reason: 'symlink is unsafe', env: f.env }),
    /symbolic links/,
  );

  const malformed = {
    schema_version: 1,
    entries: [{
      id: 'mutation-00000000-0000-4000-8000-000000000000',
      path: '../escape.txt',
      tool: 'write',
      disposition: 'temporary',
      prior: { existed: false },
      post: { exists: false },
    }],
  };
  assert.throws(() => writeMutationJournalFile(f.root, f.sidecar, malformed), error => error.code === 'mutation_journal_invalid');
});

test('#424 file-set recovery hints expose only callable mutation ids for the unexpected path', t => {
  const f = fixture(t);
  const scratch = mutate(f, '.probe2.txt', 'scratch\n');
  mutate(f, 'feature.py', 'value = 1\n', { disposition: 'publishable' });

  assert.deepEqual(mutationCleanupHints(f.root, ['.probe2.txt'], f.env), [{
    mutation_id: scratch.id,
    path: '.probe2.txt',
    disposition: 'temporary',
    action: 'undo_mutation',
  }]);
  assert.deepEqual(mutationCleanupHints(f.root, ['missing.txt'], f.env), []);
});

test('#424 bounded journal rejects an existing-file snapshot that cannot be persisted before mutation', t => {
  const f = fixture(t);
  const target = path.join(f.root, 'huge.bin');
  fs.writeFileSync(target, Buffer.alloc(MUTATION_JOURNAL_MAX_PRIOR_BYTES + 1, 1));
  const snapshot = captureMutationSnapshot(f.root, 'huge.bin');
  assert.throws(
    () => assertMutationJournalCapacity({ cwd: f.root, snapshot, env: f.env }),
    error => error.code === 'mutation_journal_snapshot_too_large',
  );
});


test('#424 checkpoint trailer reader restores the newest explicit journal state', t => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(f.root, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');

  const entry = mutate(f, 'checkpoint.tmp', 'checkpoint scratch\n');
  const encodedActive = encodeMutationJournalState(f.root, mutationJournalState(f.root, f.env));
  fs.writeFileSync(path.join(f.root, 'checkpoint.tmp'), 'checkpoint scratch\n');
  git('add', '-A');
  git('commit', '-qm', `saved work\n\nPi-Mutation-Journal: ${encodedActive}`);
  const activeRef = git('rev-parse', 'HEAD').trim();
  assert.equal(mutationJournalStateFromRef(activeRef, f.root).entries.at(-1).id, entry.id);

  undoMutation({
    cwd: f.root,
    mutationId: entry.id,
    reason: 'clear scratch before later checkpoint',
    env: f.env,
  });
  const encodedEmpty = encodeMutationJournalState(f.root, mutationJournalState(f.root, f.env));
  fs.writeFileSync(path.join(f.root, 'marker.txt'), 'later checkpoint\n');
  git('add', '-A');
  git('commit', '-qm', `later saved work\n\nPi-Mutation-Journal: ${encodedEmpty}`);
  const latestRef = git('rev-parse', 'HEAD').trim();

  assert.deepEqual(mutationJournalStateFromRef(latestRef, f.root).entries, []);
});
