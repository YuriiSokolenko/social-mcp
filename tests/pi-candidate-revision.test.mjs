import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { computeCandidateRevision } from '../scripts/pi-common/candidate-revision.mjs';

function repoFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-candidate-revision-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Candidate Test');
  git('config', 'user.email', 'candidate@example.invalid');
  fs.writeFileSync(path.join(dir, 'app.py'), 'value = 1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/dev', git('rev-parse', 'HEAD'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, git };
}

test('candidate identity survives checkpoint commit but changes on same-path byte mutation', t => {
  const { dir, git } = repoFixture(t);
  fs.writeFileSync(path.join(dir, 'app.py'), 'value = 2\n');
  const dirty = computeCandidateRevision({ cwd: dir, base: 'origin/dev' });

  git('add', '-A');
  git('commit', '-qm', 'candidate');
  const committed = computeCandidateRevision({ cwd: dir, base: 'origin/dev' });
  assert.deepEqual(committed, dirty);

  fs.writeFileSync(path.join(dir, 'app.py'), 'value = 3\n');
  const tampered = computeCandidateRevision({ cwd: dir, base: 'origin/dev' });
  assert.notEqual(tampered.digest, committed.digest);
  assert.deepEqual(tampered.files, committed.files);
});
