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
  const messages = [];
  const logs = mockLog ? t.mock.method(console, 'log', () => {}) : null;
  plannerEvidenceExtension({
    on: (event, fn) => handlers.set(event, fn),
    getActiveTools: () => activeTools,
    setActiveTools: value => { activeTools = [...value]; },
    sendUserMessage: async (message, options) => { messages.push({ message, options }); },
  });
  return {
    handlers,
    stateFile,
    activeTools: () => activeTools,
    abortContext: { abort: () => { aborted = true; } },
    aborted: () => aborted,
    messages: () => [...messages],
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
    assert.doesNotMatch(text, /evidence_budget/);
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
  assert.equal(harness.messages().length, 8);
  assert.equal(new Set(harness.messages().map(item => item.message)).size, 1, 'the reminder is state-based and never accumulates points');
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
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.failureKind, 'semantic_no_progress');
  assert.equal(state.used, 2, 'the blocked third call is not counted as an admitted evidence action');
  assert.ok(harness.logs().some(line => line.startsWith('PI_PLANNER_NO_PROGRESS ')));
});

test('alternating and slightly varied no-progress evidence cannot loop forever', async (t) => {
  const harness = extensionHarness(t);
  const run = async (toolCallId, pathName) => {
    assert.equal(await harness.handlers.get('tool_call')({
      toolName: 'read', toolCallId, input: { path: pathName },
    }, harness.abortContext), undefined);
    await harness.handlers.get('tool_execution_end')({
      toolName: 'read',
      toolCallId,
      isError: false,
      result: { content: [{ type: 'text', text: 'same stable content' }] },
    }, harness.abortContext);
  };

  await run('a1', 'src/a.py');
  await run('b1', 'src/b.py');
  await run('a2', 'src/a.py');
  await run('b2', 'src/b.py');
  await run('a3', 'src/a.py');
  await run('b3', 'src/b.py');

  assert.equal(harness.aborted(), true);
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.failureKind, 'semantic_no_progress');
  assert.equal(state.used, 6);
  assert.ok(harness.logs().some(line => line.includes('"kind":"evidence_streak"')));
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
  assert.deepEqual(harness.messages(), [{
    message: '🐈 The cat is still waiting to be petted. Finish the plan as soon as you have enough evidence.',
    options: { deliverAs: 'steer' },
  }]);
  assert.ok(!harness.logs().some(line => line.startsWith('PI_PLANNER_CAT_PETTED ')));
});

test('prose-only planner completion gets one forced result-only recovery then fails closed on repetition', async (t) => {
  const harness = extensionHarness(t);

  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'The plan is ready.' }],
    },
  }, harness.abortContext);

  assert.deepEqual(harness.activeTools(), [PLANNER_RESULT_TOOL]);
  assert.equal(harness.aborted(), false);
  assert.equal(harness.messages().length, 1);
  assert.match(harness.messages()[0].message, /Call structured_output now/i);

  const forced = harness.handlers.get('before_provider_request')({
    payload: {
      tools: [
        { type: 'function', function: { name: 'read' } },
        { type: 'function', function: { name: PLANNER_RESULT_TOOL } },
      ],
      tool_choice: 'auto',
    },
  });
  assert.equal(forced.tool_choice, 'required');
  assert.deepEqual(forced.tools.map(tool => tool.function.name), [PLANNER_RESULT_TOOL]);

  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Still prose.' }],
    },
  }, harness.abortContext);

  assert.equal(harness.aborted(), true);
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.failureKind, 'semantic_no_progress');
  assert.equal(state.repairKind, 'missing_structured_output');
  assert.ok(harness.logs().some(line => line.startsWith('PI_PLANNER_RESULT_RECOVERY ')));
});

test('evidence tool turns do not trigger missing-result recovery while exploration is active', async (t) => {
  const harness = extensionHarness(t);
  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'e1', name: 'read', arguments: { path: 'src/a.py' } }],
    },
  }, harness.abortContext);

  assert.equal(harness.messages().length, 0);
  assert.deepEqual(harness.activeTools(), [...PLANNER_EVIDENCE_TOOLS, PLANNER_RESULT_TOOL]);
  assert.equal(harness.aborted(), false);
});

test('accepted structured output is terminal immediately and late duplicates stay harmless', async (t) => {
  const harness = extensionHarness(t);
  const acceptedValue = {
    steps: ['Update src/net.py'],
    facts: ['src/net.py contains send().'],
    complexity: 'nontrivial',
    required_mutation_anchors: ['src/net.py'],
    large_mutation: false,
    reason: 'Existing sender needs a bounded edit.',
  };
  const resultCall = async (id, error, diagnostic, value = {}) => {
    const input = { value };
    const admitted = await harness.handlers.get('tool_call')({
      toolName: PLANNER_RESULT_TOOL, toolCallId: id, input,
    }, harness.abortContext);
    assert.equal(admitted, undefined);
    return harness.handlers.get('tool_result')({
      toolName: PLANNER_RESULT_TOOL,
      toolCallId: id,
      input,
      isError: error,
      content: diagnostic ? [{ type: 'text', text: diagnostic }] : [],
    }, harness.abortContext);
  };

  const first = await resultCall('r1', true, 'Validation failed: value must have required property steps');
  assert.match(first.content[0].text, /Repository evidence remains closed/);
  const blockedEvidence = await harness.handlers.get('tool_call')({
    toolName: 'read', input: { path: 'src/a.py' },
  }, harness.abortContext);
  assert.equal(blockedEvidence.block, true);

  const second = await resultCall('r2', true, 'Validation failed: value must have required property reason');
  assert.match(second.content[0].text, /call structured_output again/);
  await resultCall('r3', true, 'Validation failed: complexity must be trivial or nontrivial');
  await resultCall('r4', true, 'Validation failed: required_mutation_anchors must be an array');
  assert.equal(harness.aborted(), false, 'progressive corrections remain unbounded by result-attempt count');

  await resultCall('r5', false, null, acceptedValue);
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.resultAttempts, 5);
  assert.equal(state.structuredCorrections, 4);
  assert.equal(state.repairStatus, 'accepted');
  assert.deepEqual(state.acceptedResult, acceptedValue);
  assert.equal(harness.aborted(), true, 'accepted result aborts the delegated lifecycle immediately');
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_RESULT_SUCCESS ')).length, 1);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_CAT_PETTED ')).length, 1);

  const late = await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'late',
    input: { value: acceptedValue },
  }, harness.abortContext);
  assert.equal(late.block, true);
  assert.match(late.reason, /one structured_output call at a time/i);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_CAT_PETTED ')).length, 1);
  assert.ok(harness.logs().some(line => line.startsWith('PI_PLANNER_RESULT_DUPLICATE_BLOCKED ')));
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

test('successful planner handoff preserves long semantic content without numeric ceilings', () => {
  const raw = {
    steps: Array.from({ length: 24 }, (_, index) => `Step ${index + 1} ${'x'.repeat(350)}`),
    facts: Array.from({ length: 8 }, (_, index) => `Fact ${index + 1} ${'y'.repeat(260)}`),
    complexity: 'nontrivial',
    required_mutation_anchors: ['src/existing.py', 'tests/existing.test.py'],
    large_mutation: false,
    reason: 'z'.repeat(500),
    ignored_extra_field: true,
  };
  const normalized = normalizeImplementationPreparation(raw);
  assert.equal(normalized.steps.length, 24);
  assert.ok(normalized.steps.every(step => step.length > 240));
  assert.equal(normalized.facts.length, 8);
  assert.ok(normalized.facts.every(fact => fact.length > 200));
  assert.equal(normalized.reason.length, 500);
  assert.equal('ignored_extra_field' in normalized, false);

  const validated = validateImplementationPreparation(normalized);
  assert.equal(validated.steps.length, 24);
  assert.equal(validated.facts.length, 8);
  assert.deepEqual(validated.requiredMutationAnchors, ['src/existing.py', 'tests/existing.test.py']);
  assert.equal(validated.reason.length, 500);

  assert.equal(IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA.properties.steps.maxItems, undefined);
  assert.equal(IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA.properties.facts.maxItems, undefined);
  assert.equal(IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA.properties.reason.maxLength, undefined);
  assert.equal('evidence_budget' in IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA.properties, false);
});

test('planner handoff keeps structural validation while using semantic mutation anchors', () => {
  const valid = validateImplementationPreparation({
    steps: ['Do it'],
    facts: ['Known fact'],
    complexity: 'nontrivial',
    required_mutation_anchors: ['src/existing.py'],
    large_mutation: false,
    reason: 'ok',
  });
  assert.deepEqual(valid.requiredMutationAnchors, ['src/existing.py']);

  for (const bad of [
    { steps: [], facts: [], complexity: 'trivial', required_mutation_anchors: [], large_mutation: false, reason: 'ok' },
    { steps: ['Do it'], facts: [''], complexity: 'trivial', required_mutation_anchors: [], large_mutation: false, reason: 'ok' },
    { steps: ['Do it'], facts: [], complexity: 'medium', required_mutation_anchors: [], large_mutation: false, reason: 'ok' },
    { steps: ['Do it'], facts: [], complexity: 'trivial', required_mutation_anchors: ['../escape.py'], large_mutation: false, reason: 'ok' },
    { steps: ['Do it'], facts: [], complexity: 'trivial', required_mutation_anchors: [], large_mutation: 'no', reason: 'ok' },
    { steps: ['Do it'], facts: [], complexity: 'trivial', required_mutation_anchors: [], large_mutation: false, reason: '' },
  ]) {
    assert.throws(() => validateImplementationPreparation(bad));
  }
});

test('parent recovers the persisted accepted result when terminal child aborts immediately', async (t) => {
  const { dir, env } = fixture(t);
  t.mock.method(console, 'log', () => {});
  const acceptedResult = {
    steps: Array.from({ length: 19 }, (_, index) => `Step ${index + 1}`),
    facts: Array.from({ length: 8 }, (_, index) => `Repository fact ${index + 1}`),
    complexity: 'nontrivial',
    required_mutation_anchors: ['src/net.py'],
    large_mutation: false,
    reason: 'grounded',
  };
  const host = plannerHost({
    cwd: dir,
    async driveChild(request) {
      assert.equal(request.timeoutMs, undefined);
      assert.equal(request.toolBudget, undefined);
      assert.doesNotMatch(request.task, /at most 6 .*evidence/i);
      assert.doesNotMatch(request.task, /evidence_budget/);
      const evidenceStateFile = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
      assert.ok(evidenceStateFile);
      fs.writeFileSync(evidenceStateFile, JSON.stringify({
        used: 8,
        facts: Array.from({ length: 8 }, (_, index) => `fact-${index}`),
        structuredCorrections: 0,
        resultAttempts: 1,
        repairStatus: 'accepted',
        acceptedResult,
      }));
      return {
        status: 'cancelled',
        error: 'planner terminalized after accepted structured_output',
        usage: { input: 900, output: 500, turns: 1, toolCalls: 9 },
      };
    },
  });

  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.plan.length, 19);
  assert.equal(prepared.repositoryFacts.length, 8);
  assert.deepEqual(prepared.requiredMutationAnchors, ['src/net.py']);
  assert.equal('evidenceBudget' in prepared, false);
  assert.equal(prepared.plannerEvidenceActions, 8);
  assert.equal(prepared.plannerProviderTurns, 1);
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
