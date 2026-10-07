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
  PLANNER_FINALIZATION_ONLY_ENV,
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
import { parsePlannerXml } from '../scripts/pi-common/planner-xml.mjs';

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

function validPlannerXml({
  step = 'Update src/net.py.',
  fact = 'src/net.py contains send().',
  warning = null,
  complexity = 'nontrivial',
  anchor = 'src/net.py',
  largeMutation = false,
  reason = 'Existing sender needs a bounded edit.',
} = {}) {
  const warnings = warning ? `\n  <warnings><warning>${warning}</warning></warnings>` : '';
  return `<plan complexity="${complexity}" large_mutation="${largeMutation ? 'true' : 'false'}">
  <steps><step>${step}</step></steps>
  <facts><fact>${fact}</fact></facts>${warnings}
  <required_mutation_anchors><anchor>${anchor}</anchor></required_mutation_anchors>
  <reason>${reason}</reason>
</plan>`;
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
  const agent = agentSource();
  assert.match(task, /plain XML document/i);
  assert.match(task, /Do not call a result tool or function/i);
  assert.match(task, /canonical valid XML example in your system finalization contract/i);
  assert.match(agent, /exactly one finalization-only correction turn/i);
  assert.match(agent, /Canonical valid XML example/);
  assert.match(agent, /<step>Update the target implementation\.<\/step>/);
  assert.match(agent, /<anchor>src\/example\.py<\/anchor>/);
  assert.match(agent, /Follow this exact element structure and closing-tag names/);
  assert.equal((agent.match(/<plan complexity=/g) ?? []).length, 1, 'system finalization contract owns one canonical XML example');
  assert.equal((task.match(/<plan complexity=/g) ?? []).length, 0, 'per-request task references rather than duplicates the canonical example');
  assert.doesNotMatch(task, /outer value|value wrapper|call structured_output/i);
  assert.doesNotMatch(agent, /outer `value`|value wrapper/i);
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
  assert.match(task, /optional <warnings>/);
});

test('canonical validation rejects relocated resolved targets and preserves warnings', () => {
  const resolvedTargets = { test: 'tests/test_smoke_labels.py' };
  const matching = validateImplementationPreparation({
    steps: ['Create tests/test_smoke_labels.py with smoke label coverage.'],
    facts: [],
    warnings: ['Nearest convention is tests/diagnostics/test_smoke_labels.py.'],
    complexity: 'nontrivial',
    required_mutation_anchors: [],
    large_mutation: false,
    reason: 'Add focused regression coverage.',
  }, { resolvedTargets });
  assert.equal(matching.warnings.length, 1);

  assert.throws(() => validateImplementationPreparation({
    steps: ['Create tests/diagnostics/test_smoke_labels.py.'],
    facts: [],
    warnings: [],
    complexity: 'nontrivial',
    required_mutation_anchors: [],
    large_mutation: false,
    reason: 'Follow nearby tests.',
  }, { resolvedTargets }), /resolved_target_mismatch/);
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
  assert.equal(
    harness.messages().length,
    1,
    'multiple useful evidence results in one provider turn coalesce to one queued progress steer',
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

test('multiple evidence facts queue one continuation before terminal XML finalization', async (t) => {
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

  assert.equal(harness.messages().length, 1, 'same-turn evidence must not build a steer backlog');
  await providerRequest();
  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: validPlannerXml() }],
    },
  }, harness.abortContext);

  assert.equal(providerRequests, 2, 'evidence requires only one continuation request before terminal XML');
  assert.equal(harness.messages().length, 1, 'terminal XML leaves no additional evidence steer queued');
  assert.deepEqual(harness.activeTools(), []);
  assert.ok(harness.logs().some(line => line.includes('PI_PLANNER_FINALIZATION_TRANSITION') && line.includes('"source":"assistant_content"')));
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
      content: [{ type: 'text', text: validPlannerXml() }],
    },
  }, harness.abortContext);
  await harness.handlers.get('tool_execution_end')({
    toolName: 'read',
    toolCallId: 'late-evidence',
    isError: false,
    result: { content: [{ type: 'text', text: 'late fact' }] },
  }, harness.abortContext);

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

test('completed assistant XML closes repository tools at message end and strips provider tool fields', async (t) => {
  const harness = extensionHarness(t);
  await harness.handlers.get('message_end')({
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: validPlannerXml() }],
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

test('finalization-only repair child closes tools only when the provider request is bound', async (t) => {
  const previous = process.env[PLANNER_FINALIZATION_ONLY_ENV];
  process.env[PLANNER_FINALIZATION_ONLY_ENV] = '1';
  t.after(() => {
    if (previous === undefined) delete process.env[PLANNER_FINALIZATION_ONLY_ENV];
    else process.env[PLANNER_FINALIZATION_ONLY_ENV] = previous;
  });

  const harness = extensionHarness(t);
  assert.deepEqual(harness.activeTools(), PLANNER_EVIDENCE_TOOLS, 'extension load must not call Pi session actions');
  const request = await harness.handlers.get('before_provider_request')({
    payload: {
      model: 'qwen',
      tools: PLANNER_EVIDENCE_TOOLS.map(name => ({ type: 'function', function: { name } })),
      tool_choice: 'auto',
    },
  }, harness.abortContext);
  assert.deepEqual(harness.activeTools(), []);
  assert.equal('tools' in request, false);
  assert.equal('tool_choice' in request, false);
  assert.equal(request.model, 'qwen');
  const blocked = await harness.handlers.get('tool_call')({
    toolName: 'read',
    toolCallId: 'repair-must-not-reopen',
    input: { path: 'src/net.py' },
  }, harness.abortContext);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /repository evidence is closed/i);
  assert.ok(harness.logs().some(line => line.includes('"source":"finalization_only_retry"')));
});

test('Planner XML maps all canonical fields and decodes XML text safely', () => {
  const parsed = parsePlannerXml(`<plan complexity="nontrivial" large_mutation="true">
  <steps><step>Update A &amp; B &lt;safely&gt;.</step><step>Add focused tests.</step></steps>
  <facts><fact>send() returns &quot;ok&quot; &amp; logs it.</fact></facts>
  <required_mutation_anchors><anchor>src/net.py</anchor><anchor>tests/net.test.mjs</anchor></required_mutation_anchors>
  <reason>Preserve caller&apos;s behavior.</reason>
</plan>`);
  assert.deepEqual(parsed, {
    steps: ['Update A & B <safely>.', 'Add focused tests.'],
    facts: ['send() returns "ok" & logs it.'],
    warnings: [],
    complexity: 'nontrivial',
    required_mutation_anchors: ['src/net.py', 'tests/net.test.mjs'],
    large_mutation: true,
    reason: "Preserve caller's behavior.",
  });
});

test('Planner XML accepts one surrounding xml fence and standard numeric entities', () => {
  const parsed = parsePlannerXml([
    '```xml',
    '<plan complexity="trivial" large_mutation="false">',
    '  <steps><step>Use List&lt;str&gt; and preserve A &#38; B.</step></steps>',
    '  <reason>Keep caller&#39;s behavior &#x26; tests.</reason>',
    '</plan>',
    '```',
  ].join('\n'));
  assert.deepEqual(parsed.steps, ['Use List<str> and preserve A & B.']);
  assert.equal(parsed.reason, "Keep caller's behavior & tests.");
});

test('Planner XML maps optional warnings without weakening resolved targets', () => {
  const parsed = parsePlannerXml(validPlannerXml({
    warning: 'Resolved test target differs from the nearest convention.',
  }));
  assert.deepEqual(parsed.warnings, ['Resolved test target differs from the nearest convention.']);
});

test('Planner XML normalizes omitted or self-closing optional facts and anchors to empty arrays', () => {
  for (const xml of [
    `<plan complexity="trivial" large_mutation="false">
  <steps><step>Update metadata.</step></steps>
  <reason>One static edit.</reason>
</plan>`,
    `<plan complexity='trivial' large_mutation='false'>
  <steps><step>Update metadata.</step></steps>
  <facts/>
  <required_mutation_anchors />
  <reason>One static edit.</reason>
</plan>`,
  ]) {
    const parsed = parsePlannerXml(xml);
    assert.deepEqual(parsed.facts, []);
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(parsed.required_mutation_anchors, []);
  }
});

test('Planner XML rejects malformed structure, invalid root values, and nested markup', () => {
  for (const xml of [
    '<plan complexity="trivial" large_mutation="false"><steps><step>x</step></steps>',
    '<plan complexity="medium" large_mutation="false"><steps><step>x</step></steps><reason>r</reason></plan>',
    '<plan complexity="trivial" large_mutation="yes"><steps><step>x</step></steps><reason>r</reason></plan>',
    '<plan complexity="trivial" large_mutation="false"><steps></steps><reason>r</reason></plan>',
    '<plan complexity="trivial" large_mutation="false"><steps><step><b>x</b></step></steps><reason>r</reason></plan>',
    '<plan complexity="trivial" large_mutation="false"><steps><step>A & B</step></steps><reason>r</reason></plan>',
    '<plan complexity="trivial" large_mutation="false"><steps><step>x</step></steps><reason>bad < text</reason></plan>',
    '<!DOCTYPE plan><plan complexity="trivial" large_mutation="false"><steps><step>x</step></steps><reason>r</reason></plan>',
  ]) {
    assert.throws(() => parsePlannerXml(xml), /Planner XML:/);
  }
});

test('valid first XML finalization prepares once with no repair request', async (t) => {
  const { dir, env } = fixture(t);
  t.mock.method(console, 'log', () => {});
  const host = plannerHost({
    cwd: dir,
    async driveChild(request) {
      assert.equal(request.result.kind, 'text');
      assert.equal('schema' in request.result, false);
      assert.doesNotMatch(JSON.stringify(request), /structured_output/);
      const evidenceStateFile = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
      fs.writeFileSync(evidenceStateFile, JSON.stringify({ used: 2, facts: ['f1'], toolCounts: { read: 2 } }));
      return {
        status: 'completed',
        result: { kind: 'text', text: validPlannerXml() },
        usage: { input: 500, output: 180, turns: 1, toolCalls: 2 },
      };
    },
  });

  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared');
  assert.equal(host.requests.length, 1);
  assert.equal(prepared.plannerFinalizationAttempts, 1);
  assert.equal(prepared.plannerXmlRepairNeeded, false);
  assert.deepEqual(prepared.plan, ['Update src/net.py.']);
  assert.deepEqual(prepared.repositoryFacts, ['src/net.py contains send().']);
  assert.deepEqual(prepared.requiredMutationAnchors, ['src/net.py']);
  assert.equal(prepared.plannerEvidenceActions, 2);
});

test('malformed XML gets exactly one explicit error-directed repair and preserves the canonical handoff', async (t) => {
  const { dir, env } = fixture(t);
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(String(line)));
  let call = 0;
  const host = plannerHost({
    cwd: dir,
    async driveChild(request) {
      call += 1;
      if (call === 1) {
        const evidenceStateFile = process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
        fs.writeFileSync(evidenceStateFile, JSON.stringify({
          used: 1,
          facts: ['read src/net.py: existing sender convention is grounded'],
          toolCounts: { read: 1 },
        }));
        return {
          status: 'completed',
          result: {
            kind: 'text',
            text: '<plan complexity="nontrivial" large_mutation="false"><steps><step>Update src/net.py.</step></steps><facts><fact>Existing sender convention is grounded.</f></facts><reason>Bounded edit.</reason></plan>',
          },
          usage: { input: 400, output: 80, turns: 1 },
        };
      }
      assert.match(request.task, /FINALIZATION-ONLY XML REPAIR — ONLY ATTEMPT/);
      assert.match(request.task, /previous final XML was rejected and was not accepted/i);
      assert.match(request.task, /Error class: xml_parse_or_shape/);
      assert.match(request.task, /Error: Planner XML: unclosed <fact>/);
      assert.match(request.task, /Repository investigation is finished and permanently closed/);
      assert.match(request.task, /canonical XML structure in your system finalization contract/);
      assert.match(request.task, /one complete corrected <plan> XML document now/);
      assert.match(request.task, /exact element structure and closing-tag names/);
      assert.match(request.task, /no prose, explanation, JSON, markdown fence, or tool call/i);
      assert.match(request.task, /only and final repair attempt/i);
      assert.match(request.task, /existing sender convention is grounded/);
      assert.match(request.task, /Issue title:/);
      assert.doesNotMatch(request.task, /cat is still waiting|finish the plan as soon|gather enough evidence/i);
      assert.equal(process.env[PLANNER_FINALIZATION_ONLY_ENV], '1');
      return {
        status: 'completed',
        result: { kind: 'text', text: validPlannerXml() },
        usage: { input: 180, output: 120, turns: 1 },
      };
    },
  });

  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared');
  assert.equal(call, 2);
  assert.equal(host.requests.length, 2);
  assert.equal(prepared.plannerFinalizationAttempts, 2);
  assert.equal(prepared.plannerXmlRepairNeeded, true);
  assert.equal(prepared.plannerProviderTurns, 2);
  assert.ok(logs.some(line =>
    line.startsWith('PI_PLANNER_XML_FINALIZATION_REJECTION ') &&
    line.includes('"attempt":1') &&
    line.includes('"errorClass":"xml_parse_or_shape"') &&
    line.includes('unclosed <fact>')
  ));
  assert.ok(logs.some(line =>
    line.startsWith('PI_PLANNER_XML_REPAIR_STARTED ') &&
    line.includes('"attempt":2') &&
    line.includes('"previousAttempt":1') &&
    line.includes('"errorClass":"xml_parse_or_shape"')
  ));
  assert.ok(logs.some(line => line.startsWith('PI_PLANNER_XML_FINALIZATION_SUCCESS ') && line.includes('"attempt":2')));
});

test('repair diagnostic and retained XML context redact unsafe credential and internal-path text', async (t) => {
  const { dir, env } = fixture(t);
  const secret = 'sk-super-secret-credential-value';
  const internalPath = '/home/runner/private/worktree/file.py';
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(String(line)));
  let call = 0;
  const host = plannerHost({
    cwd: dir,
    async driveChild(request) {
      call += 1;
      if (call === 1) {
        return {
          status: 'completed',
          result: {
            kind: 'text',
            text: `<plan complexity="${secret}" large_mutation="false"><steps><step>Update src/net.py.</step></steps><facts><fact>Observed ${internalPath}.</fact></facts><reason>Bounded edit.</reason></plan>`,
          },
          usage: { input: 120, output: 60, turns: 1 },
        };
      }
      assert.match(request.task, /Error class: xml_parse_or_shape/);
      assert.match(request.task, /\[redacted credential\]/);
      assert.match(request.task, /\[redacted path\]/);
      assert.doesNotMatch(request.task, /sk-super-secret|\/home\/runner\/private/);
      return {
        status: 'completed',
        result: { kind: 'text', text: validPlannerXml() },
        usage: { input: 100, output: 80, turns: 1 },
      };
    },
  });

  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared');
  assert.equal(call, 2);
  const rejectionLogs = logs.filter(line =>
    line.startsWith('PI_PLANNER_XML_FINALIZATION_REJECTION ') ||
    line.startsWith('PI_PLANNER_XML_REPAIR_STARTED ')
  ).join('\n');
  assert.match(rejectionLogs, /\[redacted credential\]/);
  assert.doesNotMatch(rejectionLogs, /sk-super-secret|\/home\/runner\/private/);
});

test('missing text payload still consumes attempt one and receives the single XML repair', async (t) => {
  const { dir, env } = fixture(t);
  t.mock.method(console, 'log', () => {});
  let call = 0;
  const host = plannerHost({
    cwd: dir,
    async driveChild(request) {
      call += 1;
      if (call === 1) {
        return {
          status: 'completed',
          result: { kind: 'text' },
          usage: { input: 120, output: 0, turns: 1 },
        };
      }
      assert.match(request.task, /\[no text XML payload returned\]/);
      return {
        status: 'completed',
        result: { kind: 'text', text: validPlannerXml() },
        usage: { input: 100, output: 80, turns: 1 },
      };
    },
  });

  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'prepared');
  assert.equal(call, 2);
  assert.equal(prepared.plannerFinalizationAttempts, 2);
  assert.equal(prepared.plannerXmlRepairNeeded, true);
});

test('missing fields and invalid root values each receive only one XML repair turn', async (t) => {
  const cases = [
    '<plan complexity="trivial" large_mutation="false"><reason>missing steps</reason></plan>',
    '<plan complexity="medium" large_mutation="false"><steps><step>x</step></steps><reason>bad complexity</reason></plan>',
    '<plan complexity="trivial" large_mutation="yes"><steps><step>x</step></steps><reason>bad bool</reason></plan>',
  ];
  for (const [index, firstXml] of cases.entries()) {
    const { dir, env } = fixture(t);
    let call = 0;
    const host = plannerHost({
      cwd: dir,
      async driveChild() {
        call += 1;
        return {
          status: 'completed',
          result: { kind: 'text', text: call === 1 ? firstXml : validPlannerXml() },
          usage: { input: 100 + index, output: 50, turns: 1 },
        };
      },
    });
    const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
    assert.equal(prepared.status, 'prepared');
    assert.equal(call, 2);
    assert.equal(prepared.plannerFinalizationAttempts, 2);
  }
});

test('invalid XML repair fails closed after two attempts and never asks for a third', async (t) => {
  const { dir, env } = fixture(t);
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(String(line)));
  let call = 0;
  const host = plannerHost({
    cwd: dir,
    async driveChild() {
      call += 1;
      return {
        status: 'completed',
        result: { kind: 'text', text: '<plan complexity="trivial" large_mutation="false"><steps>' },
        usage: { input: 100, output: 30, turns: 1 },
      };
    },
  });

  const prepared = await prepareImplementation(host.pi, host.ctx, stageConfig('implementer'), undefined, { env });
  assert.equal(prepared.status, 'fallback');
  assert.equal(prepared.failureClass, 'planner_xml_finalization_failed');
  assert.equal(prepared.plannerFinalizationAttempts, 2);
  assert.equal(prepared.plannerXmlRepairNeeded, true);
  assert.equal(call, 2);
  assert.equal(host.requests.length, 2);
  assert.ok(logs.some(line =>
    line.startsWith('PI_PLANNER_XML_FINALIZATION_FAILURE ') &&
    line.includes('"attempts":2') &&
    line.includes('"errorClass":"xml_parse_or_shape"')
  ));
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

test('planner observability uses XML finalization fields and has no cap telemetry', () => {
  const bootstrap = fs.readFileSync('scripts/pi-implementer-bootstrap.mjs', 'utf8');
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  const combined = `${bootstrap}\n${runtime}`;
  assert.match(combined, /plannerEvidenceActions/);
  assert.match(combined, /plannerFinalizationAttempts/);
  assert.match(combined, /plannerXmlRepairNeeded/);
  assert.doesNotMatch(combined, /plannerStructuredCorrections|structuredCorrections/);
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
