import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readScript } from './helpers/resolved-source.mjs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../scripts/pi-common/git.mjs';
import { pushWithMissingObjectRetry } from '../scripts/pi-common/issue-publication.mjs';

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

test('git authentication is kept out of argv and every git process has a deadline', () => {
  const source = readScript('scripts/pi-common/git.mjs', 'utf8');
  assert.doesNotMatch(source, /credential\.helper/);
  assert.match(source, /GIT_CONFIG_VALUE_/);
  assert.match(source, /PI_GIT_TIMEOUT_SECONDS/);
  assert.match(source, /runProcess\('git'/);
});


test('issue publication retries only transient missing-object push failures', () => {
  const calls = [];
  const sleeps = [];
  const results = [
    { status: 1, out: '', err: 'remote rejected: missing necessary objects' },
    { status: 1, out: '', err: 'remote rejected: missing necessary objects' },
    { status: 0, out: 'ok', err: '' },
  ];
  const result = pushWithMissingObjectRetry(['push', 'origin', 'HEAD:refs/heads/pi/issue-1'], {
    cwd: '/tmp/worktree',
    token: 'secret',
    run(args, options) {
      calls.push({ args, options });
      return results.shift();
    },
    sleep(ms) {
      sleeps.push(ms);
    },
    delaysMs: [10, 20],
  });

  assert.equal(result.status, 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(calls.every(call => call.options.allowFailure === true), true);
  assert.equal(calls.every(call => call.options.token === 'secret'), true);
});

test('issue publication does not retry unrelated push failures', () => {
  const sleeps = [];
  assert.throws(
    () => pushWithMissingObjectRetry(['push', 'origin', 'HEAD:refs/heads/pi/issue-1'], {
      run() {
        return { status: 1, out: '', err: 'stale info: force-with-lease rejected' };
      },
      sleep(ms) {
        sleeps.push(ms);
      },
      delaysMs: [10, 20],
    }),
    /force-with-lease rejected/,
  );
  assert.deepEqual(sleeps, []);
});
