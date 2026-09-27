import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../scripts/pi-common/git.mjs';

test('runGit returns status and trimmed stdout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-git-'));
  try {
    assert.equal(runGit(['init', '-q'], { cwd: dir }).status, 0);
    assert.equal(runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir }).out, 'true');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runGit throws on failure by default and exposes failures when allowed', () => {
  assert.throws(() => runGit(['definitely-not-a-git-command']), /git:/);
  const result = runGit(['definitely-not-a-git-command'], { allowFailure: true });
  assert.notEqual(result.status, 0);
});
