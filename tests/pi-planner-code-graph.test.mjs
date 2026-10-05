import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  PLANNER_CODE_GRAPH_MAX_BYTES,
  assertFreshPlannerOrbitIndex,
  plannerCodeGraph,
} from '../scripts/pi-common/planner-code-graph.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function runnerFor(cwd, {
  head = 'abcdef1234567890',
  indexedCommit = head,
  status = 'indexed',
  context = 'Definition sendWithBackoff\nCallers: deliverBatch, retryWorker\nTests: tests/transport.test.js',
  row = {},
} = {}) {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git') return { status: 0, stdout: `${head}\n`, stderr: '' };
    if (command === 'orbit' && args[0] === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify([{
          repo_path: cwd,
          commit_sha: indexedCommit,
          status,
          error_message: status === 'indexed' ? '' : 'index failed',
          ...row,
        }]),
        stderr: '',
      };
    }
    if (command === 'orbit' && args[0] === 'context') return { status: 0, stdout: context, stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { runner, calls };
}

test('planner graph queries the current fresh Orbit worktree with a bounded concrete relation question', (t) => {
  const cwd = fixture(t);
  const fake = runnerFor(cwd);
  const result = plannerCodeGraph(cwd, {
    relation: 'callers',
    target: 'sendWithBackoff',
    question: 'Which callers and focused tests are in the blast radius?',
  }, { runner: fake.runner });

  assert.equal(result.relation, 'callers');
  assert.equal(result.target, 'sendWithBackoff');
  assert.match(result.context, /deliverBatch/);
  assert.deepEqual(fake.calls, [
    ['git', 'rev-parse', 'HEAD'],
    ['orbit', 'list', '-F', 'json'],
    ['orbit', 'context', 'sendWithBackoff'],
  ]);
});

test('planner graph fails closed when the Orbit index is stale or unavailable', (t) => {
  const cwd = fixture(t);
  const stale = runnerFor(cwd, { indexedCommit: '1111111111111111' });
  assert.throws(
    () => plannerCodeGraph(cwd, { relation: 'references', target: 'sendWithBackoff', question: 'Who references it?' }, { runner: stale.runner }),
    /Planner code graph stale/,
  );
  assert.equal(stale.calls.some(call => call[1] === 'context'), false, 'stale index is rejected before graph traversal');

  const missing = runnerFor(cwd, { row: { repo_path: path.join(cwd, 'other') } });
  assert.throws(
    () => assertFreshPlannerOrbitIndex(cwd, { runner: missing.runner }),
    /current Planner worktree is not indexed/,
  );

  const unavailable = (command) => command === 'git'
    ? { status: 0, stdout: 'abcdef1234567890\n', stderr: '' }
    : { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn orbit ENOENT'), { code: 'ENOENT' }) };
  assert.throws(
    () => assertFreshPlannerOrbitIndex(cwd, { runner: unavailable }),
    /orbit is not installed/,
  );
});

test('planner graph rejects oversized output and command-shaped targets instead of broadening access', (t) => {
  const cwd = fixture(t);
  const oversized = runnerFor(cwd, { context: 'x'.repeat(PLANNER_CODE_GRAPH_MAX_BYTES + 1) });
  assert.throws(
    () => plannerCodeGraph(cwd, { relation: 'blast_radius', target: 'sendWithBackoff', question: 'What changes?' }, { runner: oversized.runner }),
    /response exceeded/,
  );

  const safe = runnerFor(cwd);
  assert.throws(
    () => plannerCodeGraph(cwd, { relation: 'callers', target: '--all', question: 'Dump everything' }, { runner: safe.runner }),
    /must not start with/,
  );
  assert.equal(safe.calls.length, 0, 'invalid input cannot reach git or Orbit');
});

test('planner graph accepts the bounded relationship vocabulary only', (t) => {
  const cwd = fixture(t);
  const fake = runnerFor(cwd);
  assert.throws(
    () => plannerCodeGraph(cwd, { relation: 'arbitrary_sql', target: 'sendWithBackoff', question: 'Run SQL' }, { runner: fake.runner }),
    /relation must be one of/,
  );
  assert.equal(fake.calls.length, 0);
});
