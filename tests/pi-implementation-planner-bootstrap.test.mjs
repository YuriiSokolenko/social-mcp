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
  version: 1, status: 'prepared', plan: ['Inspect the module', 'Add the regression test'], complexity: 'trivial',
  evidenceBudget: 1, largeMutation: false, reason: 'One bounded edit', workspaceRoot: '/work/tree', freshBaseCommit: 'deadbeef',
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
    { ...prepared, evidenceBudget: 9 },
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
  assert.match(block, /Evidence budget: 1/);
  assert.match(block, /origin\/dev at deadbeef/);
  assert.doesNotMatch(block, /structured_output|plannerStructuredCorrections|plannerEvidenceActions/);
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
        steps: ['Do it'], facts: [], complexity: 'trivial', evidence_budget: 0, large_mutation: false, reason: 'done',
      } },
    });
  });
  const pi = { events: { on: (e, fn) => { bus.on(e, fn); return () => bus.off(e, fn); }, emit: (...a) => bus.emit(...a) } };
  const ctx = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => 'bootstrap' } };
  const env = plannerEnv(t);
  const logs = t.mock.method(console, 'log', () => {});
  const result = await prepareImplementation(pi, ctx, stageConfig('implementer'), undefined, { env });

  assert.equal(result.status, 'prepared');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].timeoutMs, undefined);
  assert.equal(requests[0].toolBudget, undefined);
  assert.equal(Object.keys(requests[0].childEnv).length, 1);
  assert.ok(Object.keys(requests[0].childEnv)[0].includes('PLANNER_EVIDENCE_STATE_FILE'));
  assert.ok(logs.mock.calls.some(call => String(call.arguments[0]).startsWith('PI_PLANNER_CAT_PETTED ')));
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
          result: { kind: 'structured', value: { steps: ['Do it'], facts: [], complexity: 'trivial', evidence_budget: 0, large_mutation: false, reason: 'tiny' } } }
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
