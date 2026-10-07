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
  PLANNER_RESOLVED_TARGETS_ENV,
  PLANNER_EVIDENCE_TOOLS,
  PLANNER_RESULT_TOOL,
  createPlannerEvidenceGate,
  normalizeImplementationPreparation,
  plannerEvidenceFact,
  plannerTargetPolicy,
  plannerTask,
  prepareImplementation,
  validateImplementationPreparation,
} from '../scripts/pi-common/implementation-planner.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';
import { buildPlannerOrbitSeed, plannerOrbitSeedTargets } from '../scripts/pi-common/planner-orbit.mjs';

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

test('planner target policy separates immutable resolved targets from convention fallbacks', () => {
  const explicit = plannerTargetPolicy({
    sourceTarget: 'src/social_mcp/diagnostics/smoke_labels.py',
    sourceDirectory: 'src/social_mcp/diagnostics',
    sourceConvention: 'src/social_mcp/diagnostics/smoke_retry_after.py',
    testTarget: 'tests/test_smoke_labels.py',
    testTargetRequired: true,
    testDirectory: 'tests/diagnostics',
    testConvention: 'tests/diagnostics/test_smoke_retry_after.py',
  });
  assert.deepEqual(explicit.resolvedTargets, {
    source: 'src/social_mcp/diagnostics/smoke_labels.py',
    test: 'tests/test_smoke_labels.py',
  });
  assert.equal(explicit.conventionHints.testDirectory, 'tests/diagnostics');
  assert.equal('testTarget' in explicit.conventionHints, false);

  const fallback = plannerTargetPolicy({
    sourceTarget: 'src/social_mcp/diagnostics/smoke_labels.py',
    testTarget: 'tests/diagnostics/test_smoke_labels.py',
    testTargetRequired: false,
    testDirectory: 'tests/diagnostics',
    testConvention: 'tests/diagnostics/test_smoke_retry_after.py',
  });
  assert.equal(fallback.resolvedTargets.test, undefined);
  assert.equal(fallback.conventionHints.testTarget, 'tests/diagnostics/test_smoke_labels.py');
});

test('planner prompt makes resolved target precedence explicit and forbids evidence-driven relocation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-target-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const issue = path.join(dir, 'issue.json');
  fs.writeFileSync(issue, JSON.stringify({
    title: 'Add smoke labels',
    body: 'Create src/social_mcp/diagnostics/smoke_labels.py and tests/test_smoke_labels.py.',
  }));
  const task = plannerTask({ PI_ISSUE_CONTEXT: issue }, {
    layoutHint: {
      sourceRoot: 'src',
      sourceTarget: 'src/social_mcp/diagnostics/smoke_labels.py',
      sourceDirectory: 'src/social_mcp/diagnostics',
      sourceConvention: 'src/social_mcp/diagnostics/smoke_retry_after.py',
      testDirectory: 'tests/diagnostics',
      testTarget: 'tests/test_smoke_labels.py',
      testTargetRequired: true,
      testConvention: 'tests/diagnostics/test_smoke_retry_after.py',
    },
  });
  assert.match(task, /resolvedTargets=.*tests\/test_smoke_labels\.py/s);
  assert.match(task, /conventionHints=.*tests\/diagnostics/s);
  assert.match(task, /resolvedTargets > conventionHints > discovered repository context/);
  assert.match(task, /Do not validate, relocate, normalize, improve, or replace them/);
  assert.match(task, /Do not spend repository evidence actions solely to re-decide or verify/);
});

test('canonical validation rejects relocated resolved targets but allows convention disagreement as warning', () => {
  const resolvedTargets = { test: 'tests/test_smoke_labels.py' };
  const matching = validateImplementationPreparation({
    steps: ['Create tests/test_smoke_labels.py with smoke label coverage.'],
    facts: ['Sibling diagnostics tests live under tests/diagnostics/.'],
    warnings: ['Resolved test target differs from nearby repository convention tests/diagnostics/test_smoke_labels.py.'],
    complexity: 'nontrivial',
    required_mutation_anchors: [],
    large_mutation: false,
    reason: 'Add the requested regression coverage.',
  }, { resolvedTargets });
  assert.deepEqual(matching.warnings, [
    'Resolved test target differs from nearby repository convention tests/diagnostics/test_smoke_labels.py.',
  ]);

  assert.throws(
    () => validateImplementationPreparation({
      steps: ['Create tests/diagnostics/test_smoke_labels.py with smoke label coverage.'],
      facts: [],
      warnings: [],
      complexity: 'nontrivial',
      required_mutation_anchors: [],
      large_mutation: false,
      reason: 'Follow nearby tests.',
    }, { resolvedTargets }),
    /resolved_target_mismatch: test target must remain exactly "tests\/test_smoke_labels\.py"; returned conflicting path "tests\/diagnostics\/test_smoke_labels\.py"/,
  );

  assert.throws(
    () => validateImplementationPreparation({
      steps: ['Add smoke label regression coverage.'],
      facts: [],
      warnings: [],
      complexity: 'nontrivial',
      required_mutation_anchors: [],
      large_mutation: false,
      reason: 'Add the requested regression coverage.',
    }, { resolvedTargets }),
    /returned conflicting path "<missing>"/,
  );
});

test('runtime resolved-target mismatch is a recoverable structured-output correction', async (t) => {
  const previous = process.env[PLANNER_RESOLVED_TARGETS_ENV];
  process.env[PLANNER_RESOLVED_TARGETS_ENV] = JSON.stringify({ test: 'tests/test_smoke_labels.py' });
  t.after(() => {
    if (previous === undefined) delete process.env[PLANNER_RESOLVED_TARGETS_ENV];
    else process.env[PLANNER_RESOLVED_TARGETS_ENV] = previous;
  });

  const harness = extensionHarness(t);
  const wrong = {
    steps: ['Create tests/diagnostics/test_smoke_labels.py.'],
    facts: [],
    warnings: ['Nearby diagnostics tests use tests/diagnostics/.'],
    complexity: 'nontrivial',
    required_mutation_anchors: [],
    large_mutation: false,
    reason: 'Add smoke label tests.',
  };
  assert.equal(await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL, toolCallId: 'target-wrong', input: { value: wrong },
  }, harness.abortContext), undefined);
  const rejected = await harness.handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'target-wrong',
    input: { value: wrong },
    isError: false,
    content: [],
  }, harness.abortContext);
  assert.match(rejected.content[0].text, /resolved_target_mismatch/);
  assert.match(rejected.content[0].text, /tests\/test_smoke_labels\.py/);
  assert.match(rejected.content[0].text, /tests\/diagnostics\/test_smoke_labels\.py/);
  let state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.repairStatus, 'correction_required');
  assert.equal(state.repairKind, 'resolved_target_mismatch');
  assert.equal(state.structuredCorrections, 1);
  assert.equal(harness.aborted(), false);

  const corrected = {
    ...wrong,
    steps: ['Create tests/test_smoke_labels.py.'],
  };
  assert.equal(await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL, toolCallId: 'target-corrected', input: { value: corrected },
  }, harness.abortContext), undefined);
  await harness.handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'target-corrected',
    input: { value: corrected },
    isError: false,
    content: [],
  }, harness.abortContext);
  state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.repairStatus, 'accepted');
  assert.equal(state.structuredCorrections, 1);
  assert.deepEqual(state.acceptedResult, corrected);
  assert.equal(harness.aborted(), true);
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

test('pre-validation schema rejections release the result slot and a corrected result is accepted', async (t) => {
  const harness = extensionHarness(t);
  const acceptedValue = {
    steps: ['Update src/net.py'],
    facts: ['src/net.py contains send().'],
    complexity: 'nontrivial',
    required_mutation_anchors: ['src/net.py'],
    large_mutation: false,
    reason: 'Existing sender needs a bounded edit.',
  };
  const observePreValidationAttempt = async (id, args) => {
    await harness.handlers.get('message_end')({
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id, name: PLANNER_RESULT_TOOL, arguments: args }],
      },
    }, harness.abortContext);
    return harness.handlers.get('before_provider_request')({
      payload: {
        tools: [
          { type: 'function', function: { name: 'read' } },
          { type: 'function', function: { name: PLANNER_RESULT_TOOL } },
        ],
        tool_choice: 'auto',
      },
    }, harness.abortContext);
  };

  const firstRetry = await observePreValidationAttempt('missing-value', {});
  assert.equal(firstRetry.tool_choice, 'required');
  assert.deepEqual(firstRetry.tools.map(tool => tool.function.name), [PLANNER_RESULT_TOOL]);

  let state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.resultAttempts, 1);
  assert.equal(state.structuredCorrections, 1);
  assert.equal(state.repairStatus, 'correction_required');
  assert.equal(state.repairKind, 'pre_validation_rejection');
  assert.match(state.repairDiagnostic, /value is required/i);

  const blockedEvidence = await harness.handlers.get('tool_call')({
    toolName: 'read',
    toolCallId: 'e-after-finalizing',
    input: { path: 'src/a.py' },
  }, harness.abortContext);
  assert.equal(blockedEvidence.block, true);
  assert.match(blockedEvidence.reason, /repository evidence is closed/i);

  await observePreValidationAttempt('string-value', { value: 'not-an-object' });
  state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.resultAttempts, 2);
  assert.equal(state.structuredCorrections, 2);
  assert.equal(state.repairStatus, 'correction_required');
  assert.equal(state.repairKind, 'pre_validation_rejection');
  assert.match(state.repairDiagnostic, /value must be an object/i);

  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'corrected', name: PLANNER_RESULT_TOOL, arguments: { value: acceptedValue } }],
    },
  }, harness.abortContext);
  assert.equal(await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'corrected',
    input: { value: acceptedValue },
  }, harness.abortContext), undefined);
  await harness.handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'corrected',
    input: { value: acceptedValue },
    isError: false,
    content: [],
  }, harness.abortContext);

  state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.resultAttempts, 3);
  assert.equal(state.structuredCorrections, 2);
  assert.equal(state.repairStatus, 'accepted');
  assert.deepEqual(state.acceptedResult, acceptedValue);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_RESULT_DUPLICATE_BLOCKED ')).length, 0);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_RESULT_CORRECTION ')).length, 2);
});

test('three equivalent pre-validation rejections trip semantic no-progress protection', async (t) => {
  const harness = extensionHarness(t);
  const payload = {
    tools: [
      { type: 'function', function: { name: 'read' } },
      { type: 'function', function: { name: PLANNER_RESULT_TOOL } },
    ],
    tool_choice: 'auto',
  };

  for (let index = 1; index <= 3; index += 1) {
    await harness.handlers.get('message_end')({
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: `invalid-${index}`, name: PLANNER_RESULT_TOOL, arguments: {} }],
      },
    }, harness.abortContext);
    await harness.handlers.get('before_provider_request')({ payload }, harness.abortContext);
  }

  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.resultAttempts, 3);
  assert.equal(state.structuredCorrections, 3);
  assert.equal(state.repairStatus, 'failed');
  assert.equal(state.repairKind, 'pre_validation_rejection');
  assert.equal(state.failureKind, 'semantic_no_progress');
  assert.equal(harness.aborted(), true);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_RESULT_CORRECTION ')).length, 2);
  assert.ok(harness.logs().some(line => line.startsWith('PI_PLANNER_NO_PROGRESS ')));
});

test('reused pre-validation tool-call id does not bind a corrected runtime call to stale rejection', async (t) => {
  const harness = extensionHarness(t);
  const acceptedValue = {
    steps: ['Update src/net.py'],
    facts: ['src/net.py contains send().'],
    complexity: 'nontrivial',
    required_mutation_anchors: ['src/net.py'],
    large_mutation: false,
    reason: 'Existing sender needs a bounded edit.',
  };
  const payload = {
    tools: [{ type: 'function', function: { name: PLANNER_RESULT_TOOL } }],
    tool_choice: 'auto',
  };

  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'reused-id', name: PLANNER_RESULT_TOOL, arguments: {} }],
    },
  }, harness.abortContext);
  await harness.handlers.get('before_provider_request')({ payload }, harness.abortContext);

  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'reused-id', name: PLANNER_RESULT_TOOL, arguments: { value: acceptedValue } }],
    },
  }, harness.abortContext);
  assert.equal(await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'reused-id',
    input: { value: acceptedValue },
  }, harness.abortContext), undefined);
  await harness.handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'reused-id',
    input: { value: acceptedValue },
    isError: false,
    content: [],
  }, harness.abortContext);

  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.resultAttempts, 2);
  assert.equal(state.structuredCorrections, 1);
  assert.equal(state.repairStatus, 'accepted');
  assert.deepEqual(state.acceptedResult, acceptedValue);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_RESULT_DUPLICATE_BLOCKED ')).length, 0);
});

test('empty-id retry matches the fresh observation and is not double-counted as pre-validation rejection', async (t) => {
  const harness = extensionHarness(t);
  const payload = {
    tools: [{ type: 'function', function: { name: PLANNER_RESULT_TOOL } }],
    tool_choice: 'auto',
  };

  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', name: PLANNER_RESULT_TOOL, arguments: {} }],
    },
  }, harness.abortContext);
  await harness.handlers.get('before_provider_request')({ payload }, harness.abortContext);

  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', name: PLANNER_RESULT_TOOL, arguments: { value: {} } }],
    },
  }, harness.abortContext);
  assert.equal(await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    input: { value: {} },
  }, harness.abortContext), undefined);
  await harness.handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    input: { value: {} },
    isError: true,
    content: [{ type: 'text', text: 'Validation failed: value must have required property steps' }],
  }, harness.abortContext);

  let state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.resultAttempts, 2);
  assert.equal(state.structuredCorrections, 2);
  assert.equal(state.repairStatus, 'correction_required');
  assert.equal(state.repairKind, 'schema_rejection');

  await harness.handlers.get('before_provider_request')({ payload }, harness.abortContext);
  state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.resultAttempts, 2);
  assert.equal(state.structuredCorrections, 2);
  assert.equal(state.repairKind, 'schema_rejection');
});

test('true parallel structured_output calls still share one runtime pending slot', async (t) => {
  const harness = extensionHarness(t);
  assert.equal(await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'parallel-1',
    input: { value: {} },
  }, harness.abortContext), undefined);

  const duplicate = await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'parallel-2',
    input: { value: {} },
  }, harness.abortContext);
  assert.equal(duplicate.block, true);
  assert.match(duplicate.reason, /one structured_output call at a time/i);
  assert.ok(harness.logs().some(line => line.startsWith('PI_PLANNER_RESULT_DUPLICATE_BLOCKED ')));

  await harness.handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'parallel-1',
    input: { value: {} },
    isError: true,
    content: [{ type: 'text', text: 'Validation failed: value must have required property steps' }],
  }, harness.abortContext);

  assert.equal(await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'corrected-after-runtime-rejection',
    input: { value: {} },
  }, harness.abortContext), undefined);
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

test('accepted structured output uses direct handoff when accepted sidecar persistence fails', async (t) => {
  const harness = extensionHarness(t);
  const acceptedValue = {
    steps: ['Update src/net.py'],
    facts: ['src/net.py contains send().'],
    complexity: 'nontrivial',
    required_mutation_anchors: ['src/net.py'],
    large_mutation: false,
    reason: 'Existing sender needs a bounded edit.',
  };
  const originalWriteFileSync = fs.writeFileSync.bind(fs);
  const warnings = t.mock.method(console, 'warn', () => {});
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (file === harness.stateFile && String(data).includes('"repairStatus":"accepted"')) {
      throw new Error('simulated accepted sidecar write failure');
    }
    return originalWriteFileSync(file, data, options);
  });

  assert.equal(await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'r1',
    input: { value: acceptedValue },
  }, harness.abortContext), undefined);
  await harness.handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'r1',
    input: { value: acceptedValue },
    isError: false,
    content: [],
  }, harness.abortContext);

  assert.equal(harness.aborted(), false, 'failed accepted-result persistence must not abort direct structured handoff');
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.repairStatus, 'finalizing');
  assert.equal('acceptedResult' in state, false, 'failed persistence must not advertise sidecar recovery');
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_RESULT_SUCCESS ')).length, 1);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_CAT_PETTED ')).length, 1);
  assert.ok(warnings.mock.calls.some(call => String(call.arguments[0]).startsWith('PI_PLANNER_EVIDENCE_STATE_FAILED ')));

  const late = await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'late',
    input: { value: acceptedValue },
  }, harness.abortContext);
  assert.equal(late.block, true);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_RESULT_SUCCESS ')).length, 1);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_CAT_PETTED ')).length, 1);
});

test('accepted structured output without a sidecar does not abort direct handoff', async (t) => {
  const previousStateFile = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
  t.after(() => {
    if (previousStateFile === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
    else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previousStateFile;
  });

  const harness = extensionHarness(t, { stateFile: null });
  const acceptedValue = {
    steps: ['Update src/net.py'],
    facts: ['src/net.py contains send().'],
    complexity: 'nontrivial',
    required_mutation_anchors: ['src/net.py'],
    large_mutation: false,
    reason: 'Existing sender needs a bounded edit.',
  };

  assert.equal(await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'r1',
    input: { value: acceptedValue },
  }, harness.abortContext), undefined);
  await harness.handlers.get('tool_result')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'r1',
    input: { value: acceptedValue },
    isError: false,
    content: [],
  }, harness.abortContext);

  assert.equal(harness.aborted(), false, 'no sidecar means the accepted direct handoff must remain alive');
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_RESULT_SUCCESS ')).length, 1);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_CAT_PETTED ')).length, 1);

  const late = await harness.handlers.get('tool_call')({
    toolName: PLANNER_RESULT_TOOL,
    toolCallId: 'late',
    input: { value: acceptedValue },
  }, harness.abortContext);
  assert.equal(late.block, true);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_RESULT_SUCCESS ')).length, 1);
  assert.equal(harness.logs().filter(line => line.startsWith('PI_PLANNER_CAT_PETTED ')).length, 1);
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

test('parent consumes direct structured result when no accepted sidecar is persisted', async (t) => {
  const { dir, env } = fixture(t);
  t.mock.method(console, 'log', () => {});
  const acceptedResult = {
    steps: ['Update src/net.py'],
    facts: ['src/net.py contains send().'],
    warnings: ['Keep the runtime-resolved target even if a sibling convention differs.'],
    complexity: 'nontrivial',
    required_mutation_anchors: ['src/net.py'],
    large_mutation: false,
    reason: 'grounded',
  };
  const host = plannerHost({
    cwd: dir,
    async driveChild() {
      const evidenceStateFile = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
      assert.ok(evidenceStateFile);
      fs.writeFileSync(evidenceStateFile, JSON.stringify({
        used: 3,
        facts: ['fact-1'],
        structuredCorrections: 0,
        resultAttempts: 1,
        repairStatus: 'finalizing',
      }));
      return {
        status: 'completed',
        result: { kind: 'structured', value: acceptedResult },
        usage: { input: 500, output: 200, turns: 1, toolCalls: 4 },
      };
    },
  });

  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.plan, acceptedResult.steps);
  assert.deepEqual(prepared.repositoryFacts, acceptedResult.facts);
  assert.equal('plannerWarnings' in prepared, false);
  assert.equal('targetPolicy' in prepared, false);
  assert.deepEqual(prepared.requiredMutationAnchors, acceptedResult.required_mutation_anchors);
  assert.equal(prepared.plannerEvidenceActions, 3);
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


test('Planner Orbit seed target selection excludes dotted symbols and observability noise', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-targets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src/social_mcp/diagnostics'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/social_mcp/diagnostics/smoke_retry_after.py'), 'pass\n');

  const issue = {
    title: 'Fix `social_mcp.diagnostics.smoke_retry_after` in `src/social_mcp/diagnostics/smoke_retry_after.py`',
    body: 'Inspect `PI_PLANNER_ORBIT_SEED`, `currentHead`, `indexedHead`, `durationMs`, `planner_code_graph`, `types/counts`, and `input/output`.',
  };
  const targets = plannerOrbitSeedTargets(issue, { cwd: dir });
  assert.deepEqual(targets, ['src/social_mcp/diagnostics/smoke_retry_after.py']);
});

test('Planner Orbit seed prefers existing layout conventions and parent directories for additive work', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-layout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src/pkg'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests/pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/pkg/existing.py'), 'pass\n');
  fs.writeFileSync(path.join(dir, 'tests/pkg/test_existing.py'), 'pass\n');

  const layoutHint = {
    dottedTarget: 'pkg.new_module.NewThing',
    sourceConvention: 'src/pkg/existing.py',
    sourceDirectory: 'src/pkg',
    sourceTarget: 'src/pkg/new_module.py',
    testConvention: 'tests/pkg/test_existing.py',
    testDirectory: 'tests/pkg',
    testTarget: 'tests/pkg/test_new_module.py',
  };
  const targets = plannerOrbitSeedTargets(
    { title: 'Add `pkg.new_module.NewThing`', body: 'Create `src/pkg/new_module.py` and `tests/pkg/test_new_module.py`.' },
    { cwd: dir, layoutHint },
  );
  assert.deepEqual(targets, [
    'src/pkg/existing.py',
    'src/pkg',
    'tests/pkg/test_existing.py',
    'tests/pkg',
  ]);
  assert.ok(!targets.includes('src/pkg/new_module.py'));
  assert.ok(!targets.includes('tests/pkg/test_new_module.py'));
  assert.ok(!targets.includes('pkg.new_module.NewThing'));
});

test('current indexed worktree records requested, attempted, successful, and serialized Orbit targets distinctly', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-seed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/good.py'), 'pass\n');
  fs.writeFileSync(path.join(dir, 'src/bad.py'), 'pass\n');

  const contextTargets = [];
  const fakeExec = async (command, args) => {
    if (command === 'git') return { stdout: 'abc123\n' };
    if (args[0] === 'list') {
      return { stdout: JSON.stringify([{ repo_path: dir, commit_sha: 'abc123', status: 'indexed' }]) };
    }
    if (args[0] === 'context') {
      contextTargets.push(args[1]);
      if (args[1] === 'src/bad.py') {
        const error = new Error('orbit context failed');
        error.code = 1;
        error.stderr = 'Error: src/bad.py does not exist token=ghp_1234567890abcdefghijklmnop\nsecond noisy line';
        throw error;
      }
      return { stdout: 'caller alpha -> good' };
    }
    throw new Error('unexpected command');
  };

  const seed = await buildPlannerOrbitSeed(dir, {
    title: 'Update `src/good.py` and `social_mcp.diagnostics.smoke_retry_after`',
    body: 'Also inspect `src/bad.py`, `PI_PLANNER_ORBIT_SEED`, and `types/counts`.',
  }, { execFile: fakeExec, maxChars: 100000 });

  assert.equal(seed.present, true);
  assert.deepEqual(seed.requestedTargets, ['src/good.py', 'src/bad.py']);
  assert.deepEqual(seed.attemptedTargets, ['src/good.py', 'src/bad.py']);
  assert.equal(seed.attemptedTargetCount, 2);
  assert.deepEqual(seed.successfulTargets, ['src/good.py']);
  assert.deepEqual(seed.queriedTargets, ['src/good.py']);
  assert.deepEqual(seed.targets, ['src/good.py']);
  assert.deepEqual(contextTargets, ['src/good.py', 'src/bad.py']);
  assert.equal(seed.queryFailures, 1);
  assert.deepEqual(seed.failureCategoryCounts, { not_found: 1 });
  assert.equal(seed.failureDiagnostics.length, 1);
  assert.deepEqual(
    {
      target: seed.failureDiagnostics[0].target,
      category: seed.failureDiagnostics[0].category,
      exitCode: seed.failureDiagnostics[0].exitCode,
      timedOut: seed.failureDiagnostics[0].timedOut,
      budgetExhausted: seed.failureDiagnostics[0].budgetExhausted,
    },
    { target: 'src/bad.py', category: 'not_found', exitCode: 1, timedOut: false, budgetExhausted: false },
  );
  assert.ok(seed.failureDiagnostics[0].diagnostic.length <= 240);
  assert.doesNotMatch(seed.failureDiagnostics[0].diagnostic, /ghp_|1234567890abcdefghijklmnop/);
  assert.match(seed.text, /caller alpha/);
});

test('empty Orbit context is a bounded categorized failure while another valid target can seed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/empty.py'), 'pass\n');
  fs.writeFileSync(path.join(dir, 'src/good.py'), 'pass\n');

  const fakeExec = async (command, args) => {
    if (command === 'git') return { stdout: 'abc123\n' };
    if (args[0] === 'list') return { stdout: JSON.stringify([{ repo_path: dir, commit_sha: 'abc123', status: 'indexed' }]) };
    if (args[0] === 'context') return { stdout: args[1] === 'src/empty.py' ? '   ' : 'useful context' };
    throw new Error('unexpected command');
  };
  const seed = await buildPlannerOrbitSeed(
    dir,
    { title: 'Inspect `src/empty.py` and `src/good.py`', body: '' },
    { execFile: fakeExec },
  );
  assert.equal(seed.present, true);
  assert.deepEqual(seed.attemptedTargets, ['src/empty.py', 'src/good.py']);
  assert.deepEqual(seed.successfulTargets, ['src/good.py']);
  assert.deepEqual(seed.failureCategoryCounts, { empty_output: 1 });
  assert.equal(seed.failureDiagnostics[0].category, 'empty_output');
});

test('stale Orbit index is never injected and context is not queried', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/net.py'), 'pass\n');
  let contextCalls = 0;
  const fakeExec = async (command, args) => {
    if (command === 'git') return { stdout: 'abc123\n' };
    if (args[0] === 'list') return { stdout: JSON.stringify([{ repo_path: dir, commit_sha: 'old999', status: 'indexed' }]) };
    if (args[0] === 'context') { contextCalls += 1; return { stdout: 'must not happen' }; }
    throw new Error('unexpected command');
  };
  const seed = await buildPlannerOrbitSeed(dir, { title: 'Update `src/net.py`', body: '' }, { execFile: fakeExec });

  assert.equal(seed.present, false);
  assert.equal(seed.fresh, false);
  assert.equal(seed.currentHead, 'abc123');
  assert.equal(seed.indexedHead, 'old999');
  assert.equal(seed.reason, 'stale_index');
  assert.equal(contextCalls, 0);
  assert.deepEqual(seed.attemptedTargets, []);
});

test('missing Orbit degrades to absent seed without failing Planner preparation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/net.py'), 'pass\n');
  const fakeExec = async (command) => {
    if (command === 'git') return { stdout: 'abc123\n' };
    throw new Error('orbit not installed');
  };
  const seed = await buildPlannerOrbitSeed(dir, { title: 'Update `src/net.py`', body: '' }, { execFile: fakeExec });
  assert.equal(seed.present, false);
  assert.equal(seed.reason, 'orbit_unavailable');
  assert.equal(seed.serializedBytes, 0);
});

test('Orbit seed serialization is safety-bounded without limiting the number of valid graph queries', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-bound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const paths = Array.from({ length: 8 }, (_, index) => `src/target_${index}.py`);
  for (const target of paths) fs.writeFileSync(path.join(dir, target), 'pass\n');

  let contextCalls = 0;
  const fakeExec = async (command, args) => {
    if (command === 'git') return { stdout: 'abc123\n' };
    if (args[0] === 'list') return { stdout: JSON.stringify([{ repo_path: dir, commit_sha: 'abc123', status: 'indexed' }]) };
    if (args[0] === 'context') { contextCalls += 1; return { stdout: `context ${args[1]} ${'x'.repeat(100)}` }; }
    throw new Error('unexpected command');
  };
  const issue = { title: 'Seed graph', body: paths.map(target => `Inspect \`${target}\`.`).join(' ') };
  const seed = await buildPlannerOrbitSeed(dir, issue, { execFile: fakeExec, maxChars: 120 });

  assert.equal(seed.present, true);
  assert.equal(seed.truncated, true);
  assert.equal(contextCalls, paths.length);
  assert.deepEqual(seed.requestedTargets, paths);
  assert.deepEqual(seed.successfulTargets, paths);
  assert.deepEqual(seed.targets, [paths[0]], 'targets lists only context that reached the serialized seed');
  assert.match(seed.text, /Orbit seed truncated for safety/);
});

test('Planner Orbit seed has a total safety time budget without imposing a query-count cap', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const paths = Array.from({ length: 12 }, (_, index) => `src/target_${index}.py`);
  for (const target of paths) fs.writeFileSync(path.join(dir, target), 'pass\n');

  let clock = 0;
  let contextCalls = 0;
  const fakeExec = async (command, args, options) => {
    assert.ok(options.timeout > 0 && options.timeout <= 5000);
    if (command === 'git') { clock += 1; return { stdout: 'abc123\n' }; }
    if (args[0] === 'list') {
      clock += 1;
      return { stdout: JSON.stringify([{ repo_path: dir, commit_sha: 'abc123', status: 'indexed' }]) };
    }
    if (args[0] === 'context') {
      contextCalls += 1;
      clock += 10;
      return { stdout: `context for ${args[1]}` };
    }
    throw new Error('unexpected command');
  };
  const issue = { title: 'Seed graph', body: paths.map(target => `Inspect \`${target}\`.`).join(' ') };
  const seed = await buildPlannerOrbitSeed(dir, issue, {
    execFile: fakeExec,
    timeBudgetMs: 25,
    now: () => clock,
  });

  assert.equal(seed.present, false);
  assert.equal(seed.reason, 'seed_time_budget_exhausted');
  assert.ok(contextCalls > 0);
  assert.ok(contextCalls < seed.requestedTargets.length);
  assert.deepEqual(seed.attemptedTargets, seed.requestedTargets.slice(0, contextCalls));
  assert.deepEqual(seed.successfulTargets, seed.attemptedTargets);
  assert.deepEqual(seed.targets, [], 'a timed-out seed is discarded instead of becoming timing-dependent partial context');
});

test('Planner Orbit seed discards collected context when HEAD changes during collection', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-head-change-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/net.py'), 'pass\n');

  let gitCalls = 0;
  const fakeExec = async (command, args) => {
    if (command === 'git') {
      gitCalls += 1;
      return { stdout: gitCalls === 1 ? 'abc123\n' : 'def456\n' };
    }
    if (args[0] === 'list') {
      return { stdout: JSON.stringify([
        { repo_path: dir, commit_sha: 'abc123', status: 'indexed' },
        { repo_path: dir, commit_sha: 'def456', status: 'indexed' },
      ]) };
    }
    if (args[0] === 'context') return { stdout: 'context from original head' };
    throw new Error('unexpected command');
  };
  const seed = await buildPlannerOrbitSeed(dir, { title: 'Update `src/net.py`', body: '' }, { execFile: fakeExec });
  assert.equal(seed.present, false);
  assert.equal(seed.reason, 'head_or_index_changed');
  assert.deepEqual(seed.successfulTargets, ['src/net.py']);
  assert.deepEqual(seed.targets, []);
});

test('Orbit seed does not replace filesystem evidence or later planner_code_graph queries', async (t) => {
  for (const tool of ['read', 'grep', 'find', 'ls', 'repo_search', 'planner_code_graph']) {
    assert.ok(PLANNER_EVIDENCE_TOOLS.includes(tool), `${tool} remains available`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-followup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/net.py'), 'pass\n');
  let contextCalls = 0;
  const fakeExec = async (command, args) => {
    if (command === 'git') return { stdout: 'abc123\n' };
    if (args[0] === 'list') return { stdout: JSON.stringify([{ repo_path: dir, commit_sha: 'abc123', status: 'indexed' }]) };
    if (args[0] === 'context') {
      contextCalls += 1;
      return { stdout: args[1] === 'src/net.py' ? 'caller alpha -> send\n' : 'reference beta -> send\n' };
    }
    throw new Error('unexpected command');
  };

  const seed = await buildPlannerOrbitSeed(
    dir,
    { title: 'Update `src/net.py`', body: '' },
    { execFile: fakeExec, maxChars: 100000 },
  );
  assert.equal(seed.present, true);

  const graph = await plannerCodeGraph(
    dir,
    { target: 'send', question: 'Which references use send?' },
    { execFile: fakeExec },
  );
  assert.match(graph.text, /reference beta/);
  assert.equal(graph.head, 'abc123');
  assert.equal(contextCalls, 2, 'one seed query plus one later planner_code_graph query');
});

test('Planner Orbit seed propagates cancellation to subprocess execution', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-orbit-abort-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/net.py'), 'pass\n');
  const controller = new AbortController();
  let sawSignal = false;
  const fakeExec = async (command, args, options) => {
    sawSignal ||= options.signal === controller.signal;
    if (command === 'git') return { stdout: 'abc123\n' };
    if (args[0] === 'list') return { stdout: JSON.stringify([{ repo_path: dir, commit_sha: 'abc123', status: 'indexed' }]) };
    if (args[0] === 'context') {
      controller.abort(new Error('cancelled by parent'));
      throw controller.signal.reason;
    }
    throw new Error('unexpected command');
  };

  await assert.rejects(
    buildPlannerOrbitSeed(
      dir,
      { title: 'Update `src/net.py`', body: '' },
      { execFile: fakeExec, signal: controller.signal },
    ),
    /cancelled by parent/,
  );
  assert.equal(sawSignal, true);
});
