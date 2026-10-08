import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

import plannerEvidenceExtension, { plannerCodeGraph, registerPlannerEvidenceTools, plannerPlanAdmission, plannerProviderBudgetEvidence } from '../scripts/pi-planner-evidence.mjs';
import { rememberPlannerModelLimit } from '../scripts/pi-common/planner-request-budget.mjs';
import { acceptedPlannerSubmission, preparedImplementationBlock } from '../scripts/pi-common/implementation-planner.mjs';
import {
  PLANNER_EVIDENCE_STATE_FILE_ENV,
  PLANNER_LIFECYCLE_ID_ENV,
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
  const previousLifecycle = process.env[PLANNER_LIFECYCLE_ID_ENV];
  process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = file;
  process.env[PLANNER_LIFECYCLE_ID_ENV] = `planner-test-${path.basename(file)}`;
  t.after(() => {
    fs.rmSync(file, { force: true });
    if (previous === undefined) delete process.env[PLANNER_EVIDENCE_STATE_FILE_ENV];
    else process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] = previous;
    if (previousLifecycle === undefined) delete process.env[PLANNER_LIFECYCLE_ID_ENV];
    else process.env[PLANNER_LIFECYCLE_ID_ENV] = previousLifecycle;
  });
  return file;
}

function extensionHarness(t, { stateFile = stateFileFor(t), mockLog = true } = {}) {
  const handlers = new Map();
  let activeTools = [...PLANNER_EVIDENCE_TOOLS, 'begin_plan_submission'];
  const registeredTools = new Map();
  const model = { id: 'test-model', maxTokens: 2048, contextWindow: 32768 };
  const models = [];
  let aborted = false;
  const messages = [];
  const logs = mockLog ? t.mock.method(console, 'log', () => {}) : null;
  const pi = {
    registerTool: tool => registeredTools.set(tool.name, tool),
    setModel: async next => { Object.assign(model, next); models.push(next.maxTokens); return true; },
    on: (event, fn) => handlers.set(event, fn),
    getActiveTools: () => activeTools,
    setActiveTools: value => { activeTools = [...value]; },
    sendUserMessage: async (message, options) => { messages.push({ message, options }); },
  };
  plannerEvidenceExtension(pi);
  rememberPlannerModelLimit(pi, 32768);
  return {
    handlers,
    stateFile,
    registeredTools,
    model,
    models,
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
  assert.deepEqual(agentTools(), [...PLANNER_EVIDENCE_TOOLS, 'begin_plan_submission', 'submit_plan']);
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

test('effective planner prompts use tool completion and no obsolete plain-final instructions', (t) => {
  const { env } = fixture(t);
  const task = plannerTask(env);
  const agent = agentSource();
  for (const prompt of [task, agent]) {
    assert.match(prompt, /begin_plan_submission\(\)/);
    assert.match(prompt, /submit_plan/);
    assert.match(prompt, /4096/);
    assert.match(prompt, /8192/);
    assert.doesNotMatch(prompt, /return one ordinary plain-text|Do not call a result tool|Return only the final natural-language plan/);
  }
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
  assert.match(blocked.reason, /no progress/i);
  assert.equal(harness.aborted(), false, 'first stall is nudged rather than aborting without a transition chance');
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
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

  assert.equal(harness.aborted(), false);
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
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

// Production-equivalent event replay: real Planner extension handlers, actual tool contracts,
// request-phase model budgets and sidecar; provider outputs are fixed/sanitized fixtures.
async function plannerTurn(h, name, input = {}, {
  stopReason = 'toolUse', outputTokens = 100, inputTokens = 1000, extraCalls = [],
  providerPayload = null,
} = {}) {
  // The mock provider must exercise the real serialization boundary on EVERY turn.
  const actualRequest = providerPayload ?? { max_completion_tokens: h.model.maxTokens };
  h.handlers.get('before_provider_request')({ payload: {
    tools: [...PLANNER_EVIDENCE_TOOLS, 'begin_plan_submission', 'submit_plan']
      .map(tool => ({ type: 'function', function: { name: tool } })),
    ...actualRequest,
  } });
  const id = `${name}-${Math.random().toString(36).slice(2)}`;
  const content = [{ type: 'toolCall', name, id, arguments: input }, ...extraCalls];
  await h.handlers.get('message_end')({
    message: { role: 'assistant', stopReason, usage: { outputTokens, inputTokens }, content },
  });
  const ctx = { model: h.model, abort: () => {} };
  const verdict = await h.handlers.get('tool_call')({ toolName: name, toolCallId: id, input }, ctx);
  let toolResult = null;
  if (!verdict?.block) {
    const tool = h.registeredTools.get(name);
    if (tool) toolResult = await tool.execute(id, input, undefined, undefined, { cwd: '/tmp' });
    await h.handlers.get('tool_execution_end')({
      toolName: name, toolCallId: id, isError: false, result: { content: [{ type: 'text', text: 'acknowledged' }] },
    }, ctx);
  }
  const continuation = await h.handlers.get('turn_end')({ entries: [] }, ctx);
  return { verdict, continuation, toolResult };
}

function protocolState(h) { return JSON.parse(fs.readFileSync(h.stateFile, 'utf8')); }

test('begin is not completion; only a subsequent complete submit_plan accepts exact Markdown >2048 tokens', async t => {
  const h = extensionHarness(t);
  const plan = '# Sender repair\n' + 'Inspect src/net.py, verify invariants and write focused tests. Ω \\" <foo> &\n'.repeat(145);
  const research = h.handlers.get('before_provider_request')({ payload: {
    tools: [...PLANNER_EVIDENCE_TOOLS, 'begin_plan_submission', 'submit_plan'].map(name => ({ type: 'function', function: { name } })),
    max_tokens: 2048,
  } });
  assert.equal(research.tools.some(tool => tool.function.name === 'submit_plan'), false);
  const first = await plannerTurn(h, 'begin_plan_submission');
  assert.equal(first.verdict, undefined);
  assert.equal(first.continuation.continue, true);
  assert.equal(h.model.maxTokens, 4096);
  assert.equal(protocolState(h).phase, 'submission_pending');
  assert.throws(() => acceptedPlannerSubmission(protocolState(h), { result: { kind: 'text', text: 'ignored' } }), /never completed/);
  assert.deepEqual(h.activeTools(), ['submit_plan']);
  const second = h.handlers.get('before_provider_request')({ payload: {
    tools: [...PLANNER_EVIDENCE_TOOLS, 'submit_plan'].map(name => ({ type: 'function', function: { name } })),
    max_tokens: 4096,
  } });
  assert.deepEqual(second.tools.map(tool => tool.function.name), ['submit_plan']);
  const submission = await plannerTurn(h, 'submit_plan', { planText: plan }, { outputTokens: 3000 });
  assert.equal(submission.toolResult?.terminate, true, 'accepted tool hints clean agent-loop termination');
  const state = protocolState(h);
  assert.equal(state.phase, 'submitted');
  assert.equal(state.planText, plan);
  assert.equal(state.submissionBudget, 4096);
  assert.equal(state.submissionReceipt.lifecycleId, process.env[PLANNER_LIFECYCLE_ID_ENV]);
  assert.equal(state.submissionReceipt.executed, true);
  assert.equal(acceptedPlannerSubmission(state, { result: { kind: 'text', text: '' } }), plan);
  const block = preparedImplementationBlock({
    version: 1, status: 'prepared', baseRef: 'origin/dev', workspaceRoot: '/tmp', freshBaseCommit: 'abc',
    complexity: 'nontrivial', requiredMutationAnchors: [], largeMutation: false, reason: 'accepted', planText: plan,
  });
  assert.ok(block.includes('\\u003cfoo\\u003e'));
  const match = block.match(/<untrusted_planner_handoff_json>\s*(\{[^\n]+\})/);
  assert.equal(JSON.parse(match[1]).planText, plan);
});

test('accepted submit_plan stops the provider loop with a durable prepared handoff and correct usage', async t => {
  const { dir, env } = fixture(t, { 'src/net.py': 'def send(): pass\n' });
  const plan = validPlannerText() + '\nKeep exact punctuation: \\"Ω\\", <escape>, backslash \\\\ and newline.\n';
  let observedProviderRequests = null;
  let terminated = false;
  let acceptedState = null;
  const logs = [];
  const { pi, ctx, requests } = plannerHost({
    cwd: dir,
    driveChild: async () => {
      // A real provider-turn replay: each turn calls before_provider_request,
      // message_end, the registered tool, tool_execution_end and turn_end.
      // Pi's tool-batch contract stops the loop on a terminate:true result.
      const h = extensionHarness(t, { stateFile: process.env[PLANNER_EVIDENCE_STATE_FILE_ENV] });
      for (const turn of [
        { name: 'begin_plan_submission', input: {} },
        { name: 'submit_plan', input: { planText: plan } },
        { name: 'unused_post_submit_provider_turn', input: {} },
      ]) {
        const outcome = await plannerTurn(h, turn.name, turn.input);
        if (outcome.toolResult?.terminate) {
          terminated = true;
          break;
        }
      }
      observedProviderRequests = h.logs().filter(line => line.startsWith('PI_PLANNER_PROVIDER_REQUEST ')).length;
      acceptedState = protocolState(h);
      // Real Pi text adapter reports this as a failed child: the last assistant
      // message is terminal toolUse and there is no final prose to extract.
      return {
        status: 'failed',
        error: 'Subagent produced no output after terminal assistant stopReason "toolUse".',
        usage: { turns: observedProviderRequests, input: 1900, output: 850 },
      };
    },
  });
  t.mock.method(console, 'log', line => logs.push(String(line)));
  const result = await prepareImplementation(pi, ctx, stageConfig('implementer'), undefined, {
    env, orbitSeedBuilder: async () => ({ present: false }),
  });

  assert.equal(terminated, true);
  assert.equal(requests.length, 1, 'one delegated Planner lifecycle');
  assert.equal(observedProviderRequests, 2, 'research transition and successful submit only');
  assert.equal(acceptedState.budgetHistory.length, 2);
  assert.equal(acceptedState.budgetHistory.some(request => request.phase === 'submitted'), false);
  assert.equal(result.status, 'prepared');
  assert.equal(result.planText, plan);
  assert.equal(result.plannerProviderTurns, 2);
  assert.deepEqual(result.plannerUsage, { turns: 2, input: 1900, output: 850 });
  assert.equal(result.reason, 'Planner completed an explicit submit_plan handoff.');
  assert.equal(result.plannerEvidenceActions, 0);
  assert.equal(acceptedState.submissionReceipt.executed, true);
  assert.equal(acceptedState.submissionReceipt.lifecycleId.length > 0, true);
  assert.equal(logs.filter(line => line.startsWith('PI_PLANNER_TERMINAL_TOOLUSE_RECOVERED ')).length, 1);
  const block = preparedImplementationBlock(result);
  assert.doesNotMatch(block, /PREPARATION_FALLBACK/);
  const serialized = block.match(/<untrusted_planner_handoff_json>\s*(\{[^\n]+\})/);
  assert.equal(JSON.parse(serialized[1]).planText, plan);
});

test('terminal hint is denied to invalid, truncated, duplicate and budget-unverified submit attempts', async t => {
  for (const scenario of [
    { name: 'placeholder', input: { planText: '[INSERT PLAN HERE]' } },
    { name: 'truncated', input: { planText: 'Update src/net.py.' }, options: { stopReason: 'length' } },
    { name: 'duplicate', input: { planText: 'Update src/net.py.' },
      options: { extraCalls: [{ type: 'toolCall', name: 'submit_plan', id: 'duplicate', arguments: { planText: 'other' } }] } },
    { name: 'unverified', input: { planText: 'Update src/net.py.' }, options: { providerPayload: {} } },
    { name: 'provider_error', input: { planText: 'Update src/net.py.' }, options: { stopReason: 'error' } },
  ]) {
    const h = extensionHarness(t);
    await plannerTurn(h, 'begin_plan_submission');
    const outcome = await plannerTurn(h, 'submit_plan', scenario.input, scenario.options);
    assert.notEqual(outcome.toolResult?.terminate, true, scenario.name);
    assert.notEqual(protocolState(h).phase, 'submitted', scenario.name);
    assert.throws(() => acceptedPlannerSubmission(protocolState(h), {}), /never completed/, scenario.name);
  }
});

test('early final prose produces one deterministic nudge then classified fallback', async t => {
  const h = extensionHarness(t);
  const ctx = { model: h.model, abort: () => {} };
  for (let i = 0; i < 2; i++) {
    await h.handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: 'I will finish using plain prose.' }] } });
    const result = await h.handlers.get('turn_end')({ entries: [] }, ctx);
    assert.equal(Boolean(result?.continue), i === 0);
  }
  assert.equal(protocolState(h).phase, 'failed');
  assert.equal(protocolState(h).failureKind, 'planner_submission_not_started');
});

test('truncated begin cannot switch phase or consume submission budget', async t => {
  const h = extensionHarness(t);
  await plannerTurn(h, 'begin_plan_submission', {}, { stopReason: 'length', outputTokens: 2048 });
  assert.equal(protocolState(h).phase, 'researching');
  assert.deepEqual(h.models, []);
});

test('explicit length on parseable submit_plan requires one 8192-only retry', async t => {
  const h = extensionHarness(t);
  await plannerTurn(h, 'begin_plan_submission');
  const incomplete = await plannerTurn(h, 'submit_plan', { planText: 'Partial src/net.py' }, { stopReason: 'length', outputTokens: 4096 });
  assert.equal(incomplete.continuation.continue, true);
  assert.equal(h.model.maxTokens, 8192);
  assert.equal(protocolState(h).phase, 'submission_pending');
  const blocked = await h.handlers.get('tool_call')({ toolName: 'read', toolCallId: 'late', input: { path: 'src/net.py' } });
  assert.equal(blocked.block, true);
  await plannerTurn(h, 'submit_plan', { planText: 'Update src/net.py and verify focused tests.' }, { outputTokens: 6000 });
  assert.equal(protocolState(h).phase, 'submitted');
  assert.equal(protocolState(h).submissionBudget, 8192);
  assert.deepEqual(h.models, [4096, 8192]);
});

test('malformed or missing submission tool args are never accepted', async t => {
  const h = extensionHarness(t);
  await plannerTurn(h, 'begin_plan_submission');
  const bad = await plannerTurn(h, 'submit_plan', { planText: '[INSERT PLAN HERE]' });
  assert.equal(bad.verdict.block, true);
  assert.equal(protocolState(h).phase, 'failed');
  assert.equal(protocolState(h).failureKind, 'planner_submission_placeholder');
  assert.deepEqual(h.models, [4096], 'complete invalid plans must not consume transport recovery');
});

test('second attempt fails closed when model output capability or context is insufficient', async t => {
  const h = extensionHarness(t);
  await plannerTurn(h, 'begin_plan_submission');
  h.model.contextWindow = 10000;
  await plannerTurn(h, 'submit_plan', { planText: 'partial' }, { stopReason: 'length', inputTokens: 4000 });
  assert.equal(protocolState(h).phase, 'failed');
  assert.equal(protocolState(h).failureKind, 'planner_submission_context_exhausted');
});

test('admission is minimal: valid issue-specific code and orchestration blockers, no rigid schema', () => {
  assert.equal(plannerPlanAdmission('Change src/net.py, run tests.', ['read src/net.py: facts']).ok, true);
  assert.equal(plannerPlanAdmission('Cannot complete GitHub PR orchestration: required github tool not exposed.', [], { title: 'Audit PRs' }).ok, true);
  assert.equal(plannerPlanAdmission('Do changes.', ['read src/net.py: facts']).ok, false);
  assert.equal(plannerPlanAdmission('  ', []).ok, false);
  assert.equal(plannerPlanAdmission('[INSERT PLAN HERE]', []).ok, false);
  assert.equal(plannerPlanAdmission('Document TODO in src/net.py; verify tests', []).ok, true);
});

test('late verified target is accepted; generic blocked/cannot cannot bypass missing targets', () => {
  const facts = Array.from({ length: 20 }, (_, i) => 'read docs/module-' + i + '.md: verified');
  assert.equal(plannerPlanAdmission('Update docs/module-19.md and run focused checks.', facts).ok, true);
  assert.equal(plannerPlanAdmission('Cannot assume the server is blocked; update unrelated file.', facts).failureKind,
    'planner_submission_missing_verified_target');
  assert.equal(plannerPlanAdmission('Blocked by missing GitHub API permission to update the PR.', facts).ok, true);
  assert.equal(plannerPlanAdmission('Update package.json and run the tests.', [], { title: 'Update package.json' }).ok, true);
  assert.equal(plannerPlanAdmission('Update unrelated file.', [], { title: 'Update package.json' }).ok, false);
  assert.equal(plannerPlanAdmission('Run changes.', [], { title: 'Audit deployment orchestration' }).ok, false);
  assert.equal(plannerPlanAdmission('Cannot access GitHub PR API for deployment orchestration.', [], { title: 'Audit deployment orchestration' }).ok, true);
});

test('provider boundary recognizes real budget fields and never treats missing as verified', () => {
  for (const payload of [
    { max_completion_tokens: 4096 }, { max_output_tokens: 4096 }, { max_tokens: 4096 },
    { generationConfig: { maxOutputTokens: 4096 } },
    { generation_config: { max_output_tokens: 4096 } },
  ]) {
    assert.equal(plannerProviderBudgetEvidence(payload, 4096).verified, true);
  }
  assert.equal(plannerProviderBudgetEvidence({}, 4096).effective, null);
  assert.equal(plannerProviderBudgetEvidence({}, 4096).verified, false);
  assert.equal(plannerProviderBudgetEvidence({ max_tokens: 2048 }, 4096).verified, false);
  assert.equal(plannerProviderBudgetEvidence({ max_tokens: 4096, max_completion_tokens: 8192 }, 4096).verified, false);
  assert.equal(plannerProviderBudgetEvidence({ max_tokens: '4096' }, 4096).verified, false);
});

test('serialized provider budget mismatch/unverified fails closed without consuming retry', async t => {
  const h = extensionHarness(t);
  await plannerTurn(h, 'begin_plan_submission');
  await plannerTurn(h, 'submit_plan', { planText: 'Update src/net.py and verify.' },
    { providerPayload: {} });
  assert.equal(protocolState(h).phase, 'failed');
  assert.equal(protocolState(h).failureKind, 'planner_submission_budget_unavailable');
  assert.deepEqual(h.models, [4096]);
  const request = protocolState(h).budgetHistory.at(-1);
  assert.equal(request.effective, null);
  assert.equal(request.verified, false);
  assert.equal(request.reason, 'provider_budget_unverified');
});

test('an incomplete JSON-style tool argument is retryable once; complete bad plan is not', async t => {
  const h = extensionHarness(t);
  await plannerTurn(h, 'begin_plan_submission');
  await plannerTurn(h, 'submit_plan', {});
  assert.deepEqual(h.models, [4096, 8192]);
  await plannerTurn(h, 'submit_plan', { planText: '[INSERT PLAN HERE]' });
  assert.equal(protocolState(h).phase, 'failed');
  assert.equal(protocolState(h).failureKind, 'planner_submission_placeholder');
  assert.notEqual(protocolState(h).phase, 'submitted');
});

test('one malformed provider turn cannot complete a duplicate submit_plan', async t => {
  const h = extensionHarness(t);
  await plannerTurn(h, 'begin_plan_submission');
  const out = await plannerTurn(h, 'submit_plan', { planText: 'Update src/net.py and test.' }, {
    extraCalls: [{ type: 'toolCall', name: 'submit_plan', id: 'duplicate', arguments: { planText: 'Other' } }],
  });
  assert.equal(out.continuation, undefined);
  assert.equal(protocolState(h).phase, 'failed');
  assert.equal(protocolState(h).failureKind, 'planner_submission_invalid_transition');
  assert.deepEqual(h.models, [4096]);
});

test('provider request budget stays isolated between concurrent Planner extension instances', async t => {
  const a = extensionHarness(t);
  const b = extensionHarness(t);
  await plannerTurn(a, 'begin_plan_submission');
  assert.equal(a.model.maxTokens, 4096);
  assert.equal(b.model.maxTokens, 2048);
  await plannerTurn(a, 'submit_plan', { planText: 'Update src/a.py and test.' }, { stopReason: 'length' });
  assert.equal(a.model.maxTokens, 8192);
  assert.equal(b.model.maxTokens, 2048);
  const requestB = b.handlers.get('before_provider_request')({ payload: { max_tokens: 2048 } });
  assert.equal(requestB.max_tokens, 2048);
  assert.equal(protocolState(b).budgetHistory.at(-1).verified, true);
  assert.equal(protocolState(a).submissionBudget, 8192);
  assert.equal(process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, undefined);
});

test('sanitized #607-like 12-response replay can preserve >2048-token plan without re-research', async t => {
  const h = extensionHarness(t);
  for (let i = 0; i < 20; i++) {
    const id = `evidence-${i}`;
    await h.handlers.get('tool_call')({ toolName: 'read', toolCallId: id, input: { path: `src/module-${i}.py` } });
    await h.handlers.get('tool_execution_end')({ toolCallId: id, isError: false,
      result: { content: [{ type: 'text', text: `verified src/module-${i}.py target` }] } });
    if (i % 2 === 0) {
      await h.handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'toolUse',
        content: [{ type: 'toolCall', id, name: 'read' }] } });
      await h.handlers.get('turn_end')({ entries: [] }, { model: h.model });
    }
  }
  assert.equal(protocolState(h).used, 20);
  await plannerTurn(h, 'begin_plan_submission');
  const plan = 'Implement src/module-0.py and verify focused tests.\n' + 'Preserve verified constraints. '.repeat(550);
  await plannerTurn(h, 'submit_plan', { planText: plan }, { outputTokens: 3200 });
  assert.equal(protocolState(h).planText, plan);
  assert.equal(h.model.maxTokens, 4096);
  assert.equal(protocolState(h).used, 20);
  assert.equal(protocolState(h).budgetHistory.some(item => item.phase === 'submission_pending' && item.effective === 4096 && item.verified), true,
    'the fixture checks the actual dedicated provider-request payload');
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
