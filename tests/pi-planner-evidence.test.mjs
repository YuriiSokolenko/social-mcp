import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

import plannerEvidenceExtension, { plannerCodeGraph, registerPlannerEvidenceTools } from '../scripts/pi-planner-evidence.mjs';
import {
  PLANNER_EVIDENCE_STATE_FILE_ENV,
  PLANNER_EVIDENCE_TOOLS,
  createPlannerEvidenceGate,
  plannerEvidenceFact,
  plannerTargetPolicy,
  plannerTask,
  prepareImplementation,
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
  let activeTools = [...PLANNER_EVIDENCE_TOOLS];
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

function validPlannerText({ step = 'Update src/net.py and add focused tests.', fact = 'src/net.py contains the sender implementation.' } = {}) {
  return `## Implementation plan

1. ${step}

Repository observation: ${fact}
Verification: run the focused sender tests.`;
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
});

test('planner prompt and agent contract require plain text without a model-visible schema', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-prompt-'));
  const issue = path.join(dir, '.issue.json');
  fs.writeFileSync(issue, JSON.stringify({ title: 'Plan it', body: 'Use social_mcp.diagnostics.<module>.' }));
  const task = plannerTask({ PI_ISSUE_CONTEXT: issue });
  const agent = agentSource();
  assert.match(task, /ordinary plain-text or Markdown assistant response/i);
  assert.match(task, /preserved verbatim.*opaque planText/i);
  assert.match(agent, /ordinary nonempty plain-text or Markdown assistant response/i);
  assert.match(agent, /no required JSON, XML, tool call, result schema, heading, field list, or Markdown template/i);
  assert.doesNotMatch(task, /<plan|XML REPAIR|structured_output|canonical valid XML/i);
  assert.doesNotMatch(agent, /<plan|XML finalization|Canonical valid XML|structured_output/i);
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

  const inferred = plannerTargetPolicy({
    dottedTarget: 'social_mcp.diagnostics.smoke_labels.parse_labels',
    sourceTarget: 'src/social_mcp/diagnostics/smoke_labels.py',
    testTarget: 'tests/diagnostics/test_smoke_labels.py',
    testTargetRequired: false,
    testDirectory: 'tests/diagnostics',
  });
  assert.deepEqual(inferred.resolvedTargets, {});
  assert.equal(inferred.conventionHints.sourceTarget, 'src/social_mcp/diagnostics/smoke_labels.py');
  assert.equal(inferred.conventionHints.testTarget, 'tests/diagnostics/test_smoke_labels.py');
});

test('planner prompt keeps resolved targets immutable and convention conflicts non-blocking', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-planner-target-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const issue = path.join(dir, 'issue.json');
  fs.writeFileSync(issue, JSON.stringify({ title: 'Target', body: 'Create tests/test_smoke_labels.py.' }));
  const task = plannerTask({ PI_ISSUE_CONTEXT: issue }, {
    layoutHint: {
      sourceRoot: 'src',
      sourceTarget: 'src/social_mcp/diagnostics/smoke_labels.py',
      sourceDirectory: 'src/social_mcp/diagnostics',
      sourceConvention: 'src/social_mcp/diagnostics/smoke_retry_after.py',
      testTarget: 'tests/test_smoke_labels.py',
      testTargetRequired: true,
      testDirectory: 'tests/diagnostics',
      testConvention: 'tests/diagnostics/test_smoke_retry_after.py',
    },
  });
  assert.match(task, /resolvedTargets=.*tests\/test_smoke_labels\.py/s);
  assert.match(task, /resolvedTargets > conventionHints > discovered repository context/);
  assert.match(task, /Do not validate, relocate, normalize, improve, or replace them/);
  assert.match(task, /state the disagreement in the plan text/i);
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
  const continuation = await harness.handlers.get('turn_end')({ entries: [] }, harness.abortContext);
  assert.equal(continuation.continue, true);
  assert.equal(
    continuation.entries.filter(entry => entry.type === 'custom_message' && entry.customType === 'planner-evidence-progress').length,
    1,
    'multiple useful evidence results in one provider turn coalesce to one lifecycle continuation',
  );
  assert.equal(harness.messages().length, 0, 'evidence progress no longer enters Pi\'s steer queue');
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
  const continuation = await harness.handlers.get('turn_end')({ entries: [] }, harness.abortContext);
  assert.equal(continuation.continue, true);
  assert.deepEqual(continuation.entries.at(-1), {
    type: 'custom_message',
    customType: 'planner-evidence-progress',
    content: '🐈 The cat is still waiting to be petted. Finish the plan as soon as you have enough evidence.',
    display: false,
  });
  assert.deepEqual(harness.messages(), []);
  assert.ok(harness.logs().some(line => line.includes('PI_PLANNER_EVIDENCE_CONTINUATION') && line.includes('"action":"delivered"')));
  assert.ok(!harness.logs().some(line => line.startsWith('PI_PLANNER_CAT_PETTED ')));
});

test('multiple evidence facts queue one continuation before terminal text finalization', async (t) => {
  const harness = extensionHarness(t);
  let providerRequests = 0;
  const providerRequest = async () => {
    providerRequests += 1;
    return harness.handlers.get('before_provider_request')({
      payload: {
        model: 'qwen',
        tools: PLANNER_EVIDENCE_TOOLS.map(name => ({ type: 'function', function: { name } })),
        tool_choice: 'auto',
      },
    }, harness.abortContext);
  };

  await providerRequest();
  for (let index = 0; index < 3; index += 1) {
    const toolCallId = `parallel-evidence-${index}`;
    await harness.handlers.get('tool_call')({
      toolName: 'read',
      toolCallId,
      input: { path: `src/evidence-${index}.py` },
    }, harness.abortContext);
    await harness.handlers.get('tool_execution_end')({
      toolName: 'read',
      toolCallId,
      isError: false,
      result: { content: [{ type: 'text', text: `fact ${index}` }] },
    }, harness.abortContext);
  }

  assert.equal(harness.messages().length, 0, 'same-turn evidence must not enter Pi\'s steer queue');
  const continuation = await harness.handlers.get('turn_end')({ entries: [] }, harness.abortContext);
  assert.equal(continuation.continue, true);
  assert.equal(
    continuation.entries.filter(entry => entry.type === 'custom_message' && entry.customType === 'planner-evidence-progress').length,
    1,
    'same-turn evidence coalesces to one lifecycle continuation',
  );
  if (continuation.continue) await providerRequest();

  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: validPlannerText() }],
    },
  }, harness.abortContext);
  const afterTerminal = await harness.handlers.get('turn_end')({ entries: [] }, harness.abortContext);
  if (afterTerminal?.continue) await providerRequest();

  assert.equal(providerRequests, 2, 'terminal text cannot schedule an additional provider request');
  assert.equal(afterTerminal, undefined);
  assert.deepEqual(harness.activeTools(), []);
  assert.ok(harness.logs().some(line => line.includes('PI_PLANNER_FINALIZATION_TRANSITION') && line.includes('"source":"assistant_content"')));
});

test('terminal assistant text explicitly cancels a pending evidence continuation before another provider request', async (t) => {
  const harness = extensionHarness(t);
  let providerRequests = 0;
  const providerRequest = async () => {
    providerRequests += 1;
    return harness.handlers.get('before_provider_request')({
      payload: {
        model: 'qwen',
        tools: PLANNER_EVIDENCE_TOOLS.map(name => ({ type: 'function', function: { name } })),
        tool_choice: 'auto',
      },
    }, harness.abortContext);
  };

  await providerRequest();
  await harness.handlers.get('tool_call')({
    toolName: 'read',
    toolCallId: 'pre-finalization-evidence',
    input: { path: 'src/pre-finalization.py' },
  }, harness.abortContext);
  await harness.handlers.get('tool_execution_end')({
    toolName: 'read',
    toolCallId: 'pre-finalization-evidence',
    isError: false,
    result: { content: [{ type: 'text', text: 'grounded fact' }] },
  }, harness.abortContext);

  assert.ok(harness.logs().some(line =>
    line.includes('PI_PLANNER_EVIDENCE_CONTINUATION') && line.includes('"action":"queued"')
  ));

  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: validPlannerText() }],
    },
  }, harness.abortContext);

  assert.ok(harness.logs().some(line =>
    line.includes('PI_PLANNER_EVIDENCE_CONTINUATION') &&
    line.includes('"action":"cancelled"') &&
    line.includes('"source":"assistant_content"')
  ));

  const afterTerminal = await harness.handlers.get('turn_end')({ entries: [] }, harness.abortContext);
  if (afterTerminal?.continue) await providerRequest();

  assert.equal(afterTerminal, undefined, 'the pre-finalization continuation is invalidated before turn_end');
  assert.equal(providerRequests, 1, 'terminal text does not trigger another provider request');
  assert.ok(!harness.logs().some(line =>
    line.includes('PI_PLANNER_EVIDENCE_CONTINUATION') && line.includes('"action":"delivered"')
  ));
  assert.deepEqual(harness.messages(), []);
  assert.deepEqual(harness.activeTools(), []);
});

test('evidence completion cannot queue a progress steer after finalization starts', async (t) => {
  const harness = extensionHarness(t);
  await harness.handlers.get('tool_call')({
    toolName: 'read',
    toolCallId: 'late-evidence',
    input: { path: 'src/late.py' },
  }, harness.abortContext);
  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: validPlannerText() }],
    },
  }, harness.abortContext);
  await harness.handlers.get('tool_execution_end')({
    toolName: 'read',
    toolCallId: 'late-evidence',
    isError: false,
    result: { content: [{ type: 'text', text: 'late fact' }] },
  }, harness.abortContext);

  const continuation = await harness.handlers.get('turn_end')({ entries: [] }, harness.abortContext);
  assert.equal(continuation, undefined);
  assert.equal(harness.messages().length, 0);
  assert.deepEqual(harness.activeTools(), []);
});

test('assistant narration followed by a tool call keeps repository tools open', async (t) => {
  const harness = extensionHarness(t);
  assert.equal(harness.handlers.has('message_update'), false, 'streaming text must not trigger finalization');

  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Let me inspect src/net.py first.' },
        { type: 'toolCall', id: 'inspect-net', name: 'read', arguments: { path: 'src/net.py' } },
      ],
    },
  }, harness.abortContext);

  assert.deepEqual(harness.activeTools(), PLANNER_EVIDENCE_TOOLS);
  assert.ok(!harness.logs().some(line => line.startsWith('PI_PLANNER_FINALIZATION_TRANSITION ')));

  const admitted = await harness.handlers.get('tool_call')({
    toolName: 'read',
    toolCallId: 'inspect-net',
    input: { path: 'src/net.py' },
  }, harness.abortContext);
  assert.equal(admitted, undefined);
});

test('completed assistant text closes repository tools at message end and strips provider tool fields', async (t) => {
  const harness = extensionHarness(t);
  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: validPlannerText() }],
    },
  }, harness.abortContext);

  assert.deepEqual(harness.activeTools(), []);
  assert.ok(harness.logs().some(line => line.includes('PI_PLANNER_FINALIZATION_TRANSITION') && line.includes('"source":"assistant_content"')));

  const blocked = await harness.handlers.get('tool_call')({
    toolName: 'read',
    toolCallId: 'after-finalization',
    input: { path: 'src/net.py' },
  }, harness.abortContext);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /repository evidence is closed/i);

  const request = await harness.handlers.get('before_provider_request')({
    payload: {
      model: 'qwen',
      tools: PLANNER_EVIDENCE_TOOLS.map(name => ({ type: 'function', function: { name } })),
      tool_choice: 'auto',
    },
  }, harness.abortContext);
  assert.equal('tools' in request, false);
  assert.equal('tool_choice' in request, false);
  assert.equal(request.model, 'qwen');
});

test('plain Planner final text is preserved verbatim with Markdown, Unicode, quotes, and angle brackets', async (t) => {
  const { dir, env } = plannerEnv(t);
  const planText = ['## Plan — naïve Ω', '', '- Update `social_mcp.diagnostics.<module>` without escaping it.', '- Preserve "quoted values", <tag-like-text>, ampersands & Markdown **bold**.', '- Run the focused diagnostics tests.'].join('\n');
  let calls = 0;
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(String(line)));
  const host = plannerHost({ cwd: dir, driveChild: async request => {
    calls += 1;
    assert.equal(request.result.kind, 'text');
    assert.equal('schema' in request.result, false);
    assert.doesNotMatch(request.task, /<plan|XML REPAIR|canonical XML/i);
    return { status: 'completed', finishReason: 'stop', usage: { turns: 1, input: 20, output: 80 }, result: { kind: 'text', text: planText } };
  }});
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(calls, 1);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.planText, planText);
  assert.equal(prepared.complexity, 'nontrivial');
  assert.deepEqual(prepared.requiredMutationAnchors, []);
  assert.equal(prepared.largeMutation, false);
  assert.ok(logs.some(line => line.startsWith('PI_PLANNER_FINAL_TEXT_ACCEPTED ')));
  assert.ok(logs.some(line => line.startsWith('PI_PLANNER_CAT_PETTED ')));
});

test('successful Planner handoff has no harness character or byte cap', async (t) => {
  const { dir, env } = plannerEnv(t);
  const planText = `# Plan\n${'x'.repeat(20000)}\nKeep \`social_mcp.diagnostics.<module>\` literal.`;
  const host = plannerHost({ cwd: dir, driveChild: async () => ({ status: 'completed', finishReason: 'stop', usage: { turns: 1, output: 1000 }, result: { kind: 'text', text: planText } }) });
  t.mock.method(console, 'log', () => {});
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.planText, planText);
  assert.ok(Buffer.byteLength(prepared.planText, 'utf8') > 12000);
});

test('empty Planner final text fails closed without a format-repair request', async (t) => {
  const { dir, env } = plannerEnv(t); let calls = 0;
  const host = plannerHost({ cwd: dir, driveChild: async () => { calls += 1; return { status: 'completed', finishReason: 'stop', usage: { turns: 1, output: 1 }, result: { kind: 'text', text: '   \n\t' } }; } });
  t.mock.method(console, 'log', () => {});
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(calls, 1); assert.equal(prepared.status, 'fallback'); assert.equal(prepared.failureClass, 'planner_empty_final');
});

test('explicit provider length termination is rejected as truncated with one Planner request', async (t) => {
  const { dir, env } = plannerEnv(t); let calls = 0;
  const host = plannerHost({ cwd: dir, driveChild: async () => { calls += 1; return { status: 'completed', finishReason: 'length', usage: { turns: 1, output: 2048 }, result: { kind: 'text', text: 'partial plan' } }; } });
  t.mock.method(console, 'log', () => {});
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(calls, 1); assert.equal(prepared.status, 'fallback'); assert.equal(prepared.failureClass, 'planner_truncated_final');
});

test('completed envelope at the token ceiling without a stop reason is conservatively rejected', async (t) => {
  const { dir, env } = plannerEnv(t);
  const host = plannerHost({ cwd: dir, driveChild: async () => ({ status: 'completed', usage: { turns: 1, output: 2048 }, result: { kind: 'text', text: 'possibly truncated plan' } }) });
  t.mock.method(console, 'log', () => {});
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'fallback'); assert.equal(prepared.failureClass, 'planner_truncated_final');
});

test('an explicit successful stop remains authoritative even when usage equals the transport ceiling', async (t) => {
  const { dir, env } = plannerEnv(t); const planText = 'Complete plan at the provider accounting boundary.';
  const host = plannerHost({ cwd: dir, driveChild: async () => ({ status: 'completed', stopReason: 'stop', usage: { turns: 1, output: 2048 }, result: { kind: 'text', text: planText } }) });
  t.mock.method(console, 'log', () => {});
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.planText, planText);
});

test('explicit non-success termination fails closed as an incomplete final', async (t) => {
  const { dir, env } = plannerEnv(t);
  const host = plannerHost({ cwd: dir, driveChild: async () => ({ status: 'completed', finish_reason: 'tool_calls', usage: { turns: 1, output: 20 }, result: { kind: 'text', text: 'not actually final' } }) });
  t.mock.method(console, 'log', () => {});
  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'fallback'); assert.equal(prepared.failureClass, 'planner_incomplete_final');
});

test('planner observability uses plain-text handoff fields and has no obsolete XML telemetry', () => {
  const bootstrap = fs.readFileSync('scripts/pi-implementer-bootstrap.mjs', 'utf8');
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  const planner = fs.readFileSync('scripts/pi-common/implementation-planner.mjs', 'utf8');
  const combined = `${bootstrap}\n${runtime}\n${planner}`;
  assert.match(combined, /plannerEvidenceActions/);
  assert.match(combined, /planTextBytes|planText/);
  assert.match(combined, /PI_PLANNER_FINAL_TEXT_ACCEPTED/);
  assert.doesNotMatch(combined, /plannerFinalizationAttempts|plannerXmlRepairNeeded|PI_PLANNER_XML_|planner_xml_finalization_failed/);
  assert.doesNotMatch(combined, /plannerEvidenceCap|evidenceCap:/);
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
