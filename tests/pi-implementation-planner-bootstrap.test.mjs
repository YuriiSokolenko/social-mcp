import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import bootstrapExtension from '../scripts/pi-implementer-bootstrap.mjs';

import {
  IMPLEMENTATION_PLANNER_DEADLINE_MS,
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
};

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-prepared-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'prepared.json');
}

test('the planner hard deadline is exactly 15 minutes and drives the stage config', () => {
  assert.equal(IMPLEMENTATION_PLANNER_DEADLINE_MS, 900000);
  assert.equal(stageConfig('implementer').implementationPlannerTimeoutMs, IMPLEMENTATION_PLANNER_DEADLINE_MS);
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
    assert.equal(fs.existsSync(file), false, 'an invalid artifact is never written');
  }
  fs.writeFileSync(file, '{"version":1,');
  assert.throws(() => readPreparedImplementation(file));
});

test('the prepared block carries only the normalized result, with provenance and no preparation tool', () => {
  const block = preparedImplementationBlock(prepared);
  assert.match(block, /1\. Inspect the module\n2\. Add the regression test/);
  assert.match(block, /Complexity: trivial — One bounded edit/);
  assert.match(block, /Evidence budget: 1/);
  assert.match(block, /Large mutation: normal mutation budget/);
  assert.match(block, /origin\/dev at deadbeef/);
  assert.match(block, /LSP workspace root: \/work\/tree/);
  assert.doesNotMatch(block, /prepare_implementation|structured_output|REPAIR|usage|plannerDurationMs/);
  const factsBlock = preparedImplementationBlock({ ...prepared, repositoryFacts: ['The nearest smoke test uses the shared fixture helper.'] });
  assert.match(factsBlock, /treat these as completed discovery; do not re-read their source files/);
  assert.match(factsBlock, /The nearest smoke test uses the shared fixture helper/);
  assert.match(preparedImplementationBlock({ ...prepared, largeMutation: true }, { largeMutationArmed: true }), /auto-arm one-shot elevated mutation budget/);
});

test('the fallback block states preparation is already resolved and names the failure class', () => {
  const fallback = bootstrapFailureFallback('/work/tree', 'pi exited 3', { PI_IMPLEMENTER_START_COMMIT: 'deadbeef' });
  validatePreparedImplementation(fallback);
  assert.equal(fallback.status, 'fallback');
  assert.equal(fallback.failureClass, 'bootstrap_process_failure');
  const block = preparedImplementationBlock(fallback);
  assert.match(block, /PREPARATION_FALLBACK/);
  assert.match(block, /bootstrap_process_failure/);
  assert.match(block, /nothing to prepare or retry/);
  assert.match(block, /origin\/dev at deadbeef/);
  assert.doesNotMatch(block, /prepare_implementation/);
});

// One shared deadline across the structured-output retry: the retry only gets the time that is left.
function plannerHost({ replyDelays }) {
  const bus = new EventEmitter();
  const requests = [];
  const schemaError = 'Structured output validation failed: value: bad';
  bus.on('prompt-template:subagent:request', request => {
    const index = requests.push({ timeoutMs: request.timeoutMs }) - 1;
    setTimeout(() => bus.emit('prompt-template:subagent:response', {
      requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: 'failed', error: schemaError,
    }), replyDelays[index] ?? 0);
  });
  const pi = { events: { on: (e, fn) => { bus.on(e, fn); return () => bus.off(e, fn); }, emit: (...a) => bus.emit(...a) } };
  return { pi, requests, ctx: { cwd: os.tmpdir(), sessionManager: { getSessionId: () => 'bootstrap' } } };
}

function plannerEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-deadline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const issue = path.join(dir, 'issue.json');
  fs.writeFileSync(issue, JSON.stringify({ title: 't', body: 'b' }));
  process.env.PI_ISSUE_CONTEXT = issue;
  t.after(() => { delete process.env.PI_ISSUE_CONTEXT; });
  return process.env;
}

test('the structured-output retry receives only the remaining planning deadline', async (t) => {
  const host = plannerHost({ replyDelays: [300, 0] });
  const config = { ...stageConfig('implementer'), implementationPlannerTimeoutMs: 1000 };
  const prepared = await prepareImplementation(host.pi, host.ctx, config, undefined, { env: plannerEnv(t) });
  assert.equal(host.requests.length, 2);
  assert.ok(host.requests[0].timeoutMs <= 1000 && host.requests[0].timeoutMs > 900);
  assert.ok(host.requests[1].timeoutMs <= 720, `retry budget ${host.requests[1].timeoutMs} must shrink by the first attempt's elapsed time`);
  assert.equal(prepared.status, 'fallback');
});

test('an exhausted planning deadline skips the retry and falls back as planner_deadline_timeout', async (t) => {
  const host = plannerHost({ replyDelays: [400, 0] });
  const config = { ...stageConfig('implementer'), implementationPlannerTimeoutMs: 300 };
  const prepared = await prepareImplementation(host.pi, host.ctx, config, undefined, { env: plannerEnv(t) });
  assert.equal(host.requests.length, 1, 'no second full-length attempt after the deadline');
  assert.equal(prepared.status, 'fallback');
  assert.equal(prepared.failureClass, 'planner_deadline_timeout');
});

test('a failed bootstrap process keeps its real elapsed duration', () => {
  assert.equal(bootstrapFailureFallback('/w', 'x', {}, 4321).plannerDurationMs, 4321);
});

// #459: pi runs handlers sequentially in load order, and pi-subagents installs its delegation context
// in its own session_start handler. The bootstrap loads before it, so it must not start the planner
// from session_start (live: "No active extension context for delegated subagent execution").
test('bootstrap launches the planner only after every session_start handler, so pi-subagents has its context', async (t) => {
  const env = plannerEnv(t);
  const artifact = path.join(path.dirname(env.PI_ISSUE_CONTEXT), 'prepared.json');
  process.env.PI_PREPARED_IMPLEMENTATION_FILE = artifact;
  process.env.PI_IMPLEMENTER_BOOTSTRAP = 'true';
  t.after(() => { delete process.env.PI_PREPARED_IMPLEMENTATION_FILE; delete process.env.PI_IMPLEMENTER_BOOTSTRAP; });

  const bus = new EventEmitter();
  const handlers = new Map(); // event -> handlers in load order (bootstrap first, then pi-subagents)
  const on = (event, fn) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); };
  const events = { on: (e, fn) => { bus.on(e, fn); return () => bus.off(e, fn); }, emit: (...a) => bus.emit(...a) };
  let shutdowns = 0;
  const ctx = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => 'bootstrap-session' }, shutdown: () => { shutdowns++; } };

  bootstrapExtension({ events, on });
  assert.equal(handlers.has('session_start'), false, 'no planner launch from session_start');

  // Simulated pi-subagents (loaded after the bootstrap): context exists only after its session_start.
  let lastUiContext = null;
  on('session_start', (_event, c) => { lastUiContext = c; });
  bus.on('prompt-template:subagent:request', request => {
    bus.emit('prompt-template:subagent:response', lastUiContext
      ? { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: 'completed', usage: { output: 5 },
          result: { kind: 'structured', value: { steps: ['Do it'], complexity: 'trivial', evidence_budget: 0, large_mutation: false, reason: 'tiny' } } }
      : { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: 'unavailable_context',
          error: 'No active extension context for delegated subagent execution.' });
  });

  // pi's runner: sequential awaited handlers per event, session_start before resources_discover.
  for (const event of ['session_start', 'resources_discover']) {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
  }
  const prepared = readPreparedImplementation(artifact);
  assert.equal(prepared.status, 'prepared', 'real planner result, not an infrastructure fallback');
  assert.deepEqual(prepared.plan, ['Do it']);
  assert.equal(shutdowns, 1);

  // A repeated resources_discover (reload) must not start a second planner.
  await handlers.get('resources_discover')[0]({ type: 'resources_discover' }, ctx);
  assert.equal(shutdowns, 1);
});
