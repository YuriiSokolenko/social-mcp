import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

import plannerEvidenceExtension from '../scripts/pi-planner-evidence.mjs';
import {
  MAX_PLANNER_REPOSITORY_EVIDENCE,
  PLANNER_EVIDENCE_BUDGET_ENV,
  PLANNER_EVIDENCE_STATE_FILE_ENV,
  PLANNER_EVIDENCE_TOOLS,
  PLANNER_OUTPUT_ONLY_ENV,
  PLANNER_RESULT_TOOL,
  createPlannerEvidenceGate,
  discoverAdditivePythonLayout,
  normalizeImplementationPreparation,
  plannerEvidenceBudget,
  plannerTask,
  prepareImplementation,
  preparedImplementationBlock,
  validateImplementationPreparation,
} from '../scripts/pi-common/implementation-planner.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

const FORBIDDEN_TOOLS = [
  'bash', 'write', 'edit', 'safe_edit', 'structural_edit', 'run_check', 'submit_result', 'begin_coding_session',
  'request_large_mutation_budget', 'need_more_evidence', 'subagent', 'web_search', 'web_fetch', 'github_comment',
  'accept_mutation_scope', 'retry_last_failed_check',
];

function agentTools() {
  const source = fs.readFileSync('.pi/agents/implementation-planner.md', 'utf8');
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)[1];
  const line = frontmatter.split('\n').find(entry => entry.startsWith('tools:'));
  return line.slice('tools:'.length).split(',').map(tool => tool.trim()).filter(Boolean);
}

// Drives the real child-side extension the way pi would: one awaited tool_call handler per call.
function childExtension(t, budget) {
  const previous = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
  process.env[PLANNER_EVIDENCE_BUDGET_ENV] = String(budget);
  t.after(() => {
    if (previous === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV];
    else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previous;
  });
  const handlers = [];
  plannerEvidenceExtension({ on: (event, fn) => { if (event === 'tool_call') handlers.push(fn); } });
  assert.equal(handlers.length, 1);
  const log = t.mock.method(console, 'log', () => {});
  return {
    call: toolName => handlers[0]({ toolName, input: {} }),
    markers: () => log.mock.calls.map(call => String(call.arguments[0])).filter(line => line.startsWith('PI_PLANNER_EVIDENCE ')),
  };
}

test('the planner agent definition exposes exactly the read-only evidence tools', () => {
  assert.deepEqual(agentTools(), [...PLANNER_EVIDENCE_TOOLS]);
  for (const forbidden of FORBIDDEN_TOOLS) assert.ok(!agentTools().includes(forbidden), `${forbidden} must not be a planner tool`);
  const gate = createPlannerEvidenceGate(MAX_PLANNER_REPOSITORY_EVIDENCE);
  for (const forbidden of FORBIDDEN_TOOLS) {
    const admission = gate.admit(forbidden);
    assert.equal(admission.allowed, false, `${forbidden} must be blocked at call time`);
    assert.equal(admission.used, 0, 'a blocked tool never consumes evidence budget');
  }
});

test('the planner hard evidence cap is at most 6, configured in trusted stage config', () => {
  assert.equal(MAX_PLANNER_REPOSITORY_EVIDENCE, 6);
  assert.equal(stageConfig('implementer').implementationPlannerEvidenceBudget, 6);
  assert.equal(stageConfig('implementer').implementationPlannerMaxTokens, 2048);
  assert.equal(plannerEvidenceBudget({}), 6);
  assert.equal(plannerEvidenceBudget({ implementationPlannerEvidenceBudget: 3 }), 3);
  assert.equal(plannerEvidenceBudget({ implementationPlannerEvidenceBudget: 99 }), 6, 'config can lower the cap but never raise it past 6');
  assert.throws(() => plannerEvidenceBudget({ implementationPlannerEvidenceBudget: -1 }));
  assert.throws(() => plannerEvidenceBudget({ implementationPlannerEvidenceBudget: 'many' }));
});

test('a 7th evidence action is blocked and the cap cannot be extended', (t) => {
  const child = childExtension(t, 6);
  return (async () => {
    for (let index = 1; index <= 6; index += 1) {
      assert.equal(await child.call(PLANNER_EVIDENCE_TOOLS[index % PLANNER_EVIDENCE_TOOLS.length]), undefined, `action ${index} is accepted`);
    }
    for (const tool of PLANNER_EVIDENCE_TOOLS) {
      const verdict = await child.call(tool);
      assert.equal(verdict.block, true, `${tool} past the cap is blocked`);
      assert.match(verdict.reason, /exhausted/);
    }
    assert.equal(child.markers().length, 6, 'only accepted actions are logged');
  })();
});

test('accepted evidence markers report used/remaining without file contents', async (t) => {
  const child = childExtension(t, 6);
  await child.call('read');
  await child.call('grep');
  assert.deepEqual(child.markers(), [
    'PI_PLANNER_EVIDENCE {"tool":"read","used":1,"remaining":5}',
    'PI_PLANNER_EVIDENCE {"tool":"grep","used":2,"remaining":4}',
  ]);
});

test('planner evidence state starts with bounded counters and no invented facts', async (t) => {
  const stateFile = path.join(os.tmpdir(), `pi-planner-evidence-state-${process.pid}-${Date.now()}.json`);
  const previous = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = stateFile;
  t.after(() => {
    fs.rmSync(stateFile, { force: true });
    if (previous === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
    else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previous;
  });
  const child = childExtension(t, 6);
  await child.call('read');
  await child.call('grep');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { used: 2, cap: 6, facts: [] });
  assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /content|result|transcript/i);
});

test('#481 successful evidence calls persist only bounded redacted retry facts', async (t) => {
  const stateFile = path.join(os.tmpdir(), `pi-planner-evidence-facts-${process.pid}-${Date.now()}.json`);
  const previousBudget = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
  const previousState = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  process.env[PLANNER_EVIDENCE_BUDGET_ENV] = '6';
  process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = stateFile;
  t.after(() => {
    fs.rmSync(stateFile, { force: true });
    if (previousBudget === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV];
    else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previousBudget;
    if (previousState === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
    else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previousState;
  });
  const handlers = new Map();
  t.mock.method(console, 'log', () => {});
  plannerEvidenceExtension({ on: (event, fn) => handlers.set(event, fn) });

  await handlers.get('tool_call')({
    toolName: 'read',
    toolCallId: 'evidence-1',
    input: { path: 'src/net/transport.py' },
  });
  await handlers.get('tool_execution_end')({
    toolName: 'read',
    toolCallId: 'evidence-1',
    isError: false,
    result: { content: [{ type: 'text', text: 'def send_with_backoff(message):\n    return message\nAPI_KEY=sk-super-secret-credential-value' }] },
  });

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.used, 1);
  assert.equal(state.cap, 6);
  assert.equal(state.facts.length, 1);
  assert.ok(state.facts[0].length <= 200);
  assert.match(state.facts[0], /read src\/net\/transport\.py: def send_with_backoff/);
  assert.doesNotMatch(state.facts[0], /super-secret|sk-/);
  assert.match(state.facts[0], /\[redacted credential\]|\[redacted\]/);
});

test('aborted planner cleanup prevents a late child from recreating the evidence sidecar', async (t) => {
  const { dir, env } = fixture(t, {});
  const controller = new AbortController();
  let stateFile = null;
  let finishLateWrite;
  const lateWrite = new Promise(resolve => { finishLateWrite = resolve; });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});

  const host = plannerHost({
    cwd: dir,
    async driveChild() {
      stateFile = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
      const retainedChildEnv = {
        [PLANNER_EVIDENCE_BUDGET_ENV]: process.env[PLANNER_EVIDENCE_BUDGET_ENV],
        [PLANNER_EVIDENCE_STATE_FILE_ENV]: stateFile,
      };
      const handlers = [];
      plannerEvidenceExtension({ on: (_event, fn) => handlers.push(fn) });
      controller.abort();

      // The real delegated child is a separate process and retains its inherited env after the
      // parent stops waiting. Yield until the parent has rejected and run its lifecycle cleanup,
      // then simulate one late child tool call with that retained environment.
      await new Promise(resolve => setImmediate(resolve));
      const previousBudget = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
      const previousStateFile = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
      Object.assign(process.env, retainedChildEnv);
      try {
        await handlers[0]({ toolName: 'read', input: {} });
      } finally {
        if (previousBudget === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV];
        else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previousBudget;
        if (previousStateFile === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
        else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previousStateFile;
        finishLateWrite();
      }
      return { status: 'completed', usage: { output: 1 }, result: { kind: 'structured', value: {
        steps: ['unused'], complexity: 'trivial', evidence_budget: 0, large_mutation: false, reason: 'unused',
      } } };
    },
  });

  await assert.rejects(
    prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), controller.signal, { env }),
    /aborted/,
  );
  await lateWrite;
  assert.ok(stateFile, 'child received a sidecar path');
  assert.equal(fs.existsSync(path.dirname(stateFile)), false, 'lifecycle-owned sidecar directory stays removed');
  assert.equal(fs.existsSync(stateFile), false, 'late child write cannot recreate an orphaned sidecar');
});

test('the gate counts every accepted call, so failed or empty results still consume the cap', () => {
  const gate = createPlannerEvidenceGate(2);
  // The gate is admission-time: it cannot see (or be refunded by) a call's outcome.
  assert.equal(gate.admit('read').allowed, true);
  assert.equal(gate.admit('grep').allowed, true);
  assert.equal(gate.admit('find').allowed, false);
});

test('the planner may stop early: structured output never needs the cap and is never blocked by it', async (t) => {
  const child = childExtension(t, 6);
  await child.call('read');
  assert.equal(await child.call('structured_output'), undefined);
  assert.equal(child.markers().length, 1, 'structured_output is not evidence');

  const exhausted = createPlannerEvidenceGate(1);
  exhausted.admit('read');
  assert.equal(exhausted.admit('read').allowed, false);
  assert.equal(exhausted.admit('structured_output').allowed, true, 'an exhausted planner can still return its plan');
});

test('planner evidence and the Implementer evidence_budget are independent values', () => {
  const spend = (calls) => {
    const gate = createPlannerEvidenceGate(6);
    for (let index = 0; index < calls; index += 1) gate.admit('read');
    return gate;
  };
  for (const plannerCalls of [0, 3, 6]) {
    spend(plannerCalls);
    for (const evidenceBudget of [0, 1, 6]) {
      const result = validateImplementationPreparation({
        steps: ['Do it'], complexity: 'nontrivial', evidence_budget: evidenceBudget, large_mutation: false, reason: 'ok',
      });
      assert.equal(result.evidenceBudget, evidenceBudget, `planner used ${plannerCalls}; output budget stays ${evidenceBudget}`);
    }
  }
  assert.equal(plannerEvidenceBudget({ implementationPlannerEvidenceBudget: 2 }), 2);
  assert.throws(() => validateImplementationPreparation({
    steps: ['Do it'], complexity: 'trivial', evidence_budget: 7, large_mutation: false, reason: 'ok',
  }), /evidence_budget/, 'the output field keeps its own 0-6 contract');
});

// A simulated pi-subagents host that runs the REAL child extension against a fixture worktree.
function plannerHost({ cwd, driveChild }) {
  const bus = new EventEmitter();
  const requests = [];
  bus.on('prompt-template:subagent:request', async request => {
    requests.push(request);
    let reply;
    try { reply = await driveChild(request); }
    catch (error) { reply = { status: 'failed', error: String(error?.stack ?? error) }; }
    bus.emit('prompt-template:subagent:response', { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, ...reply });
  });
  const pi = { events: { on: (e, fn) => { bus.on(e, fn); return () => bus.off(e, fn); }, emit: (...a) => bus.emit(...a) } };
  return { pi, requests, ctx: { cwd, sessionManager: { getSessionId: () => 'bootstrap' } } };
}

function fixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  const issue = path.join(dir, '.issue.json');
  fs.writeFileSync(issue, JSON.stringify({ title: 'Add retry to the sender', body: 'Make the sender retry on 503.' }));
  // plannerTask() reads the issue through process.env, as in the bootstrap process.
  const previous = process.env.PI_ISSUE_CONTEXT;
  process.env.PI_ISSUE_CONTEXT = issue;
  t.after(() => { if (previous === undefined) delete process.env.PI_ISSUE_CONTEXT; else process.env.PI_ISSUE_CONTEXT = previous; });
  return { dir, env: { PI_ISSUE_CONTEXT: issue, PI_IMPLEMENTER_START_COMMIT: 'abc123' } };
}

test('repository evidence turns an ambiguous issue into a plan for the real target, with no mutation', async (t) => {
  const { dir, env } = fixture(t, {
    'src/net/transport.py': 'def send_with_backoff(message):\n    """All outbound delivery goes through here."""\n',
    'tests/test_transport.py': 'def test_send_with_backoff():\n    pass\n',
  });
  const before = fs.readdirSync(dir, { recursive: true }).sort();
  const host = plannerHost({
    cwd: dir,
    async driveChild(request) {
      // The child sees the trusted cap through its environment, set by the bootstrap per request.
      assert.equal(request.toolBudget.hard, 9);
      // runStructuredSubagent exposes the trusted cap to the child only while it runs.
      assert.equal(process.env[PLANNER_EVIDENCE_BUDGET_ENV], '6');
      assert.equal(process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, '2048');
      const handlers = new Map();
      plannerEvidenceExtension({ on: (event, fn) => handlers.set(event, fn) });
      t.mock.method(console, 'log', () => {});
      assert.equal(await handlers.get('tool_call')({ toolName: 'read', input: {} }), undefined);
      assert.equal(await handlers.get('tool_call')({ toolName: 'read', input: {} }), undefined);
      assert.equal((await handlers.get('tool_call')({ toolName: 'write', input: {} })).block, true);
      assert.equal((await handlers.get('tool_call')({ toolName: 'bash', input: {} })).block, true);
      const source = fs.readFileSync(path.join(dir, 'src/net/transport.py'), 'utf8');
      const target = source.match(/def (\w+)/)[1];
      return {
        status: 'completed', usage: { input: 900, output: 1200, turns: 1, durationMs: 2500 },
        result: { kind: 'structured', value: {
          steps: [
            `Add 503 retry inside ${target} in src/net/transport.py; preserve the observed single delivery entry point.`,
            'Extend tests/test_transport.py using the observed sibling pytest function layout for the retry path.',
          ],
          facts: [
            'src/net/transport.py exposes send_with_backoff as the outbound delivery entry point.',
            'tests/test_transport.py uses plain pytest test functions for transport behavior.',
          ],
          complexity: 'nontrivial', evidence_budget: 1, large_mutation: false,
          reason: 'Discovery is resolved, but main still needs the current src/net/transport.py text as its mutation anchor.',
        } },
      };
    },
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared');
  assert.match(prepared.plan[0], /send_with_backoff in src\/net\/transport\.py/, 'plan reflects repository evidence, not issue prose');
  assert.match(prepared.plan[1], /observed sibling pytest function layout/, 'derived test convention crosses as a fact');
  assert.deepEqual(prepared.repositoryFacts, [
    'src/net/transport.py exposes send_with_backoff as the outbound delivery entry point.',
    'tests/test_transport.py uses plain pytest test functions for transport behavior.',
  ]);
  assert.match(preparedImplementationBlock(prepared), /Repository facts already established by planner/);
  assert.equal(prepared.evidenceBudget, 1, 'existing-file mutation keeps one current-anchor read even after planner discovery');
  assert.equal(prepared.plannerEvidenceUsed, 2);
  assert.equal(prepared.plannerEvidenceCap, 6);
  assert.equal(prepared.plannerProviderTurns, 1);
  assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before, 'planner cannot modify the worktree');
  assert.equal(process.env[PLANNER_EVIDENCE_BUDGET_ENV], undefined, 'the cap does not leak past the planner request');
  assert.match(host.requests[0].task, /read-only repository evidence/);
  assert.doesNotMatch(host.requests[0].task, /Do not inspect the repository/);
});

test('planner observability preserves unknown evidenceUsed as null', () => {
  const bootstrap = fs.readFileSync('scripts/pi-implementer-bootstrap.mjs', 'utf8');
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(bootstrap, /evidenceUsed: prepared\.plannerEvidenceUsed \?\? null/);
  assert.match(runtime, /evidenceUsed: prepared\.plannerEvidenceUsed \?\? null/);
  assert.doesNotMatch(`${bootstrap}\n${runtime}`, /evidenceUsed: prepared\.plannerEvidenceUsed \?\? 0/);
});

test('planner prompt prefers targeted evidence and carries resolved facts forward', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-prompt-'));
  try {
    const issue = path.join(dir, 'issue.json');
    fs.writeFileSync(issue, JSON.stringify({
      title: 'Add smoke module',
      body: 'Create src/social_mcp/diagnostics/smoke_connect_four.py and tests/test_smoke_connect_four.py.',
    }));
    const task = plannerTask({ PI_ISSUE_CONTEXT: issue });
    assert.match(task, /first evidence action must target that named location/);
    assert.match(task, /Broad find\/ls\/search is escalation only/);
    assert.match(task, /missing, stale, contradictory/);
    assert.match(task, /Return facts as 0-6 concise repository-derived facts/);
    assert.match(task, /Never finish a planner attempt with prose/);
    assert.match(task, /ONLY the repository evidence main still needs/);
    assert.match(task, /current mutation anchor/);
    assert.match(task, /reserve at least one action for each existing file main must modify/);
    assert.match(task, /New-file-only work may use 0/);
    assert.match(task, /2048-token ceiling/);
    assert.match(task, /exactly one top-level "value"/);
    assert.match(task, /never wrap it again/);
    assert.doesNotMatch(task, /typically 1-3|1–3 actions is typical/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exact issue source/test paths produce an authoritative additive layout without broad discovery', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-exact-layout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src', 'social_mcp', 'diagnostics'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'social_mcp', 'diagnostics', 'smoke_chunks.py'), 'def chunks(): return []\n');
  fs.writeFileSync(path.join(dir, 'tests', 'test_smoke_chunks.py'), 'def test_chunks(): pass\n');

  const layout = discoverAdditivePythonLayout(dir, {
    title: 'Add Connect Four smoke',
    body: 'Create src/social_mcp/diagnostics/smoke_connect_four.py and tests/test_smoke_connect_four.py.',
  });
  assert.equal(layout.sourceTarget, 'src/social_mcp/diagnostics/smoke_connect_four.py');
  assert.equal(layout.testTarget, 'tests/test_smoke_connect_four.py');
  assert.equal(layout.testTargetRequired, true);
  assert.equal(layout.sourceConvention, 'src/social_mcp/diagnostics/smoke_chunks.py');
  assert.equal(layout.testConvention, 'tests/test_smoke_chunks.py');
});

test('exact additive layout ignores unrelated explicit tests and keeps missing explicit test directories coherent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-layout-edges-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src', 'demo_pkg', 'diagnostics'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'demo_pkg', 'diagnostics', 'smoke_chunks.py'), 'def chunks(): return []\n');
  fs.writeFileSync(path.join(dir, 'tests', 'test_unrelated.py'), 'def test_unrelated(): pass\n');

  const unrelated = discoverAdditivePythonLayout(dir, {
    title: 'Add widget smoke',
    body: 'Create src/demo_pkg/diagnostics/smoke_widget.py and tests/test_unrelated.py.',
  });
  assert.equal(unrelated.testDirectory, 'tests');
  assert.equal(unrelated.testTarget, 'tests/test_smoke_widget.py', 'an unrelated explicit test must not become the target');
  assert.equal(unrelated.testTargetRequired, false, 'an inferred test path is guidance only');

  const explicitMissingDirectory = discoverAdditivePythonLayout(dir, {
    title: 'Add widget smoke',
    body: 'Create src/demo_pkg/diagnostics/smoke_widget.py and tests/diagnostics/test_smoke_widget.py.',
  });
  assert.equal(explicitMissingDirectory.testDirectory, 'tests/diagnostics');
  assert.equal(explicitMissingDirectory.testTarget, 'tests/diagnostics/test_smoke_widget.py');
  assert.equal(explicitMissingDirectory.testTargetRequired, true);
  assert.equal(explicitMissingDirectory.testConvention, null);
});

test('facts normalization is bounded and empty facts still fail canonical validation', () => {
  const longFact = 'x'.repeat(250);
  const normalized = normalizeImplementationPreparation({
    steps: ['Do it'],
    facts: [longFact, ' two ', 'three', 'four', 'five', 'six', 'seven'],
    complexity: 'trivial',
    evidence_budget: 0,
    large_mutation: false,
    reason: 'ok',
  });
  assert.equal(normalized.facts.length, 6);
  assert.equal(normalized.facts[0].length, 200);
  assert.equal(normalized.facts[1], 'two');

  assert.throws(() => validateImplementationPreparation(normalizeImplementationPreparation({
    steps: ['Do it'],
    facts: ['   '],
    complexity: 'trivial',
    evidence_budget: 0,
    large_mutation: false,
    reason: 'ok',
  })), /invalid repository fact/);
});

test('output-only retry hides evidence tools when the child supports active-tool control', async (t) => {
  const previousBudget = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
  const previousOutputOnly = process.env[PLANNER_OUTPUT_ONLY_ENV];
  process.env[PLANNER_EVIDENCE_BUDGET_ENV] = '0';
  process.env[PLANNER_OUTPUT_ONLY_ENV] = 'true';
  t.after(() => {
    if (previousBudget === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV];
    else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previousBudget;
    if (previousOutputOnly === undefined) delete process.env[PLANNER_OUTPUT_ONLY_ENV];
    else process.env[PLANNER_OUTPUT_ONLY_ENV] = previousOutputOnly;
  });
  const handlers = new Map();
  let active = [...PLANNER_EVIDENCE_TOOLS, PLANNER_RESULT_TOOL];
  t.mock.method(console, 'log', () => {});
  plannerEvidenceExtension({
    on: (event, fn) => handlers.set(event, fn),
    getActiveTools: () => [...active],
    setActiveTools: tools => { active = [...tools]; },
  });

  await handlers.get('resources_discover')();
  assert.deepEqual(active, [PLANNER_RESULT_TOOL]);
  const providerPayload = {
    model: 'planner',
    tools: [
      { type: 'function', function: { name: 'read' } },
      { type: 'function', function: { name: PLANNER_RESULT_TOOL } },
    ],
  };
  const constrained = handlers.get('before_provider_request')({ payload: providerPayload });
  assert.equal(constrained.tool_choice, 'required');
  assert.deepEqual(constrained.tools.map(tool => tool.function.name), [PLANNER_RESULT_TOOL]);
  const blocked = await handlers.get('tool_call')({ toolName: 'find', input: {} });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /output-only/);
  assert.equal(await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} }), undefined);
});

test('output-only retry keeps the call-time gate when active-tool narrowing is unavailable', async (t) => {
  const previousBudget = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
  const previousOutputOnly = process.env[PLANNER_OUTPUT_ONLY_ENV];
  process.env[PLANNER_EVIDENCE_BUDGET_ENV] = '0';
  process.env[PLANNER_OUTPUT_ONLY_ENV] = 'true';
  t.after(() => {
    if (previousBudget === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV];
    else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previousBudget;
    if (previousOutputOnly === undefined) delete process.env[PLANNER_OUTPUT_ONLY_ENV];
    else process.env[PLANNER_OUTPUT_ONLY_ENV] = previousOutputOnly;
  });
  const handlers = new Map();
  const warnings = t.mock.method(console, 'warn', () => {});
  plannerEvidenceExtension({
    on: (event, fn) => handlers.set(event, fn),
    getActiveTools: () => [...PLANNER_EVIDENCE_TOOLS],
    setActiveTools: () => assert.fail('surface narrowing must not run without structured_output'),
  });

  await handlers.get('resources_discover')();
  assert.ok(warnings.mock.calls.some(call => String(call.arguments[0]).includes('"fallback":"tool_call_gate"')));
  const blocked = await handlers.get('tool_call')({ toolName: 'read', input: {} });
  assert.equal(blocked.block, true);
  assert.equal(await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} }), undefined);
  assert.equal((await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} })).block, true,
    'the child blocks a second result call even without ctx.abort');
});

test('broad discovery stays available only as a justified targeted-evidence escalation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-stale-target-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const issue = path.join(dir, 'issue.json');
  fs.writeFileSync(issue, JSON.stringify({
    title: 'Repair stale target',
    body: 'Update src/old/place.py; if that named path is stale, locate the replacement and preserve its tests.',
  }));
  const task = plannerTask({ PI_ISSUE_CONTEXT: issue });
  assert.ok(PLANNER_EVIDENCE_TOOLS.includes('find'), 'find remains available to the planner');
  assert.match(task, /Broad find\/ls\/search is escalation only/);
  assert.match(task, /missing, stale, contradictory/);
  const gate = createPlannerEvidenceGate(6);
  assert.equal(gate.admit('read').allowed, true, 'targeted evidence can run first');
  assert.equal(gate.admit('find').allowed, true, 'broad discovery is not globally prohibited after a concrete gap');
});

test('planner evidence sidecar distinguishes a real zero from unavailable state', async (t) => {
  const { dir, env } = fixture(t, {});
  const host = plannerHost({
    cwd: dir,
    async driveChild() {
      const handlers = [];
      plannerEvidenceExtension({ on: (_event, fn) => handlers.push(fn) });
      assert.equal(await handlers[0]({ toolName: 'structured_output', input: {} }), undefined);
      return {
        status: 'completed', usage: { output: 5 },
        result: { kind: 'structured', value: {
          steps: ['Create the new standalone file'], complexity: 'nontrivial',
          evidence_budget: 0, large_mutation: false, reason: 'No existing-file mutation anchor is needed.',
        } },
      };
    },
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.plannerEvidenceUsed, 0, 'child startup writes an explicit zero before evidence');
});

test('only the normalized PreparedImplementation crosses into the main Implementer session', async (t) => {
  const { dir, env } = fixture(t, { 'src/secret_marker.py': 'PLANNER_READ_RESULT_MARKER = 1\n' });
  const host = plannerHost({
    cwd: dir,
    driveChild: async () => ({
      status: 'completed', usage: { output: 7 },
      transcript: 'PLANNER_READ_RESULT_MARKER tool history',
      result: { kind: 'structured', value: { steps: ['Edit it'], complexity: 'trivial', evidence_budget: 1, large_mutation: false, reason: 'small' } },
    }),
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.plannerEvidenceUsed, null, 'missing child evidence sidecar is unknown, not a false zero');
  assert.deepEqual(Object.keys(prepared).sort(), [
    'baseRef', 'complexity', 'evidenceBudget', 'freshBaseCommit', 'largeMutation', 'layoutHint', 'plan',
    'plannerDurationMs', 'plannerEvidenceCap', 'plannerEvidenceUsed', 'plannerProviderTurns', 'plannerUsage',
    'reason', 'repositoryFacts', 'status', 'version', 'workspaceRoot',
  ]);
  const block = preparedImplementationBlock(prepared);
  assert.doesNotMatch(`${JSON.stringify(prepared)}${block}`, /PLANNER_READ_RESULT_MARKER|PI_PLANNER_EVIDENCE|tool history/);
  assert.doesNotMatch(block, /prepare_implementation/);
});

test('a nontrivial structured result up to the 2048 ceiling completes without an output-cap retry', async (t) => {
  const { dir, env } = fixture(t, {});
  const host = plannerHost({
    cwd: dir,
    driveChild: async () => ({
      status: 'completed',
      usage: { input: 12000, output: 1536, turns: 1, durationMs: 5000 },
      result: { kind: 'structured', value: {
        steps: ['Create new src/example_feature.py', 'Create new tests/test_example_feature.py'],
        complexity: 'nontrivial', evidence_budget: 0, large_mutation: true, reason: 'Both mutation targets are new files, so no current-file anchor read is needed.',
      } },
    }),
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(host.requests.length, 1, '2048-token planner result should not require a retry merely for the old 768 ceiling');
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.plannerProviderTurns, 1);
  assert.equal(prepared.plannerUsage.output, 1536);
});

test('planner evidence shares the single lifecycle deadline and usage is attributed once', async (t) => {
  const { dir, env } = fixture(t, {});
  const metrics = path.join(dir, 'metrics.jsonl');
  env.PI_METRICS_FILE = metrics;
  const previous = process.env.PI_METRICS_FILE;
  process.env.PI_METRICS_FILE = metrics;
  t.after(() => { if (previous === undefined) delete process.env.PI_METRICS_FILE; else process.env.PI_METRICS_FILE = previous; });
  const host = plannerHost({
    cwd: dir,
    driveChild: async () => ({
      status: 'completed', usage: { output: 9 },
      result: { kind: 'structured', value: { steps: ['Do it'], complexity: 'trivial', evidence_budget: 0, large_mutation: false, reason: 'tiny' } },
    }),
  });
  const config = { ...stageConfig('implementer'), implementationPlannerTimeoutMs: 1000 };
  const prepared = await prepareImplementation(host.pi, host.ctx, config, undefined, { env });
  assert.equal(host.requests.length, 1, 'evidence happens inside the one planner request, not as extra requests');
  assert.ok(host.requests[0].timeoutMs <= 1000, 'evidence, reasoning and structured output all live under the one deadline');
  assert.deepEqual(prepared.plannerUsage, { output: 9 });
  const records = fs.readFileSync(metrics, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(record => record.call === 'planner').length, 1, 'planner usage recorded exactly once');
  assert.equal(records.filter(record => record.call && record.call !== 'planner').length, 0, 'no fake main Implementer request');
});

// Review of #462: each retry is a fresh child with a fresh gate, so the cap (and usage record) must
// be lifecycle-wide rather than per attempt.
test('a structured-output retry cannot reset the evidence cap and usage is still recorded once', async (t) => {
  const { dir, env } = fixture(t, {});
  const metrics = path.join(dir, 'metrics.jsonl');
  const previousMetrics = process.env.PI_METRICS_FILE;
  process.env.PI_METRICS_FILE = metrics;
  t.after(() => { if (previousMetrics === undefined) delete process.env.PI_METRICS_FILE; else process.env.PI_METRICS_FILE = previousMetrics; });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});

  const attempts = [];
  const host = plannerHost({
    cwd: dir,
    async driveChild(request) {
      const handlers = [];
      plannerEvidenceExtension({ on: (event, fn) => { if (event === 'tool_call') handlers.push(fn); } });
      const outputOnly = process.env[PLANNER_OUTPUT_ONLY_ENV] === 'true';
      const verdicts = [];
      if (!outputOnly) {
        for (let index = 0; index < 7; index += 1) verdicts.push(await handlers[0]({ toolName: 'read', input: {} }));
      }
      const structured = await handlers[0]({ toolName: 'structured_output', input: {} });
      attempts.push({
        accepted: verdicts.filter(verdict => verdict === undefined).length,
        structured,
        outputOnly,
        hard: request.toolBudget.hard,
        task: request.task,
      });
      if (attempts.length === 1) {
        return { status: 'failed', error: 'Structured output validation failed: value: bad', usage: { input: 100, output: 10, turns: 2, toolCalls: 7 } };
      }
      return {
        status: 'completed', usage: { input: 50, output: 5, turns: 1, toolCalls: 1 },
        result: { kind: 'structured', value: { steps: ['Do it'], facts: ['The target is already resolved.'], complexity: 'trivial', evidence_budget: 1, large_mutation: false, reason: 'ok' } },
      };
    },
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });

  assert.equal(host.requests.length, 2);
  assert.deepEqual(attempts.map(attempt => attempt.accepted), [6, 0], 'first attempt spends the full 6; the retry gets none');
  assert.deepEqual(attempts.map(attempt => attempt.outputOnly), [false, true]);
  assert.deepEqual(attempts.map(attempt => attempt.hard), [9, 1], 'retry has room for structured_output only');
  assert.match(attempts[1].task, /EVIDENCE PHASE CLOSED/);
  assert.match(attempts[1].task, /only valid successful completion is structured_output/);
  assert.equal(attempts[1].structured, undefined, 'structured_output stays available on the retry');
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.repositoryFacts, ['The target is already resolved.']);
  assert.deepEqual(prepared.plannerUsage, { input: 150, output: 15, turns: 3, toolCalls: 8 }, 'all attempts are aggregated');
  assert.equal(prepared.plannerEvidenceUsed, 6, 'retry cap=0 cannot erase evidence spent by the first attempt');
  assert.equal(prepared.plannerEvidenceCap, 6);
  const records = fs.readFileSync(metrics, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 1, 'exactly one metric record for the planner lifecycle');
  assert.equal(records[0].call, 'planner');
  assert.equal(records[0].status, 'completed');
  assert.deepEqual(records[0].usage, { input: 150, output: 15, turns: 3, toolCalls: 8 });
});

test('a rejected structured_output gets exactly one constrained child repair with evidence closed', async (t) => {
  const { dir, env } = fixture(t, {});
  const previousBudget = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
  const previousOutputOnly = process.env[PLANNER_OUTPUT_ONLY_ENV];
  const previousState = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  process.env[PLANNER_EVIDENCE_BUDGET_ENV] = '6';
  process.env[PLANNER_OUTPUT_ONLY_ENV] = 'false';
  const stateFile = path.join(dir, 'planner-state.json');
  process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = stateFile;
  t.after(() => {
    if (previousBudget === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV]; else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previousBudget;
    if (previousOutputOnly === undefined) delete process.env[PLANNER_OUTPUT_ONLY_ENV]; else process.env[PLANNER_OUTPUT_ONLY_ENV] = previousOutputOnly;
    if (previousState === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV]; else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previousState;
  });
  const handlers = new Map();
  let active = [...PLANNER_EVIDENCE_TOOLS, PLANNER_RESULT_TOOL];
  const logs = t.mock.method(console, 'log', () => {});
  plannerEvidenceExtension({
    on: (event, fn) => handlers.set(event, fn),
    getActiveTools: () => active,
    setActiveTools: value => { active = [...value]; },
  });

  const ordinaryPayload = {
    tools: [{ function: { name: 'read' } }, { function: { name: PLANNER_RESULT_TOOL } }],
    parallel_tool_calls: true,
    chat_template_kwargs: { enable_thinking: true },
  };
  const normalRequest = handlers.get('before_provider_request')({ payload: ordinaryPayload });
  assert.deepEqual(normalRequest, ordinaryPayload, 'normal evidence requests retain existing parallel and thinking settings');

  assert.equal(await handlers.get('tool_call')({ toolName: 'read', toolCallId: 'source-read', input: { path: 'src/foo.py' } }), undefined);
  await handlers.get('tool_execution_end')({ toolName: 'read', toolCallId: 'source-read', isError: false, result: { content: [{ type: 'text', text: 'def foo(): return 1' }] } });
  assert.equal(await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: { value: { value: {} } } }), undefined);
  await handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    input: {},
    isError: true,
    content: [{ type: 'text', text: 'Validation failed for tool "structured_output": value required. Received arguments: {}' }],
  }, {});

  assert.deepEqual(active, [PLANNER_RESULT_TOOL]);
  const repairPayload = { payload: {
    tools: [
      { type: 'function', function: { name: 'read' } },
      { type: 'function', function: { name: PLANNER_RESULT_TOOL } },
    ],
    parallel_tool_calls: true,
    chat_template_kwargs: { enable_thinking: true },
  } };
  const constrained = handlers.get('before_provider_request')(repairPayload);
  assert.deepEqual(constrained.tools.map(tool => tool.function.name), [PLANNER_RESULT_TOOL]);
  assert.equal(constrained.tool_choice, 'required');
  assert.equal(constrained.parallel_tool_calls, true, 'the repair hook does not override provider parallelism');
  assert.deepEqual(constrained.chat_template_kwargs, { enable_thinking: true }, 'the repair hook preserves provider thinking');
  assert.equal((await handlers.get('tool_call')({ toolName: 'read', input: {} })).block, true);
  assert.equal(await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: { value: {} } }), undefined);
  await handlers.get('tool_result')({ toolName: PLANNER_RESULT_TOOL, input: {}, isError: false, content: [] }, {});
  assert.equal((await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} })).block, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), {
    used: 1, cap: 6, facts: ['read src/foo.py: def foo(): return 1'], resultAttempts: 2, repairStatus: 'succeeded',
    repairDiagnostic: 'Validation failed for tool "structured_output": value required. Received arguments: {}',
    repairKind: 'schema_rejection',
  });
  const markers = logs.mock.calls.map(call => String(call.arguments[0]));
  assert.ok(markers.some(line => line.startsWith('PI_PLANNER_RESULT_REJECTION ')));
  assert.ok(markers.some(line => line.startsWith('PI_PLANNER_RESULT_REPAIR_STARTED ')));
  assert.ok(markers.some(line => line.startsWith('PI_PLANNER_RESULT_SUCCESS ')));
  assert.ok(markers.some(line => line.startsWith('PI_PLANNER_RESULT_DUPLICATE_BLOCKED ')));
  assert.ok(!markers.some(line => line.startsWith('PI_PLANNER_RESULT_REPAIR_FAILURE ')));
});

test('JSON-quoted credential fields are redacted before diagnostics reach the repair prompt or sidecar', async (t) => {
  const previousBudget = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
  const previousState = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  const stateFile = path.join(os.tmpdir(), `pi-planner-redaction-${process.pid}-${Date.now()}.json`);
  process.env[PLANNER_EVIDENCE_BUDGET_ENV] = '6';
  process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = stateFile;
  t.after(() => {
    fs.rmSync(stateFile, { force: true });
    if (previousBudget === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV]; else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previousBudget;
    if (previousState === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV]; else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previousState;
  });
  const handlers = new Map();
  plannerEvidenceExtension({ on: (event, fn) => handlers.set(event, fn) });
  await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} });
  const repaired = await handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    input: {},
    isError: true,
    content: [{ type: 'text', text: 'Validation failed: {"token": "secret-marker-value", "secret": "another-marker", "password": "my pass"}' }],
  }, {});
  const persisted = fs.readFileSync(stateFile, 'utf8');
  const returned = JSON.stringify(repaired.content);
  assert.doesNotMatch(persisted, /secret-marker-value|another-marker|my pass|pass"/);
  assert.doesNotMatch(returned, /secret-marker-value|another-marker|my pass|pass"/);
  assert.match(persisted, /\[redacted\]/);
});

test('a structured_output rejection closes evidence and counts the attempt even without tool_call', async (t) => {
  const previousBudget = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
  const previousState = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  const stateFile = path.join(os.tmpdir(), `pi-planner-missing-tool-call-${process.pid}-${Date.now()}.json`);
  process.env[PLANNER_EVIDENCE_BUDGET_ENV] = '6';
  process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = stateFile;
  t.after(() => {
    fs.rmSync(stateFile, { force: true });
    if (previousBudget === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV]; else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previousBudget;
    if (previousState === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV]; else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previousState;
  });
  const handlers = new Map();
  plannerEvidenceExtension({ on: (event, fn) => handlers.set(event, fn) });

  await handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    input: {},
    isError: true,
    content: [{ type: 'text', text: 'Unexpected end of JSON input after {"value":' }],
  }, {});
  const first = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(first.resultAttempts, 1);
  assert.equal(first.repairKind, 'malformed_arguments');
  assert.equal((await handlers.get('tool_call')({ toolName: 'read', input: {} })).block, true,
    'evidence closes when the error result is observed');

  assert.equal(await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: { value: {} } }), undefined);
  await handlers.get('tool_result')({ toolName: PLANNER_RESULT_TOOL, input: { value: {} }, isError: false, content: [] }, {});
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).resultAttempts, 2,
    'the missing tool_call did not grant an extra result attempt');
});

test('a successful first structured_output has no repair and is returned unchanged', async (t) => {
  const { dir, env } = fixture(t, {});
  const previousBudget = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
  const previousState = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  const stateFile = path.join(dir, 'successful-result-state.json');
  process.env[PLANNER_EVIDENCE_BUDGET_ENV] = '6';
  process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = stateFile;
  t.after(() => {
    if (previousBudget === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV]; else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previousBudget;
    if (previousState === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV]; else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previousState;
  });
  const handlers = new Map();
  const logs = t.mock.method(console, 'log', () => {});
  plannerEvidenceExtension({ on: (event, fn) => handlers.set(event, fn) });
  const value = { steps: ['Keep this prepared plan'], facts: ['preserved fact'], complexity: 'trivial', evidence_budget: 0, large_mutation: false, reason: 'done' };
  assert.equal(await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: { value } }), undefined);
  await handlers.get('tool_result')({ toolName: PLANNER_RESULT_TOOL, input: { value }, isError: false, content: [] }, {});
  assert.ok(logs.mock.calls.some(call => String(call.arguments[0]).startsWith('PI_PLANNER_RESULT_SUCCESS ')));
  assert.ok(!logs.mock.calls.some(call => String(call.arguments[0]).startsWith('PI_PLANNER_RESULT_REPAIR_STARTED ')));
  let aborted = false;
  assert.equal((await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, toolCallId: 'extra-result', input: { value } }, { abort: () => { aborted = true; } })).block, true,
    'a successful first call cannot be followed by another initial result call');
  assert.equal(await handlers.get('tool_result')({ toolName: PLANNER_RESULT_TOOL, toolCallId: 'extra-result', input: {}, isError: true, content: [] }, { abort: () => { aborted = true; } }), undefined);
  assert.equal(aborted, false, 'the blocked call result cannot abort or invalidate the accepted plan');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).repairStatus, 'first_call_succeeded');
  assert.ok(logs.mock.calls.some(call => String(call.arguments[0]).startsWith('PI_PLANNER_RESULT_DUPLICATE_BLOCKED ')));
  assert.ok(!logs.mock.calls.some(call => String(call.arguments[0]).startsWith('PI_PLANNER_RESULT_REPAIR_FAILURE ')));
  const host = plannerHost({ cwd: dir, driveChild: async () => ({ status: 'completed', usage: { turns: 1 }, result: { kind: 'structured', value } }) });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.deepEqual(prepared.plan, value.steps);
  assert.deepEqual(prepared.repositoryFacts, value.facts);
  assert.equal(host.requests.length, 1);
});

test('malformed, double-wrapped, missing-value, and stringified results all enter one repair path', async (t) => {
  const previousBudget = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
  const previousState = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  process.env[PLANNER_EVIDENCE_BUDGET_ENV] = '6';
  const stateFile = path.join(os.tmpdir(), `pi-planner-result-cases-${process.pid}-${Date.now()}.json`);
  process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = stateFile;
  t.after(() => {
    fs.rmSync(stateFile, { force: true });
    if (previousBudget === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV]; else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previousBudget;
    if (previousState === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV]; else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previousState;
  });
  const cases = [
    ['incomplete arguments', 'Unexpected end of JSON input after {"value":', 'malformed_arguments'],
    ['double-wrapped value', 'value must not contain another value envelope', 'schema_rejection'],
    ['missing outer value', 'value: must have required property value', 'schema_rejection'],
    ['stringified value', 'value: expected object, received string', 'schema_rejection'],
  ];
  for (const [label, diagnostic, kind] of cases) {
    fs.rmSync(stateFile, { force: true });
    const handlers = new Map();
    let active = [...PLANNER_EVIDENCE_TOOLS, PLANNER_RESULT_TOOL];
    plannerEvidenceExtension({
      on: (event, fn) => handlers.set(event, fn),
      getActiveTools: () => active,
      setActiveTools: value => { active = [...value]; },
    });
    await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} });
    await handlers.get('tool_result')({ toolName: PLANNER_RESULT_TOOL, input: {}, isError: true, content: [{ type: 'text', text: diagnostic }] }, {});
    assert.deepEqual(active, [PLANNER_RESULT_TOOL], `${label}: repository tools close immediately`);
    const repair = handlers.get('before_provider_request')({ payload: { tools: [{ function: { name: 'read' } }, { function: { name: PLANNER_RESULT_TOOL } }] } });
    assert.deepEqual(repair.tools.map(tool => tool.function.name), [PLANNER_RESULT_TOOL], `${label}: only result tool remains`);
    assert.equal(repair.tool_choice, 'required', `${label}: result is required`);
    assert.equal(await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: { value: {} } }), undefined, `${label}: one repair result is allowed`);
    assert.equal((await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: { value: {} } })).block, true, `${label}: no third result call`);
    const state = JSON.parse(fs.readFileSync(process.env[PLANNER_EVIDENCE_STATE_FILE_ENV], 'utf8'));
    assert.equal(state.repairKind, kind, `${label}: rejection kind is retained`);
  }
});

test('a second rejected result aborts the child and records a parent retry signal', async (t) => {
  const { dir } = fixture(t, {});
  const stateFile = path.join(dir, 'planner-state.json');
  const previousBudget = process.env[PLANNER_EVIDENCE_BUDGET_ENV];
  const previousState = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  process.env[PLANNER_EVIDENCE_BUDGET_ENV] = '6';
  process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = stateFile;
  t.after(() => {
    if (previousBudget === undefined) delete process.env[PLANNER_EVIDENCE_BUDGET_ENV]; else process.env[PLANNER_EVIDENCE_BUDGET_ENV] = previousBudget;
    if (previousState === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV]; else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previousState;
  });
  const handlers = new Map();
  let aborted = false;
  plannerEvidenceExtension({ on: (event, fn) => handlers.set(event, fn) });
  await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} });
  await handlers.get('tool_result')({ toolName: PLANNER_RESULT_TOOL, input: {}, isError: true, content: [{ type: 'text', text: 'value invalid' }] }, { abort: () => { aborted = true; } });
  await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} });
  await handlers.get('tool_result')({ toolName: PLANNER_RESULT_TOOL, input: {}, isError: true, content: [{ type: 'text', text: 'still invalid' }] }, { abort: () => { aborted = true; } });
  assert.equal(aborted, true);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).repairStatus, 'failed');
  assert.equal((await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} })).block, true);
});

test('a failed child repair escalates once to the existing parent output-only retry', async (t) => {
  const { dir, env } = fixture(t, {});
  const requests = [];
  t.mock.method(console, 'log', () => {});
  const host = plannerHost({
    cwd: dir,
    async driveChild(request) {
      requests.push(request);
      if (requests.length === 1) {
        const handlers = new Map();
        plannerEvidenceExtension({ on: (event, fn) => handlers.set(event, fn) });
        await handlers.get('tool_call')({ toolName: 'read', toolCallId: 'preserved-read', input: { path: 'src/sender.py' } });
        await handlers.get('tool_execution_end')({ toolName: 'read', toolCallId: 'preserved-read', isError: false, result: { content: [{ type: 'text', text: 'def send(): pass' }] } });
        await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} });
        await handlers.get('tool_result')({ toolName: PLANNER_RESULT_TOOL, input: {}, isError: true, content: [{ type: 'text', text: 'Unexpected end of JSON input after {"value":' }] }, {});
        await handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, input: {} });
        await handlers.get('tool_result')({ toolName: PLANNER_RESULT_TOOL, input: {}, isError: true, content: [{ type: 'text', text: 'value invalid' }] }, { abort() {} });
        return { status: 'failed', error: 'Planner child aborted after its single result repair', usage: { turns: 2, toolCalls: 2 } };
      }
      const sidecar = JSON.parse(fs.readFileSync(process.env[PLANNER_EVIDENCE_STATE_FILE_ENV], 'utf8'));
      assert.equal(sidecar.repairStatus, undefined, 'attempt 0 repair status is cleared before attempt 1 starts');
      assert.equal(process.env[PLANNER_OUTPUT_ONLY_ENV], 'true');
      assert.equal(request.toolBudget.hard, 1);
      assert.match(request.task, /Unexpected end of JSON input/);
      assert.match(request.task, /malformed_arguments/);
      assert.match(request.task, /read src\/sender.py: def send\(\): pass/);
      return { status: 'completed', usage: { turns: 1, toolCalls: 1 }, result: { kind: 'structured', value: {
        steps: ['Finish the prepared plan'], facts: ['Previously established planner fact.'], complexity: 'trivial',
        evidence_budget: 0, large_mutation: false, reason: 'The parent retry preserved the planner state.',
      } } };
    },
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(requests.length, 2);
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.repositoryFacts, ['Previously established planner fact.']);
  assert.match(requests[1].task, /EVIDENCE PHASE CLOSED/);
});


test('#481 missing structured_output preserves first-attempt evidence in the output-only retry', async (t) => {
  const { dir, env } = fixture(t, {
    'src/net/transport.py': 'def send_with_backoff(message):\n    return message\n',
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let attempts = 0;
  const retryTasks = [];
  const host = plannerHost({
    cwd: dir,
    async driveChild(request) {
      attempts += 1;
      retryTasks.push(request.task);
      const handlers = new Map();
      plannerEvidenceExtension({ on: (event, fn) => handlers.set(event, fn) });
      if (attempts === 1) {
        await handlers.get('tool_call')({
          toolName: 'read',
          toolCallId: 'read-transport',
          input: { path: 'src/net/transport.py' },
        });
        await handlers.get('tool_execution_end')({
          toolName: 'read',
          toolCallId: 'read-transport',
          isError: false,
          result: { content: [{ type: 'text', text: 'def send_with_backoff(message): return message' }] },
        });
        return {
          status: 'failed',
          error: 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.',
          usage: { input: 100, output: 10, turns: 1, toolCalls: 1 },
        };
      }
      assert.equal(process.env[PLANNER_OUTPUT_ONLY_ENV], 'true');
      assert.equal(request.toolBudget.hard, 1);
      assert.match(request.task, /PRESERVED EVIDENCE FROM ATTEMPT 1/);
      assert.match(request.task, /1\/6 evidence actions consumed/);
      assert.match(request.task, /send_with_backoff/);
      assert.match(request.task, /do not call read, grep, find, or ls/);
      return {
        status: 'completed',
        usage: { input: 40, output: 5, turns: 1, toolCalls: 1 },
        result: { kind: 'structured', value: {
          steps: ['Edit send_with_backoff'],
          facts: ['src/net/transport.py contains send_with_backoff.'],
          complexity: 'trivial',
          evidence_budget: 1,
          large_mutation: false,
          reason: 'The target is known and main needs one current mutation anchor.',
        } },
      };
    },
  });

  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(attempts, 2);
  assert.equal(prepared.plannerEvidenceUsed, 1);
  assert.deepEqual(prepared.repositoryFacts, ['src/net/transport.py contains send_with_backoff.']);
  assert.match(retryTasks[1], /exactly one top-level "value"/);
});

test('malformed pseudo-tool on output-only retry is classified explicitly and fails closed', async (t) => {
  const { dir, env } = fixture(t, {});
  const warnings = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let attempts = 0;
  const host = plannerHost({
    cwd: dir,
    async driveChild() {
      attempts++;
      if (attempts === 1) {
        return {
          status: 'failed',
          error: 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.',
          usage: { input: 100, output: 10, turns: 1, toolCalls: 0 },
        };
      }
      return {
        status: 'failed',
        error: 'Tool <|virtual| not found',
        usage: { input: 25, output: 3, turns: 1, toolCalls: 1 },
      };
    },
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(attempts, 2, 'malformed retry is never given another retry');
  assert.equal(prepared.status, 'fallback');
  assert.ok(warnings.mock.calls.some(call =>
    String(call.arguments[0]).includes('"reason":"output_only_invalid_tool"')
  ));
});

test('output-only retry reports a multi-turn or extra-tool anomaly instead of hiding it', async (t) => {
  const { dir, env } = fixture(t, {});
  const warnings = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let attempts = 0;
  const host = plannerHost({
    cwd: dir,
    async driveChild() {
      attempts++;
      if (attempts === 1) {
        return { status: 'failed', error: 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.', usage: { input: 100, output: 10, turns: 1, toolCalls: 0 } };
      }
      return {
        status: 'completed',
        usage: { input: 50, output: 5, turns: 2, toolCalls: 2 },
        result: { kind: 'structured', value: {
          steps: ['Do it'], facts: [], complexity: 'trivial', evidence_budget: 0, large_mutation: false, reason: 'ok',
        } },
      };
    },
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared');
  assert.ok(warnings.mock.calls.some(call => String(call.arguments[0]).startsWith('PI_PLANNER_OUTPUT_ONLY_ANOMALY ')));
});

test('a failed planner lifecycle still records one aggregated planner metric and keeps its usage for the fallback', async (t) => {
  const { dir, env } = fixture(t, {});
  const metrics = path.join(dir, 'metrics.jsonl');
  const previousMetrics = process.env.PI_METRICS_FILE;
  process.env.PI_METRICS_FILE = metrics;
  t.after(() => { if (previousMetrics === undefined) delete process.env.PI_METRICS_FILE; else process.env.PI_METRICS_FILE = previousMetrics; });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const host = plannerHost({
    cwd: dir,
    driveChild: async () => ({ status: 'failed', error: 'Structured output validation failed: value: bad', usage: { output: 4 } }),
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'fallback');
  assert.deepEqual(prepared.plannerUsage, { output: 8 });
  const records = fs.readFileSync(metrics, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => [record.call, record.status]), [['planner', 'failed']]);
});
