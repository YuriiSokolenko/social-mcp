import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildPlannerOrbitSeed, plannerOrbitSeedTargets } from '../scripts/pi-common/planner-orbit.mjs';

function fixture(t, files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-orbit-new-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'existing convention\n');
  }
  return root;
}

function orbitExec(root, { stale = false, fail = false, empty = false, onContext = () => {} } = {}) {
  return async (command, args) => {
    if (command === 'git') return { stdout: 'head123\n' };
    if (args[0] === 'list') {
      return { stdout: JSON.stringify([{ repo_path: root,
        commit_sha: stale ? 'old456' : 'head123', status: 'indexed' }]) };
    }
    if (args[0] === 'context') {
      onContext(args[1]);
      if (fail) { const error = new Error('Orbit service failed'); error.code = 1; throw error; }
      return { stdout: empty ? '' : `Orbit neighbors: ${args[1]}` };
    }
    throw new Error(`Unexpected command ${command} ${args[0]}`);
  };
}

test('existing issue file still wins without nearby fallback', t => {
  const root = fixture(t, ['src/pkg/existing.py', 'src/pkg/other.py']);
  assert.deepEqual(plannerOrbitSeedTargets({
    title: 'Update `src/pkg/existing.py`', body: '',
  }, { cwd: root }), ['src/pkg/existing.py']);
});

test('new source and mirrored test files prefer deterministic existing nearby conventions', t => {
  const root = fixture(t, [
    'src/pkg/existing.py', 'src/pkg/other.md',
    'tests/pkg/test_existing.py', 'tests/pkg/notes.md',
  ]);
  const issue = { title: 'Add `src/pkg/new_service.py`', body: 'Create `tests/pkg/test_new_service.py`.' };
  assert.deepEqual(plannerOrbitSeedTargets(issue, { cwd: root }), [
    'src/pkg/existing.py', 'tests/pkg/test_existing.py',
  ]);
});

test('new nested subtree resolves to existing parent, not a missing Orbit target', t => {
  const root = fixture(t, ['src/pkg/source.py', 'src/pkg/sub/existing.py']);
  const issue = { title: 'Create `src/pkg/new_feature/deep/new_file.py`', body: '' };
  assert.deepEqual(plannerOrbitSeedTargets(issue, { cwd: root }), ['src/pkg/source.py']);
});

test('#668 WeatherService issue paths seed nearby examples and tests without altering targets', async t => {
  const root = fixture(t, [
    'examples/workflow-smoke/old_smoke/old_smoke.py',
    'tests/workflow_smoke/test_old_smoke.py',
  ]);
  // The exact permitted paths and URLs from #668; these targets do not yet exist.
  const issue = {
    title: '[Workflow smoke] Open-Meteo weather service (fresh test)',
    body: '## Scope / permitted files\n' +
      '- `examples/workflow-smoke/weather/weather.py`\n' +
      '- `tests/workflow_smoke/test_weather.py`\n' +
      '- Optionally `examples/workflow-smoke/weather/README.md`\n' +
      'Implement synchronous WeatherService around https://api.open-meteo.com/v1/forecast',
  };
  const requested = [
    'examples/workflow-smoke/old_smoke/old_smoke.py',
    'tests/workflow_smoke/test_old_smoke.py',
  ];
  assert.deepEqual(plannerOrbitSeedTargets(issue, { cwd: root }), requested);
  const calls = [];
  const seed = await buildPlannerOrbitSeed(root, issue, {
    execFile: orbitExec(root, { onContext: target => calls.push(target) }),
  });
  assert.equal(seed.fresh, true);
  assert.equal(seed.present, true);
  assert.equal(seed.reason, null);
  assert.deepEqual(seed.requestedTargets, requested);
  assert.deepEqual(seed.attemptedTargets, requested);
  assert.deepEqual(calls, requested);
  assert.ok(!calls.some(target => target.includes('/weather/')), 'never query new weather paths');
});

test('duplicate missing targets select each context file only once', t => {
  const root = fixture(t, ['src/pkg/known.py']);
  assert.deepEqual(plannerOrbitSeedTargets({
    title: 'Create `src/pkg/new.py` and `src/pkg/new.py`',
    body: 'Also add `src/pkg/other.py`; see `src/pkg/known.py`.',
  }, { cwd: root }), ['src/pkg/known.py']);
});

test('untrusted symbols, URLs, absolute paths and traversal are never treated as fallback targets', t => {
  const root = fixture(t, ['src/pkg/example.py']);
  const text = [
    '`https://example.org/src/pkg/new.py`',
    '`/src/pkg/new.py`', '`../src/pkg/new.py`',
    '`src/pkg/../new.py`', '`src//pkg/new.py`',
    '`types/counts`', '`pkg.new_module.NewType`',
    'https://host.invalid/src/pkg/new.py',
    '/src/pkg/new.py',
  ].join(' ');
  assert.deepEqual(plannerOrbitSeedTargets({ title: text, body: '' }, { cwd: root }), []);
});

test('escaping and broken symlinks cannot produce parent fallback context', t => {
  const root = fixture(t, ['src/pkg/known.py']);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-orbit-outside-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  fs.mkdirSync(path.join(external, 'external'), { recursive: true });
  try {
    fs.symlinkSync(path.join(external, 'external'), path.join(root, 'src/pkg/outside'));
    fs.symlinkSync(path.join(external, 'missing'), path.join(root, 'src/pkg/broken'));
    fs.symlinkSync(path.join(external, 'missing.py'), path.join(root, 'src/pkg/escape.py'));
  } catch (error) {
    t.skip(`symlinks not supported: ${error?.code ?? error}`);
    return;
  }
  assert.deepEqual(plannerOrbitSeedTargets({
    title: 'Create `src/pkg/outside/new.py`, `src/pkg/broken/new.py`, and `src/pkg/escape.py`',
  }, { cwd: root }), []);
});

test('no contextual file means no_relevant_existing_context, not no_task_targets', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'src/empty'), { recursive: true });
  const calls = [];
  const execFile = orbitExec(root, { onContext: target => calls.push(target) });
  const noContext = await buildPlannerOrbitSeed(root, {
    title: 'Create `src/empty/new.py`',
  }, { execFile });
  assert.equal(noContext.fresh, true);
  assert.equal(noContext.present, false);
  assert.equal(noContext.reason, 'no_relevant_existing_context');
  assert.deepEqual(noContext.requestedTargets, []);
  assert.deepEqual(noContext.attemptedTargets, []);

  const noTargets = await buildPlannerOrbitSeed(root, {
    title: 'Fix `pkg.symbol` and `types/counts`',
  }, { execFile });
  assert.equal(noTargets.reason, 'no_task_targets');
  assert.deepEqual(calls, []);
});

test('stale index never queries existing fallback targets', async t => {
  const root = fixture(t, ['src/pkg/known.py']);
  const calls = [];
  const seed = await buildPlannerOrbitSeed(root, { title: 'Add `src/pkg/new.py`' }, {
    execFile: orbitExec(root, { stale: true, onContext: target => calls.push(target) }),
  });
  assert.equal(seed.reason, 'stale_index');
  assert.deepEqual(seed.requestedTargets, ['src/pkg/known.py']);
  assert.deepEqual(seed.attemptedTargets, []);
  assert.deepEqual(calls, []);
});

test('context invocation failure differs from missing context; empty output is not a seed', async t => {
  const root = fixture(t, ['src/pkg/known.py']);
  for (const [opts, reason, category] of [
    [{ fail: true }, 'orbit_context_failed', 'graph_error'],
    [{ empty: true }, 'context_unavailable', 'empty_output'],
  ]) {
    const seed = await buildPlannerOrbitSeed(root, { title: 'Add `src/pkg/new.py`' }, {
      execFile: orbitExec(root, opts),
    });
    assert.equal(seed.present, false);
    assert.equal(seed.reason, reason);
    assert.deepEqual(seed.requestedTargets, ['src/pkg/known.py']);
    assert.deepEqual(seed.attemptedTargets, ['src/pkg/known.py']);
    assert.equal(seed.failureCategoryCounts[category], 1);
  }
});

test('fallback scans remain bounded in large directories', t => {
  const paths = Array.from({ length: 60 }, (_, index) => `src/pkg/existing_${index}.py`);
  const root = fixture(t, paths);
  assert.deepEqual(plannerOrbitSeedTargets({ title: 'Create `src/pkg/new.py`' }, { cwd: root }), []);
});

test('fallback is still subject to the existing seed output and time limits', async t => {
  const root = fixture(t, ['src/pkg/known.py']);
  const issue = { title: 'Create `src/pkg/new.py`' };
  const seed = await buildPlannerOrbitSeed(root, issue, {
    execFile: async (command, args) => {
      if (command === 'git') return { stdout: 'head123\n' };
      if (args[0] === 'list') return { stdout: JSON.stringify([
        { repo_path: root, commit_sha: 'head123', status: 'indexed' },
      ]) };
      return { stdout: 'x'.repeat(2000) };
    },
    maxChars: 120,
  });
  assert.equal(seed.present, true);
  assert.equal(seed.truncated, true);
  assert.ok(seed.serializedBytes <= 120);
  assert.deepEqual(seed.targets, ['src/pkg/known.py']);

  let now = 0;
  let contexts = 0;
  const timedOut = await buildPlannerOrbitSeed(root, issue, {
    now: () => now,
    timeBudgetMs: 2,
    execFile: async (command, args) => {
      now += 1;
      if (command === 'git') return { stdout: 'head123\n' };
      if (args[0] === 'list') return { stdout: JSON.stringify([
        { repo_path: root, commit_sha: 'head123', status: 'indexed' },
      ]) };
      if (args[0] === 'context') contexts += 1;
      return { stdout: 'unexpected' };
    },
  });
  assert.equal(timedOut.reason, 'seed_time_budget_exhausted');
  assert.equal(contexts, 0);
});
