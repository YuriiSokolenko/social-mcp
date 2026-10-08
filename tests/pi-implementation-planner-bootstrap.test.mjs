import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import bootstrapExtension from '../scripts/pi-implementer-bootstrap.mjs';
import plannerEvidenceExtension from '../scripts/pi-planner-evidence.mjs';

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
  version: 1, status: 'prepared',
  planText: '1. Inspect the module.\n2. Add the regression test for `social_mcp.diagnostics.<module>`.',
  complexity: 'nontrivial', requiredMutationAnchors: [], largeMutation: false,
  reason: 'Planner completed with a plain-text handoff.',
  workspaceRoot: '/work/tree', freshBaseCommit: 'deadbeef',
  baseRef: 'origin/dev', layoutHint: null, plannerUsage: { output: 40 }, plannerDurationMs: 900,
  plannerEvidenceActions: 3,
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

function textPlan({ steps = ['Do it'], facts = [], reason = 'done' } = {}) {
  return [...steps, ...facts.map(fact => `Repository observation: ${fact}`), `Reason: ${reason}`].join('\n');
}

// Earlier child-mocking tests exercise the bootstrap envelope, not the provider replay.
// The separate Planner lifecycle tests exercise the actual tool phase transition.
function simulateSubmittedPlan(planText) {
  const file = process.env.PI_PLANNER_EVIDENCE_STATE_FILE;
  assert.ok(file, 'delegated Planner sidecar must be set before child launch');
  fs.writeFileSync(file, JSON.stringify({ used: 0, facts: [], toolCounts: {}, phase: 'submitted',
    submissionBudget: 4096, planText }) + '\n');
}

test('implementer stage has no planner evidence cap, lifecycle deadline, or configurable format-retry knob', () => {
  const config = stageConfig('implementer');
  assert.equal(config.implementationPlannerMaxTokens, 2048);
  assert.equal('implementationPlannerEvidenceBudget' in config, false);
  assert.equal('implementationPlannerTimeoutMs' in config, false);
  assert.equal('implementationPlannerStructuredRetry' in config, false);
});

test('Planner alone opts out of inherited skill catalog without losing its read-only contract', () => {
  const planner = fs.readFileSync('.pi/agents/implementation-planner.md', 'utf8');
  const frontmatter = planner.split('---')[1];
  assert.ok(frontmatter, 'Planner agent must have frontmatter');
  assert.match(frontmatter, /^systemPromptMode: replace$/m);
  assert.match(frontmatter, /^inheritProjectContext: false$/m);
  assert.match(frontmatter, /^inheritGlobalContext: false$/m);
  assert.match(frontmatter, /^inheritSkills: false$/m);
  assert.doesNotMatch(frontmatter, /^(skills|skillPath):/m, 'no explicit skill injection');
  assert.match(frontmatter, /^tools: read, grep, find, ls, repo_search, planner_code_graph, begin_plan_submission, submit_plan$/m);
  const overrides = JSON.parse(fs.readFileSync('.pi/settings.json', 'utf8')).subagents.agentOverrides;
  assert.equal(overrides['implementation-planner'].inheritSkills, undefined, 'no project override re-enables inherited skills');
  assert.match(planner, /resolvedTargets > conventionHints > discovered repository context/);
  assert.match(planner, /ORBIT-DERIVED REPOSITORY CONTEXT/);
  assert.match(planner, /No mutation, shell, delegation, or untrusted tool is available/);
  assert.match(planner, /planText.*preserved byte-for-byte/i);
  assert.match(planner, /planText.*untrusted task data/);
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
    { ...prepared, version: 2 }, { ...prepared, status: 'unknown' },
    { ...prepared, planText: '' }, { ...prepared, planText: '   ' },
    { ...prepared, complexity: 'medium' }, { ...prepared, requiredMutationAnchors: ['src/net.py'] },
    { ...prepared, largeMutation: true }, { ...prepared, reason: '' },
    { version: 1, status: 'fallback', reason: 'x' },
  ]) {
    assert.throws(() => validatePreparedImplementation(bad), /./, JSON.stringify(bad).slice(0, 60));
    assert.throws(() => writePreparedImplementation(file, bad));
    assert.equal(fs.existsSync(file), false);
  }
});

test('a long plain-text prepared plan is valid and Main receives every byte without a handoff cap', () => {
  const planText = `# Plan\n${'x'.repeat(14000)}\n\`social_mcp.diagnostics.<module>\``;
  const long = { ...prepared, planText };
  validatePreparedImplementation(long);
  const block = preparedImplementationBlock(long);
  assert.match(block, /social_mcp\.diagnostics\.\\u003cmodule\\u003e/);
  assert.ok(block.includes('x'.repeat(14000)));
});

test('the prepared block keeps Planner text complete but explicitly untrusted', () => {
  const block = preparedImplementationBlock(prepared);
  assert.match(block, /untrusted task data/i);
  assert.match(block, /<untrusted_planner_handoff_json>/);
  assert.match(block, /social_mcp\.diagnostics\.\\u003cmodule\\u003e/);
  assert.match(block, /Runtime startup class: nontrivial \(conservative harness default\)/);
  assert.match(block, /origin\/dev at deadbeef/);
  assert.doesNotMatch(block, /plannerFinalizationAttempts|plannerXmlRepairNeeded|plannerEvidenceActions/);
});

test('runtime layout hints do not rewrite opaque Planner text in the Main-visible handoff', () => {
  const planText = 'Use tests/diagnostics/test_smoke_keypaths.py because that is the verified sibling convention.';
  const conflicting = { ...prepared, planText, layoutHint: {
    sourceRoot: 'src', sourceTarget: 'src/new_target.py', sourceDirectory: 'src',
    sourceConvention: 'src/sibling.py', testDirectory: 'tests',
    testTarget: 'tests/test_smoke_keypaths.py', testTargetRequired: false, testConvention: 'tests/test_other.py',
  }};
  const block = preparedImplementationBlock(conflicting);
  assert.match(block, /tests\/diagnostics\/test_smoke_keypaths\.py/);
  assert.doesNotMatch(block, /Repository layout hint/);
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
    simulateSubmittedPlan(textPlan());
    bus.emit('prompt-template:subagent:response', {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: 'completed',
      usage: { turns: 1, output: 10 },
      result: { kind: 'text', text: textPlan() },
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

test('real planner fail() abort retains its durable fallback class through delegation rejection', async t => {
  t.mock.method(console, 'log', () => {});
  for (const status of ['cancelled', 'failed']) {
    const bus = new EventEmitter();
    let didAbort = false;
    bus.on('prompt-template:subagent:request', request => {
      const handlers = new Map();
      const child = { on: (type, handler) => handlers.set(type, handler),
        setActiveTools: () => {}, registerTool: () => {} };
      plannerEvidenceExtension(child);
      const childContext = { model: { maxTokens: 2048 },
        abort: () => { didAbort = true; } };
      // Exercise the real phase-specific deterministic nudge then the real fail(),
      // rather than manually writing a failureKind into the sidecar.
      void (async () => {
        for (let i = 0; i < 2; i++) {
          await handlers.get('message_end')({ message: {
            role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Plain final.' }],
          } });
          await handlers.get('turn_end')({ entries: [] }, childContext);
        }
        assert.equal(didAbort, true, 'internal ctx.abort was invoked');
        bus.emit('prompt-template:subagent:response', {
          requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
          status, error: 'Planner child stopped after classified phase failure',
          usage: { turns: 2, output: 23 },
        });
      })();
    });
    const pi = { events: {
      on: (type, handler) => { bus.on(type, handler); return () => bus.off(type, handler); },
      emit: (...args) => bus.emit(...args),
    } };
    const ctx = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => 'bootstrap' } };
    const env = plannerEnv(t);
    const result = await prepareImplementation(pi, ctx, stageConfig('implementer'), undefined, { env });
    assert.equal(result.status, 'fallback');
    assert.equal(result.failureClass, 'planner_submission_not_started', status);
    assert.equal(result.plannerUsage.output, 23);
    assert.match(preparedImplementationBlock(result), /PREPARATION_FALLBACK/);
  }
});

test('all classified planner child aborts survive the structured delegation catch', async t => {
  const classes = [
    'planner_no_progress', 'planner_submission_incomplete',
    'planner_submission_budget_unavailable', 'planner_submission_context_exhausted',
    'planner_submission_placeholder',
  ];
  const env = plannerEnv(t);
  for (const failureKind of classes) {
    const bus = new EventEmitter();
    bus.on('prompt-template:subagent:request', req => {
      const file = process.env.PI_PLANNER_EVIDENCE_STATE_FILE;
      assert.ok(file);
      fs.writeFileSync(file, JSON.stringify({ used: 3, facts: [], toolCounts: { read: 3 },
        phase: 'failed', failureKind }) + '\n');
      bus.emit('prompt-template:subagent:response', {
        requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
        status: 'cancelled', error: 'child abort',
      });
    });
    const pi = { events: {
      on: (type, fn) => { bus.on(type, fn); return () => bus.off(type, fn); },
      emit: (...args) => bus.emit(...args),
    } };
    const ctx = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => 'bootstrap' } };
    const result = await prepareImplementation(pi, ctx, stageConfig('implementer'), undefined, { env });
    assert.equal(result.failureClass, failureKind);
    assert.equal(result.plannerEvidenceActions, 3);
  }
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
    if (lastUiContext) simulateSubmittedPlan(textPlan({ reason: 'tiny' }));
    bus.emit('prompt-template:subagent:response', lastUiContext
      ? { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: 'completed', usage: { output: 5 },
          result: { kind: 'text', text: textPlan({ reason: 'tiny' }) } }
      : { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: 'unavailable_context',
          error: 'No active extension context for delegated subagent execution.' });
  });

  for (const event of ['session_start', 'resources_discover']) {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
  }
  const result = readPreparedImplementation(artifact);
  assert.equal(result.status, 'prepared');
  assert.equal(result.planText, textPlan({ reason: 'tiny' }));
  assert.equal(shutdowns, 1);

  await handlers.get('resources_discover')[0]({ type: 'resources_discover' }, ctx);
  assert.equal(shutdowns, 1);
});


test('Orbit seed is resolved and embedded before Planner provider request #1', async (t) => {
  const bus = new EventEmitter();
  let seedResolved = false;
  let requestSeen = null;
  bus.on('prompt-template:subagent:request', request => {
    requestSeen = request;
    assert.equal(seedResolved, true, 'seed must be ready before delegation/provider request');
    simulateSubmittedPlan(textPlan({ steps: ['Update src/net.py'], facts: ['src/net.py is the target'], anchors: ['src/net.py'], reason: 'one bounded edit' }));
    bus.emit('prompt-template:subagent:response', {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: 'completed',
      usage: { turns: 1, input: 20, output: 10 },
      result: { kind: 'text', text: textPlan({
        steps: ['Update src/net.py'], facts: ['src/net.py is the target'], anchors: ['src/net.py'], reason: 'one bounded edit',
      }) },
    });
  });
  const pi = { events: { on: (event, fn) => { bus.on(event, fn); return () => bus.off(event, fn); }, emit: (...args) => bus.emit(...args) } };
  const ctx = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => 'bootstrap' } };
  const env = plannerEnv(t);
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(String(line)));

  const preparedResult = await prepareImplementation(pi, ctx, stageConfig('implementer'), undefined, {
    env,
    orbitSeedBuilder: async () => {
      seedResolved = true;
      return {
        present: true, fresh: true, currentHead: 'abc123', indexedHead: 'abc123', indexStatus: 'indexed',
        requestedTargets: ['src/net.py'], targets: ['src/net.py'], serializedBytes: 52,
        truncated: false, queryFailures: 0, reason: null,
        text: '### Orbit target: src/net.py\ngraph relationship for send',
      };
    },
  });

  assert.equal(preparedResult.status, 'prepared');
  assert.ok(requestSeen);
  assert.match(requestSeen.task, /ORBIT-DERIVED REPOSITORY CONTEXT/);
  assert.match(requestSeen.task, /seeded before provider request #1/i);
  assert.match(requestSeen.task, /graph relationship for send/);
  assert.match(requestSeen.task, /starting point only/i);
  assert.ok(logs.some(line => line.startsWith('PI_PLANNER_ORBIT_SEED ') && line.includes('"present":true')));
});

test('Planner docs and agent instructions describe Orbit seed and no superseded numeric handoff limits', () => {
  const planner = fs.readFileSync('.pi/agents/implementation-planner.md', 'utf8');
  const implementer = fs.readFileSync('agents/implementer/AGENTS.md', 'utf8');
  const rules = fs.readFileSync('docs/CI_RULES.md', 'utf8');

  assert.match(planner, /ORBIT-DERIVED REPOSITORY CONTEXT/);
  assert.match(planner, /current HEAD/);
  assert.match(implementer, /before that Planner's first provider request/);
  assert.match(rules, /PI_PLANNER_ORBIT_SEED/);
  assert.match(rules, /no Planner evidence-action budget/i);
  assert.match(planner, /30-second pre-request infrastructure safety budget/i);
  assert.match(rules, /not a Planner lifecycle deadline or Orbit-query-count cap/i);
  assert.doesNotMatch(rules, /planner separately returns its own per-task `evidence_budget` estimate/i);
  assert.doesNotMatch(rules, /repository facts remain capped for prompt hygiene/i);
  assert.doesNotMatch(rules, /keeps up to 16 ordered steps/i);
  assert.doesNotMatch(rules, /15-minute planner deadline/i);
});


test('absent Orbit seed still delegates Planner and returns PreparedImplementation', async (t) => {
  const bus = new EventEmitter();
  let requestSeen = null;
  bus.on('prompt-template:subagent:request', request => {
    requestSeen = request;
    simulateSubmittedPlan(textPlan());
    bus.emit('prompt-template:subagent:response', {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: 'completed',
      usage: { turns: 1, input: 12, output: 8 },
      result: { kind: 'text', text: textPlan({ steps: ['Use filesystem evidence as needed'], reason: 'Orbit is optional' }) },
    });
  });
  const pi = { events: { on: (event, fn) => { bus.on(event, fn); return () => bus.off(event, fn); }, emit: (...args) => bus.emit(...args) } };
  const ctx = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => 'bootstrap' } };
  const env = plannerEnv(t);
  t.mock.method(console, 'log', () => {});

  const result = await prepareImplementation(pi, ctx, stageConfig('implementer'), undefined, {
    env,
    orbitSeedBuilder: async () => ({
      present: false, fresh: false, currentHead: 'abc123', indexedHead: 'old999', indexStatus: 'indexed',
      requestedTargets: ['src/net.py'], targets: [], serializedBytes: 0, truncated: false,
      queryFailures: 0, reason: 'stale_index',
    }),
  });

  assert.equal(result.status, 'prepared');
  assert.ok(requestSeen, 'Planner delegation still occurs');
  assert.doesNotMatch(requestSeen.task, /ORBIT-DERIVED REPOSITORY CONTEXT/);
});
