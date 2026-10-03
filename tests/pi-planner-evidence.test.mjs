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
  createPlannerEvidenceGate,
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

test('planner evidence state records only bounded counters, never repository contents', async (t) => {
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
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { used: 2, cap: 6 });
  assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /path|content|result|transcript/i);
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
    const reply = await driveChild(request);
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
      const handlers = [];
      plannerEvidenceExtension({ on: (_event, fn) => handlers.push(fn) });
      t.mock.method(console, 'log', () => {});
      assert.equal(await handlers[0]({ toolName: 'read', input: {} }), undefined);
      assert.equal(await handlers[0]({ toolName: 'read', input: {} }), undefined);
      assert.equal((await handlers[0]({ toolName: 'write', input: {} })).block, true);
      assert.equal((await handlers[0]({ toolName: 'bash', input: {} })).block, true);
      const source = fs.readFileSync(path.join(dir, 'src/net/transport.py'), 'utf8');
      const target = source.match(/def (\w+)/)[1];
      return {
        status: 'completed', usage: { input: 900, output: 1200, turns: 1, durationMs: 2500 },
        result: { kind: 'structured', value: {
          steps: [
            `Add 503 retry inside ${target} in src/net/transport.py; preserve the observed single delivery entry point.`,
            'Extend tests/test_transport.py using the observed sibling pytest function layout for the retry path.',
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
    assert.match(task, /exact path\/directory\/symbol\/test/);
    assert.match(task, /avoid root listings and repo-wide discovery/);
    assert.match(task, /state the fact in steps\/reason instead of telling main to rediscover it/);
    assert.match(task, /ONLY the repository evidence main still needs/);
    assert.match(task, /current mutation anchor/);
    assert.match(task, /reserve at least one action for each existing file main must modify/);
    assert.match(task, /New-file-only work may use 0/);
    assert.match(task, /2048-token ceiling/);
    assert.doesNotMatch(task, /typically 1-3|1–3 actions is typical/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    'reason', 'status', 'version', 'workspaceRoot',
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
    async driveChild() {
      const handlers = [];
      plannerEvidenceExtension({ on: (_event, fn) => handlers.push(fn) });
      const verdicts = [];
      for (let index = 0; index < 7; index += 1) verdicts.push(await handlers[0]({ toolName: 'read', input: {} }));
      const structured = await handlers[0]({ toolName: 'structured_output', input: {} });
      attempts.push({ accepted: verdicts.filter(verdict => verdict === undefined).length, structured });
      if (attempts.length === 1) {
        return { status: 'failed', error: 'Structured output validation failed: value: bad', usage: { input: 100, output: 10 } };
      }
      return {
        status: 'completed', usage: { input: 50, output: 5 },
        result: { kind: 'structured', value: { steps: ['Do it'], complexity: 'trivial', evidence_budget: 1, large_mutation: false, reason: 'ok' } },
      };
    },
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });

  assert.equal(host.requests.length, 2);
  assert.deepEqual(attempts.map(attempt => attempt.accepted), [6, 0], 'first attempt spends the full 6; the retry gets none');
  assert.equal(attempts[1].structured, undefined, 'structured_output stays available on the retry');
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.plannerUsage, { input: 150, output: 15 }, 'all attempts are aggregated');
  assert.equal(prepared.plannerEvidenceUsed, 6, 'retry cap=0 cannot erase evidence spent by the first attempt');
  assert.equal(prepared.plannerEvidenceCap, 6);
  const records = fs.readFileSync(metrics, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 1, 'exactly one metric record for the planner lifecycle');
  assert.equal(records[0].call, 'planner');
  assert.equal(records[0].status, 'completed');
  assert.deepEqual(records[0].usage, { input: 150, output: 15 });
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
