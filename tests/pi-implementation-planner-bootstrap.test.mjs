import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import bootstrapExtension from '../scripts/pi-implementer-bootstrap.mjs';

import {
  bootstrapFailureFallback,
  prepareImplementation,
  preparedImplementationBlock,
  readPreparedImplementation,
  validatePreparedImplementation,
  writePreparedImplementation,
} from '../scripts/pi-common/implementation-planner.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

const prepared = {
  version: 1, status: 'prepared', plan: ['Inspect the module', 'Add the regression test'],
  repositoryFacts: ['src/net.py uses send().'], complexity: 'trivial',
  requiredMutationAnchors: ['src/net.py'], largeMutation: false, reason: 'One bounded edit',
  workspaceRoot: '/work/tree', freshBaseCommit: 'deadbeef',
  baseRef: 'origin/dev', layoutHint: null, plannerUsage: { output: 40 }, plannerDurationMs: 900,
  plannerEvidenceActions: 3, plannerStructuredCorrections: 1,
};

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-prepared-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'prepared.json');
}

function plannerEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-bootstrap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const issue = path.join(dir, 'issue.json');
  fs.writeFileSync(issue, JSON.stringify({ title: 't', body: 'b' }));
  const previous = process.env.PI_ISSUE_CONTEXT;
  process.env.PI_ISSUE_CONTEXT = issue;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_ISSUE_CONTEXT;
    else process.env.PI_ISSUE_CONTEXT = previous;
  });
  return { PI_ISSUE_CONTEXT: issue, PI_IMPLEMENTER_START_COMMIT: 'abc123' };
}

test('implementer stage has no planner evidence cap, lifecycle deadline, or fixed structured retry knob', () => {
  const config = stageConfig('implementer');
  assert.equal(config.implementationPlannerMaxTokens, 2048);
  assert.equal('implementationPlannerEvidenceBudget' in config, false);
  assert.equal('implementationPlannerTimeoutMs' in config, false);
  assert.equal('implementationPlannerStructuredRetry' in config, false);
});

test('PreparedImplementation artifact round-trips and a missing file means no bootstrap ran', (t) => {
  const file = tempFile(t);
  assert.equal(readPreparedImplementation(file), null);
  assert.equal(readPreparedImplementation(undefined), null);
  writePreparedImplementation(file, prepared);
  assert.deepEqual(readPreparedImplementation(file), prepared);
});

test('malformed artifacts fail closed instead of being applied', (t) => {
  const file = tempFile(t);
  for (const bad of [
    { ...prepared, version: 2 },
    { ...prepared, status: 'unknown' },
    { ...prepared, plan: [] },
    { ...prepared, complexity: 'medium' },
    { ...prepared, requiredMutationAnchors: ['../escape.py'] },
    { ...prepared, largeMutation: 'yes' },
    { ...prepared, reason: '' },
    { version: 1, status: 'fallback', reason: 'x' },
  ]) {
    assert.throws(() => validatePreparedImplementation(bad), /./, JSON.stringify(bad).slice(0, 60));
    assert.throws(() => writePreparedImplementation(file, bad));
    assert.equal(fs.existsSync(file), false);
  }
});

test('a nine-step prepared plan is valid and the main block preserves every normalized step', () => {
  const nine = { ...prepared, plan: Array.from({ length: 9 }, (_, i) => `Step ${i + 1}`) };
  validatePreparedImplementation(nine);
  const block = preparedImplementationBlock(nine);
  assert.match(block, /9\. Step 9/);
});

test('the prepared block carries only normalized result and fresh-work provenance', () => {
  const block = preparedImplementationBlock(prepared);
  assert.match(block, /1\. Inspect the module\n2\. Add the regression test/);
  assert.match(block, /Complexity: trivial — One bounded edit/);
  assert.match(block, /Required current-file mutation anchors[\s\S]*src\/net\.py/);
  assert.match(block, /origin\/dev at deadbeef/);
  assert.doesNotMatch(block, /Evidence budget|evidence_budget|structured_output|plannerStructuredCorrections|plannerEvidenceActions/);
});

test('planner facts win over conflicting runtime layout hints in the Main-visible handoff', () => {
  const conflicting = {
    ...prepared,
    repositoryFacts: ['Use tests/diagnostics/test_smoke_keypaths.py as the verified sibling convention.'],
    layoutHint: {
      sourceRoot: 'src',
      sourceTarget: 'src/new_target.py',
      sourceDirectory: 'src',
      sourceConvention: 'src/sibling.py',
      testDirectory: 'tests',
      testTarget: 'tests/test_smoke_keypaths.py',
      testTargetRequired: false,
      testConvention: 'tests/test_other.py',
    },
  };
  const block = preparedImplementationBlock(conflicting);
  assert.match(block, /tests\/diagnostics\/test_smoke_keypaths\.py/);
  assert.doesNotMatch(block, /Repository layout hint|tests\/test_smoke_keypaths\.py/);
});

test('model-visible successful preparation contract has no stale deadline or evidence-budget wording', () => {
  const implementer = fs.readFileSync('agents/implementer/AGENTS.md', 'utf8');
  const planner = fs.readFileSync('.pi/agents/implementation-planner.md', 'utf8');
  const block = preparedImplementationBlock(prepared);
  for (const text of [implementer, planner, block]) {
    assert.doesNotMatch(text, /evidence_budget/);
    assert.doesNotMatch(text, /bounded retries|hard deadline/i);
  }
});

test('fallback remains resolved before main and never invents a planner deadline class', () => {
  const fallback = bootstrapFailureFallback('/work/tree', 'pi exited 3', { PI_IMPLEMENTER_START_COMMIT: 'deadbeef' });
  validatePreparedImplementation(fallback);
  assert.equal(fallback.failureClass, 'bootstrap_process_failure');
  assert.notEqual(fallback.failureClass, 'planner_deadline_timeout');
  assert.match(preparedImplementationBlock(fallback), /PREPARATION_FALLBACK/);
});

test('planner delegation has no lifecycle timeout or numeric tool budget', async (t) => {
  const bus = new EventEmitter();
  const requests = [];
  bus.on('prompt-template:subagent:request', request => {
    requests.push(request);
    bus.emit('prompt-template:subagent:response', {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: 'completed',
      usage: { turns: 1, output: 10 },
      result: { kind: 'structured', value: {
        steps: ['Do it'], facts: [], complexity: 'trivial', required_mutation_anchors: [], large_mutation: false, reason: 'done',
      } },
    });
  });
  const pi = { events: { on: (e, fn) => { bus.on(e, fn); return () => bus.off(e, fn); }, emit: (...a) => bus.emit(...a) } };
  const ctx = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => 'bootstrap' } };
  const env = plannerEnv(t);
  t.mock.method(console, 'log', () => {});
  const result = await prepareImplementation(pi, ctx, stageConfig('implementer'), undefined, { env });

  assert.equal(result.status, 'prepared');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].timeoutMs, undefined);
  assert.equal(requests[0].toolBudget, undefined);
  assert.equal('evidenceBudget' in result, false);
});

test('malformed accepted planner sidecar falls back as structured-result failure instead of escaping recovery', async (t) => {
  const bus = new EventEmitter();
  bus.on('prompt-template:subagent:request', request => {
    const sidecar = process.env.PI_PLANNER_EVIDENCE_STATE_FILE;
    assert.ok(sidecar, 'planner sidecar path must be installed in child env');
    fs.writeFileSync(sidecar, JSON.stringify({
      used: 1,
      repairStatus: 'accepted',
      acceptedResult: {
        steps: [],
        facts: [],
        complexity: 'trivial',
        required_mutation_anchors: [],
        large_mutation: false,
        reason: 'invalid accepted payload',
      },
    }));
    bus.emit('prompt-template:subagent:response', {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: 'cancelled',
      error: 'child aborted after terminal result',
      usage: { turns: 1, output: 5 },
    });
  });
  const pi = {
    events: {
      on: (event, fn) => { bus.on(event, fn); return () => bus.off(event, fn); },
      emit: (...args) => bus.emit(...args),
    },
  };
  const ctx = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => 'bootstrap' } };
  const env = plannerEnv(t);
  t.mock.method(console, 'log', () => {});

  const result = await prepareImplementation(pi, ctx, stageConfig('implementer'), undefined, { env });

  assert.equal(result.status, 'fallback');
  assert.equal(result.failureClass, 'structured_result_unrecoverable');
  assert.match(result.reason, /invalid step list/);
});

test('bootstrap launches planner only after session_start handlers have installed delegation context', async (t) => {
  const env = plannerEnv(t);
  const artifact = path.join(path.dirname(env.PI_ISSUE_CONTEXT), 'prepared.json');
  process.env.PI_PREPARED_IMPLEMENTATION_FILE = artifact;
  process.env.PI_IMPLEMENTER_BOOTSTRAP = 'true';
  t.after(() => { delete process.env.PI_PREPARED_IMPLEMENTATION_FILE; delete process.env.PI_IMPLEMENTER_BOOTSTRAP; });

  const bus = new EventEmitter();
  const handlers = new Map();
  const on = (event, fn) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); };
  const events = { on: (e, fn) => { bus.on(e, fn); return () => bus.off(e, fn); }, emit: (...a) => bus.emit(...a) };
  let shutdowns = 0;
  const ctx = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => 'bootstrap-session' }, shutdown: () => { shutdowns += 1; } };

  bootstrapExtension({ events, on });
  assert.equal(handlers.has('session_start'), false);

  let lastUiContext = null;
  on('session_start', (_event, c) => { lastUiContext = c; });
  bus.on('prompt-template:subagent:request', request => {
    bus.emit('prompt-template:subagent:response', lastUiContext
      ? { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: 'completed', usage: { output: 5 },
          result: { kind: 'structured', value: { steps: ['Do it'], facts: [], complexity: 'trivial', required_mutation_anchors: [], large_mutation: false, reason: 'tiny' } } }
      : { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: 'unavailable_context',
          error: 'No active extension context for delegated subagent execution.' });
  });

  for (const event of ['session_start', 'resources_discover']) {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
  }
  const result = readPreparedImplementation(artifact);
  assert.equal(result.status, 'prepared');
  assert.deepEqual(result.plan, ['Do it']);
  assert.equal(shutdowns, 1);

  await handlers.get('resources_discover')[0]({ type: 'resources_discover' }, ctx);
  assert.equal(shutdowns, 1);
});
