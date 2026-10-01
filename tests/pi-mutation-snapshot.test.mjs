import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  captureMutationSnapshot,
  detectNoOpWrite,
  mutationSnapshotChanged,
} from '../scripts/pi-common/mutation-snapshot.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mutation-snapshot-'));
}

test('detectNoOpWrite is true for an identical full-file write', () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, 'sample.txt');
    fs.writeFileSync(file, 'same content\n');
    const before = fs.statSync(file).mtimeMs;

    assert.equal(detectNoOpWrite(dir, { path: 'sample.txt', content: 'same content\n' }), true);
    // Detection must be read-only: it never touches the file itself.
    assert.equal(fs.statSync(file).mtimeMs, before);
    assert.equal(fs.readFileSync(file, 'utf8'), 'same content\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectNoOpWrite is false when content actually differs', () => {
  const dir = tempRepo();
  try {
    fs.writeFileSync(path.join(dir, 'sample.txt'), 'old content\n');
    assert.equal(detectNoOpWrite(dir, { path: 'sample.txt', content: 'new content\n' }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectNoOpWrite is false for a brand-new file (real creation, not a no-op)', () => {
  const dir = tempRepo();
  try {
    assert.equal(detectNoOpWrite(dir, { path: 'new-file.txt', content: 'anything' }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectNoOpWrite is false for a path that escapes the worktree', () => {
  const dir = tempRepo();
  try {
    assert.equal(detectNoOpWrite(dir, { path: '../outside.txt', content: 'x' }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectNoOpWrite is false for a directory target or malformed input', () => {
  const dir = tempRepo();
  try {
    fs.mkdirSync(path.join(dir, 'subdir'));
    assert.equal(detectNoOpWrite(dir, { path: 'subdir', content: 'x' }), false);
    assert.equal(detectNoOpWrite(dir, { path: 'sample.txt' }), false);
    assert.equal(detectNoOpWrite(dir, { content: 'x' }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mutationSnapshotChanged is false when an edit call left file bytes untouched', () => {
  // Mirrors the generic `edit` tool, which already refuses to write when a replacement would
  // produce identical content: before/after snapshots of that file are byte-for-byte equal.
  const dir = tempRepo();
  try {
    const file = path.join(dir, 'sample.py');
    fs.writeFileSync(file, 'value = 1\n');
    const before = captureMutationSnapshot(dir, 'sample.py');
    const after = captureMutationSnapshot(dir, 'sample.py');
    assert.equal(mutationSnapshotChanged(before, after), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mutationSnapshotChanged is true for a real edit that changed file content', () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, 'sample.py');
    fs.writeFileSync(file, 'value = 1\n');
    const before = captureMutationSnapshot(dir, 'sample.py');
    fs.writeFileSync(file, 'value = 2\n');
    const after = captureMutationSnapshot(dir, 'sample.py');
    assert.equal(mutationSnapshotChanged(before, after), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mutationSnapshotChanged is true when a mutation creates a brand-new file', () => {
  const dir = tempRepo();
  try {
    const before = captureMutationSnapshot(dir, 'new-file.txt');
    fs.writeFileSync(path.join(dir, 'new-file.txt'), 'content');
    const after = captureMutationSnapshot(dir, 'new-file.txt');
    assert.equal(mutationSnapshotChanged(before, after), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
