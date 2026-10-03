import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { computeCandidateRevision, resolveCandidateBase } from '../scripts/pi-common/candidate-revision.mjs';

function repoFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-candidate-revision-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Candidate Test');
  git('config', 'user.email', 'candidate@example.invalid');
  fs.writeFileSync(path.join(dir, 'app.py'), 'value = 1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const branch = git('branch', '--show-current');
  git('update-ref', 'refs/remotes/origin/dev', base);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, git, base, branch };
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

test('candidate base falls back to the run-start commit when latest dev is not integrated', t => {
  const { dir, git, base, branch } = repoFixture(t);
  git('checkout', '-qb', 'upstream');
  fs.writeFileSync(path.join(dir, 'upstream.txt'), 'new upstream commit\n');
  git('add', '-A');
  git('commit', '-qm', 'advance dev');
  git('update-ref', 'refs/remotes/origin/dev', git('rev-parse', 'HEAD'));
  git('checkout', '-q', branch);
  fs.writeFileSync(path.join(dir, 'app.py'), 'value = 2\n');

  assert.equal(resolveCandidateBase({ cwd: dir, startCommit: base }), base);
  const candidate = computeCandidateRevision({
    cwd: dir,
    base: resolveCandidateBase({ cwd: dir, startCommit: base }),
  });
  assert.equal(candidate.base_commit, base);
});

test('gitlink/submodule directory candidates fail closed until explicitly supported', t => {
  const { dir, git, base } = repoFixture(t);
  fs.mkdirSync(path.join(dir, 'vendor', 'submodule'), { recursive: true });
  git('update-index', '--add', '--cacheinfo', `160000,${base},vendor/submodule`);

  assert.throws(
    () => computeCandidateRevision({ cwd: dir, base: 'origin/dev' }),
    /unsupported candidate path type: vendor\/submodule/,
  );
});
