import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

import plannerEvidenceExtension, { plannerCodeGraph, registerPlannerEvidenceTools } from '../scripts/pi-planner-evidence.mjs';
import {
  IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA,
  PLANNER_EVIDENCE_STATE_FILE_ENV,
  PLANNER_EVIDENCE_TOOLS,
  PLANNER_RESULT_TOOL,
  createPlannerEvidenceGate,
  normalizeImplementationPreparation,
  plannerEvidenceFact,
  plannerTask,
  prepareImplementation,
  validateImplementationPreparation,
} from '../scripts/pi-common/implementation-planner.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

const FORBIDDEN_TOOLS = [
  'bash', 'write', 'edit', 'safe_edit', 'structural_edit', 'run_check', 'submit_result', 'begin_coding_session',
  'request_large_mutation_budget', 'need_more_evidence', 'subagent', 'web_search', 'web_fetch', 'github_comment',
  'accept_mutation_scope', 'retry_last_failed_check',
];

function agentSource() {
  return fs.readFileSync('.pi/agents/implementation-planner.md', 'utf8');
}

function agentTools() {
  const frontmatter = agentSource().match(/^---\n([\s\S]*?)\n---/)[1];
  const line = frontmatter.split('\n').find(entry => entry.startsWith('tools:'));
  return line.slice('tools:'.length).split(',').map(tool => tool.trim()).filter(Boolean);
}

function stateFileFor(t, prefix = 'pi-planner-state') {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const previous = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = file;
  t.after(() => {
    fs.rmSync(file, { force: true });
    if (previous === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
    else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previous;
  });
  return file;
}

function extensionHarness(t, { stateFile = stateFileFor(t), mockLog = true } = {}) {
  const handlers = new Map();
  let activeTools = [...PLANNER_EVIDENCE_TOOLS, PLANNER_RESULT_TOOL];
  let aborted = false;
  const logs = mockLog ? t.mock.method(console, 'log', () => {}) : null;
  plannerEvidenceExtension({
    on: (event, fn) => handlers.set(event, fn),
    getActiveTools: () => activeTools,
    setActiveTools: value => { activeTools = [...value]; },
  });
  return {
    handlers,
    stateFile,
    activeTools: () => activeTools,
    abortContext: { abort: () => { aborted = true; } },
    aborted: () => aborted,
    logs: () => logs?.mock.calls.map(call => String(call.arguments[0])) ?? [],
  };
}

function fixture(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
  const issue = path.join(dir, '.issue.json');
  fs.writeFileSync(issue, JSON.stringify({ title: 'Add retry to sender', body: 'Make sender retry on 503.' }));
  const previous = process.env.PI_ISSUE_CONTEXT;
  process.env.PI_ISSUE_CONTEXT = issue;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_ISSUE_CONTEXT;
    else process.env.PI_ISSUE_CONTEXT = previous;
  });
  return { dir, env: { PI_ISSUE_CONTEXT: issue, PI_IMPLEMENTER_START_COMMIT: 'abc123' } };
}

function plannerHost({ cwd, driveChild }) {
  const bus = new EventEmitter();
  const requests = [];
  bus.on('prompt-template:subagent:request', async request => {
    requests.push(request);
    let reply;
    try { reply = await driveChild(request); }
    catch (error) { reply = { status: 'failed', error: String(error?.stack ?? error) }; }
    bus.emit('prompt-template:subagent:response', {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      ...reply,
    });
  });
  const pi = { events: { on: (e, fn) => { bus.on(e, fn); return () => bus.off(e, fn); }, emit: (...a) => bus.emit(...a) } };
  return { pi, requests, ctx: { cwd, sessionManager: { getSessionId: () => 'bootstrap' } } };
}

test('planner surface remains strictly read-only while evidence admission has no numeric cap', () => {
  assert.deepEqual(agentTools(), [...PLANNER_EVIDENCE_TOOLS]);
  const gate = createPlannerEvidenceGate();
  for (let index = 0; index < 12; index += 1) {
    const verdict = gate.admit(PLANNER_EVIDENCE_TOOLS[index % PLANNER_EVIDENCE_TOOLS.length]);
    assert.equal(verdict.allowed, true, `useful action ${index + 1} is admitted`);
    assert.equal(verdict.used, index + 1);
    assert.equal('remaining' in verdict, false);
    assert.equal('cap' in verdict, false);
  }
  for (const forbidden of FORBIDDEN_TOOLS) {
    const verdict = gate.admit(forbidden);
    assert.equal(verdict.allowed, false, forbidden);
    assert.match(verdict.reason, /read-only evidence tools only/);
  }
  assert.equal(gate.admit(PLANNER_RESULT_TOOL).allowed, true);
});

test('planner prompt and agent contract use cat completion incentive and no model-visible planner budget', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const issue = path.join(dir, 'issue.json');
  fs.writeFileSync(issue, JSON.stringify({ title: 'Target', body: 'Update src/a.py.' }));
  const task = plannerTask({ PI_ISSUE_CONTEXT: issue });

  for (const text of [agentSource(), task]) {
    assert.match(text, /cat wants to be petted/i);
    assert.match(text, /only after .*plan.*accepted/i);
    assert.match(text, /materially change or improve/i);
    assert.doesNotMatch(text, /at most 6 .*evidence/i);
    assert.doesNotMatch(text, /evidence actions remaining|minutes remaining|result attempts remaining|repair attempts remaining/i);
  }
  assert.match(task, /there is no fixed repair-attempt budget/i);
  assert.match(agentSource(), /There is no fixed result-attempt or repair-attempt budget/i);
});

test('more than six distinct useful evidence actions are accepted and telemetry exposes only action count', async (t) => {
  const harness = extensionHarness(t);
  for (let index = 0; index < 8; index += 1) {
    const tool = 'read';
    const toolCallId = `e-${index}`;
    const input = { path: `src/useful-${index}.mjs` };
    const result = await harness.handlers.get('tool_call')({
      toolName: tool,
      toolCallId,
      input,
    }, harness.abortContext);
    assert.equal(result, undefined);
    await harness.handlers.get('tool_execution_end')({
      toolName: tool,
      toolCallId,
      isError: false,
      result: { content: [{ type: 'text', text: `export const useful${index} = ${index};` }] },
    });
  }
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.used, 8);
  assert.equal('cap' in state, false);
  assert.equal(harness.aborted(), false);
  const markers = harness.logs().filter(line => line.startsWith('PI_PLANNER_EVIDENCE '));
  assert.equal(markers.length, 8);
  assert.ok(markers.every(line => !/remaining|cap/.test(line)));
  assert.match(markers[7], /"action":8/);
  assert.equal(
    harness.logs().filter(line => line.includes('PI_PLANNER_CAT_WAITING') && line.includes('"event":"progress"')).length,
    8,
    'each distinct useful result may remind that the same waiting cat still exists without accumulating reward',
  );
});

test('equivalent repository action is stopped only after it demonstrates no progress', async (t) => {
  const harness = extensionHarness(t);
  const call = async id => harness.handlers.get('tool_call')({
    toolName: 'read',
    toolCallId: id,
    input: { path: 'src/net.py' },
  }, harness.abortContext);
  const finish = async id => harness.handlers.get('tool_execution_end')({
    toolName: 'read',
    toolCallId: id,
    isError: false,
    result: { content: [{ type: 'text', text: 'def send(): return 1' }] },
  });

  assert.equal(await call('e1'), undefined);
  await finish('e1');
  assert.equal(await call('e2'), undefined, 'one repeated read is allowed until its result proves no new information');
  await finish('e2');

  const blocked = await call('e3');
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /semantic no-progress/i);
  assert.equal(harness.aborted(), true);
  assert.equal(JSON.parse(fs.readFileSync(harness.stateFile, 'utf8')).failureKind, 'semantic_no_progress');
  assert.ok(harness.logs().some(line => line.startsWith('PI_PLANNER_NO_PROGRESS ')));
});

test('successful evidence stores compact redacted facts and emits neutral CAT_WAITING progress', async (t) => {
  const harness = extensionHarness(t);
  await harness.handlers.get('tool_call')({
    toolName: 'read', toolCallId: 'read-1', input: { path: 'src/net/transport.py' },
  }, harness.abortContext);
  await harness.handlers.get('tool_execution_end')({
    toolName: 'read',
    toolCallId: 'read-1',
    isError: false,
    result: { content: [{ type: 'text', text: 'def send(): pass\nAPI_KEY=sk-super-secret-credential-value' }] },
  });

  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.used, 1);
  assert.equal(state.facts.length, 1);
  assert.ok(state.facts[0].length <= 200);
  assert.doesNotMatch(state.facts[0], /super-secret|sk-/);
  assert.ok(harness.logs().some(line => line.includes('PI_PLANNER_CAT_WAITING') && line.includes('"event":"progress"')));
  assert.ok(!harness.logs().some(line => line.startsWith('PI_PLANNER_CAT_PETTED ')));
});

test('structured output corrections converge without a fixed attempt limit and evidence stays closed', async (t) => {
  const harness = extensionHarness(t);
  const resultCall = async (id, error, diagnostic) => {
    const admitted = await harness.handlers.get('tool_call')({ toolName: PLANNER_RESULT_TOOL, toolCallId: id, input: { value: {} } }, harness.abortContext);
    assert.equal(admitted, undefined);
    return harness.handlers.get('tool_result')({
      toolName: PLANNER_RESULT_TOOL,
      toolCallId: id,
      input: { value: {} },
      isError: error,
      content: diagnostic ? [{ type: 'text', text: diagnostic }] : [],
    }, harness.abortContext);
  };

  const first = await resultCall('r1', true, 'Validation failed: value must have required property steps');
  assert.match(first.content[0].text, /Repository evidence remains closed/);
  const blockedEvidence = await harness.handlers.get('tool_call')({ toolName: 'read', input: { path: 'src/a.py' } }, harness.abortContext);
  assert.equal(blockedEvidence.block, true);

  const second = await resultCall('r2', true, 'Validation failed: value must have required property reason');
  assert.match(second.content[0].text, /call structured_output again/);
  assert.equal(harness.aborted(), false, 'a second improving correction is not a failure');

  await resultCall('r3', false, null);
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.resultAttempts, 3);
  assert.equal(state.structuredCorrections, 2);
  assert.equal(state.repairStatus, 'accepted');
  assert.deepEqual(harness.activeTools(), [PLANNER_RESULT_TOOL]);
});

test('three materially equivalent invalid structured outputs trip semantic no-progress protection', async (t) => {
  const harness = extensionHarness(t);
  for (let index = 1; index <= 3; index += 1) {
    assert.equal(await harness.handlers.get('tool_call')({
      toolName: PLANNER_RESULT_TOOL, toolCallId: `r${index}`, input: { value: {} },
    }, harness.abortContext), undefined);
    await harness.handlers.get('tool_result')({
      toolName: PLANNER_RESULT_TOOL,
      toolCallId: `r${index}`,
      input: { value: {} },
      isError: true,
      content: [{ type: 'text', text: 'Validation failed: value must have required property steps' }],
    }, harness.abortContext);
  }
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.structuredCorrections, 3);
  assert.equal(state.failureKind, 'semantic_no_progress');
  assert.equal(harness.aborted(), true);
});

test('harmless plan oversize is normalized: nine steps survive and long strings do not cause fallback validation', () => {
  const raw = {
    steps: Array.from({ length: 9 }, (_, index) => `Step ${index + 1} ${'x'.repeat(350)}`),
    facts: Array.from({ length: 8 }, (_, index) => `Fact ${index + 1} ${'y'.repeat(260)}`),
    complexity: 'nontrivial',
    evidence_budget: 1,
    large_mutation: false,
    reason: 'z'.repeat(500),
    ignored_extra_field: true,
  };
  const normalized = normalizeImplementationPreparation(raw);
  assert.equal(normalized.steps.length, 9);
  assert.ok(normalized.steps.every(step => step.length <= 240));
  assert.equal(normalized.facts.length, 6);
  assert.ok(normalized.facts.every(fact => fact.length <= 200));
  assert.ok(normalized.reason.length <= 300);
  assert.equal('ignored_extra_field' in normalized, false);
  const validated = validateImplementationPreparation(normalized);
  assert.equal(validated.steps.length, 9);

  assert.equal(IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA.properties.steps.maxItems, undefined);
  assert.equal(IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA.properties.facts.maxItems, undefined);
  assert.equal(IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA.properties.reason.maxLength, undefined);
});

test('Implementer evidence_budget remains a separate downstream 0-6 contract', () => {
  for (const evidenceBudget of [0, 1, 6]) {
    const result = validateImplementationPreparation({
      steps: ['Do it'], facts: [], complexity: 'nontrivial', evidence_budget: evidenceBudget, large_mutation: false, reason: 'ok',
    });
    assert.equal(result.evidenceBudget, evidenceBudget);
  }
  assert.throws(() => validateImplementationPreparation({
    steps: ['Do it'], facts: [], complexity: 'trivial', evidence_budget: 7, large_mutation: false, reason: 'ok',
  }), /evidence_budget/);
});

test('parent planner lifecycle records >6 actions, corrections, and CAT_PETTED only after accepted normalized result', async (t) => {
  const { dir, env } = fixture(t);
  const logs = t.mock.method(console, 'log', () => {});
  const host = plannerHost({
    cwd: dir,
    async driveChild(request) {
      assert.equal(request.timeoutMs, undefined);
      assert.equal(request.toolBudget, undefined);
      assert.deepEqual(Object.keys(request.childEnv), [PLANNER_EVIDENCE_STATE_FILE_ENV]);
      assert.doesNotMatch(request.task, /at most 6 .*evidence/i);
      fs.writeFileSync(request.childEnv[PLANNER_EVIDENCE_STATE_FILE_ENV], JSON.stringify({
        used: 8, facts: ['src/net.py contains send().'], structuredCorrections: 2, resultAttempts: 3, repairStatus: 'accepted',
      }));
      return {
        status: 'completed',
        usage: { input: 900, output: 700, turns: 4, toolCalls: 11 },
        result: { kind: 'structured', value: {
          steps: Array.from({ length: 9 }, (_, index) => `Step ${index + 1}`),
          facts: ['src/net.py contains send().'],
          complexity: 'nontrivial', evidence_budget: 1, large_mutation: false, reason: 'grounded',
        } },
      };
    },
  });

  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.plan.length, 9);
  assert.equal(prepared.plannerEvidenceActions, 8);
  assert.equal(prepared.plannerStructuredCorrections, 2);
  assert.equal(prepared.plannerProviderTurns, 4);
  assert.ok(logs.mock.calls.some(call => String(call.arguments[0]).startsWith('PI_PLANNER_CAT_PETTED ')));
});

test('unrecoverable missing structured result falls back truthfully without CAT_PETTED or deadline classification', async (t) => {
  const { dir, env } = fixture(t);
  const logs = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const host = plannerHost({
    cwd: dir,
    driveChild: async () => ({
      status: 'failed',
      error: 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.',
      usage: { input: 100, output: 20, turns: 1 },
    }),
  });
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'fallback');
  assert.equal(prepared.failureClass, 'structured_result_unrecoverable');
  assert.notEqual(prepared.failureClass, 'planner_deadline_timeout');
  assert.ok(!logs.mock.calls.some(call => String(call.arguments[0]).startsWith('PI_PLANNER_CAT_PETTED ')));
});

test('planner observability uses action/correction fields and has no cap telemetry', () => {
  const bootstrap = fs.readFileSync('scripts/pi-implementer-bootstrap.mjs', 'utf8');
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  const combined = `${bootstrap}\n${runtime}`;
  assert.match(combined, /plannerEvidenceActions/);
  assert.match(combined, /plannerStructuredCorrections/);
  assert.doesNotMatch(combined, /plannerEvidenceCap|evidenceCap:/);
  assert.doesNotMatch(combined, /plannerEvidenceUsed|evidenceUsed:/);
});

test('repo_search and planner_code_graph remain the only custom read-only planner tools', async () => {
  const registered = [];
  registerPlannerEvidenceTools({ registerTool: tool => registered.push(tool) }, {
    repoSearchFn: (_cwd, params) => ({ kind: 'content', query: params.query, matches: [], truncated: false }),
  });
  assert.deepEqual(registered.map(tool => tool.name), ['repo_search', 'planner_code_graph']);

  const repoSearch = registered.find(tool => tool.name === 'repo_search');
  const result = await repoSearch.execute('r', { query: 'target' }, null, null, { cwd: '/tmp/work' });
  assert.match(result.content[0].text, /"query":"target"/);
});

test('planner_code_graph remains bounded, focused, and worktree-scoped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-graph-'));
  try {
    const calls = [];
    const fakeExec = async (command, args, options) => {
      calls.push([command, args[0], options.cwd]);
      if (command === 'git') return { stdout: 'abc123\n' };
      if (args[0] === 'list') return { stdout: JSON.stringify([{ repo_path: dir, commit_sha: 'abc123', status: 'indexed' }]) };
      if (args[0] === 'context') return { stdout: ('caller alpha -> target\nreference beta -> target\n').repeat(1200) };
      throw new Error('unexpected command');
    };
    const result = await plannerCodeGraph(dir, {
      target: 'Definition:target',
      question: 'Which callers form the blast radius?',
    }, { execFile: fakeExec });
    assert.equal(result.truncated, true);
    assert.match(result.text, /caller alpha/);
    assert.doesNotMatch(result.text, /reference beta/);
    assert.deepEqual(calls.map(call => call.slice(0, 2)), [['git', 'rev-parse'], ['orbit', 'list'], ['orbit', 'context']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planner evidence fact remains compact and redacted', () => {
  const fact = plannerEvidenceFact('read', { path: 'src/a.py' }, {
    content: [{ type: 'text', text: `const token = "sk-super-secret-credential-value"; ${'x'.repeat(500)}` }],
  });
  assert.ok(fact.length <= 200);
  assert.doesNotMatch(fact, /super-secret|sk-/);
});
