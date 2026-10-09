import assert from 'node:assert/strict';
import { test } from 'node:test';

import { register } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// CI installs TypeBox in the Pi runtime, not the repository Node test process.
// Reuse the existing contract suite's transport-only TypeBox shim.
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-665-typebox-'));
const shimLoader = path.join(shimDir, 'typebox-loader.mjs');
fs.writeFileSync(shimLoader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox') {
    const source = \`
      const optional = schema => ({ ...schema, __optional: true });
      export const Type = {
        String: (options = {}) => ({ type: 'string', ...options }),
        Boolean: (options = {}) => ({ type: 'boolean', ...options }),
        Array: (items, options = {}) => ({ type: 'array', items, ...options }),
        Optional: optional,
        Object: (properties, options = {}) => {
          const normalized = {};
          const required = [];
          for (const [name, schema] of Object.entries(properties)) {
            const { __optional, ...rest } = schema;
            normalized[name] = rest;
            if (!__optional) required.push(name);
          }
          return { type: 'object', properties: normalized, required, ...options };
        },
      };
    \`;
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);
register(pathToFileURL(shimLoader), import.meta.url);
process.on('exit', () => fs.rmSync(shimDir, { recursive: true, force: true }));

const {
  default: registerResultTool,
  CHANGED_WORK_SUBMISSION_SCHEMA,
  restrictResultSubmissionPayload,
  resultProviderBudgetEvidence,
  RESULT_SUBMISSION_TOKENS,
  RESULT_SUBMISSION_RETRY_TOKENS,
} = await import('../scripts/pi-implementer-result-tool.mjs');

const submitTool = () => ({
  type: 'function',
  function: {
    name: 'submit_result',
    description: 'full registered executor contract',
    parameters: { type: 'object', properties: { resultText: {}, already_satisfied: {} } },
  },
});
const payload = (tool = submitTool()) => ({
  stream: true, max_completion_tokens: 4096,
  tools: [tool], tool_choice: { type: 'function', function: { name: 'submit_result' } },
});

test('#665 changed-work wire matches Planner singleton auto contract for Chat Completions', () => {
  for (const stream of [true, false]) {
    const original = { ...payload(), stream };
    const out = restrictResultSubmissionPayload(original);
    assert.equal(out.stream, stream);
    assert.equal(out.tool_choice, 'auto');
    assert.deepEqual(out.tools.map(tool => tool.function.name), ['submit_result']);
    assert.deepEqual(out.tools[0].function.parameters, CHANGED_WORK_SUBMISSION_SCHEMA);
    assert.deepEqual(out.tools[0].function.parameters.required, ['resultText']);
    assert.deepEqual(Object.keys(out.tools[0].function.parameters.properties), ['resultText']);
    assert.equal(out.tools[0].function.parameters.additionalProperties, false);
    assert.equal(original.tools[0].function.parameters.properties.already_satisfied !== undefined, true,
      'provider restriction must not mutate the registered executor schema');
    assert.deepEqual(resultProviderBudgetEvidence(out, RESULT_SUBMISSION_TOKENS), {
      effective: 4096, verified: true, reason: 'verified',
    });
  }
});

test('#665 Responses and legacy Pi tool envelopes use the same auto strategy', () => {
  for (const tool of [
    { type: 'function', name: 'submit_result', parameters: {} },
    { function: { name: 'submit_result', parameters: {} } },
  ]) {
    const out = restrictResultSubmissionPayload({ ...payload(tool), tool_choice: 'required' });
    assert.equal(out.tool_choice, 'auto');
    assert.deepEqual(out.tools[0].parameters ?? out.tools[0].function.parameters,
      CHANGED_WORK_SUBMISSION_SCHEMA);
  }
});

test('#665 terminal provider envelope fails closed for unknown or conflicting tools and choices', () => {
  const invalid = [
    { ...payload(), tools: [] },
    { ...payload(), tools: [submitTool(), { type: 'function', function: { name: 'read' } }] },
    { ...payload(), tools: [submitTool(), submitTool()] },
    { ...payload(), tools: [{ type: 'function', function: { name: 'read' } }] },
    { ...payload(), tools: [{ type: 'custom', name: 'submit_result' }] },
    { ...payload(), tool_choice: { type: 'function', function: { name: 'read' } } },
    { ...payload(), toolChoice: 'auto' },
    { ...payload(), tool_choice: { type: 'invalid', name: 'submit_result' } },
  ];
  for (const testPayload of invalid) {
    const out = restrictResultSubmissionPayload(testPayload);
    assert.deepEqual(out.tools, []);
    assert.equal(out.tool_choice, 'none');
  }
  for (const value of [0, 2048, 8192, '4096']) {
    assert.equal(resultProviderBudgetEvidence({ max_completion_tokens: value }, 4096).verified, false);
  }
  assert.equal(resultProviderBudgetEvidence({
    max_completion_tokens: 4096, max_output_tokens: 8192,
  }, 4096).reason, 'conflicting_budgets');
});

function fakePi() {
  const events = new Map();
  const tools = new Map();
  const steers = [];
  const budgets = [];
  const activeTools = [];
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, cb) { events.set(name, [...(events.get(name) ?? []), cb]); },
    setModel: async model => { budgets.push(model.maxTokens); return true; },
    setActiveTools(names) { activeTools.push(names); },
    sendUserMessage: async (message, options) => { steers.push({ message, options }); },
    getActiveTools() { return activeTools.at(-1) ?? ['begin_result_submission', 'submit_result']; },
    appendEntry() {},
  };
  const ctx = { model: { maxTokens: 16384, contextWindow: 32768 },
    abort: () => { pi.aborted = true; } };
  const emit = async (name, event = {}) => {
    let result;
    for (const callback of events.get(name) ?? []) {
      const next = await callback(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  registerResultTool(pi);
  return { pi, tools, events, steers, budgets, activeTools, emit };
}

async function enterSubmission(h, stream = true) {
  const call = { toolName: 'begin_result_submission', toolCallId: 'begin-665', input: {} };
  assert.equal(await h.emit('tool_call', call), undefined);
  const result = await h.tools.get('begin_result_submission').execute();
  assert.match(result.content[0].text, /Coding closed/);
  await h.emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'begin-665', name: 'begin_result_submission', arguments: {} }] } });
  await h.emit('tool_execution_end', { ...call, isError: false });
  await h.emit('turn_end');
  assert.deepEqual(h.activeTools.at(-1), ['submit_result']);
  assert.equal(h.budgets.at(-1), 4096);
  assert.equal(h.steers.length, 1, 'handoff is on a new provider turn');
  const wire = await h.emit('before_provider_request', { payload: { ...payload(), stream } });
  assert.equal(wire.stream, stream);
  assert.equal(wire.tool_choice, 'auto');
  assert.deepEqual(wire.tools[0].function.parameters.required, ['resultText']);
  return wire;
}

const assistant = (reason, calls = [], providerError = false) => ({
  role: 'assistant', stopReason: reason, usage: { inputTokens: 1000 },
  ...(providerError ? { errorMessage: 'provider error' } : {}),
  content: calls.map((id, n) => ({ type: 'toolCall', id, name: n ? 'read' : 'submit_result',
    arguments: { resultText: 'complete Markdown' } })),
});
const emittedCall = { toolName: 'submit_result', toolCallId: 'done-665',
  input: { resultText: 'complete Markdown' } };

test('#665 real provider callback chain accepts executed Pi toolUse without extra prose', async () => {
  const h = fakePi();
  await enterSubmission(h);
  assert.equal(await h.emit('tool_call', emittedCall), undefined);
  await h.emit('message_end', { message: assistant('toolUse', ['done-665']) });
  await h.emit('tool_execution_end', { ...emittedCall, isError: false });
  await h.emit('turn_end');
  assert.equal(h.steers.length, 1, 'no additional request after successful tool execution');
  assert.equal(h.pi.aborted, undefined);
  assert.equal(h.budgets.at(-1), 16384, 'initial model budget restored');
});

test('#665 #662 valid-JSON tool_calls + stop without trusted execution fail closed in both modes', async () => {
  for (const stream of [true, false]) {
    const h = fakePi();
    await enterSubmission(h, stream);
    // #662 SSE tool_call deltas are parseable, but finish_reason=stop.
    // A bare tool call is never a successful toolUse/terminal execution.
    assert.equal(await h.emit('tool_call', emittedCall), undefined);
    await h.emit('message_end', { message: assistant('stop', ['done-665']) });
    await h.emit('tool_execution_end', { ...emittedCall, isError: true });
    await h.emit('turn_end');
    assert.equal(h.steers.length, 2);
    assert.match(h.steers.at(-1).message, /FORMAT CORRECTION/);
    await h.emit('before_provider_request', { payload: { ...payload(), stream } });
    assert.equal(await h.emit('tool_call', emittedCall), undefined);
    await h.emit('message_end', { message: assistant('stop', ['done-665']) });
    await h.emit('tool_execution_end', { ...emittedCall, isError: true });
    await h.emit('turn_end');
    assert.equal(h.pi.aborted, true, 'bounded correction exhausted; never accept raw SSE');
    assert.equal(h.steers.length, 2, 'no third model correction');
  }
});

test('#665 truncated stream retries once with verified 8192 budget', async () => {
  const h = fakePi();
  await enterSubmission(h);
  await h.emit('message_end', { message: assistant('length') });
  await h.emit('turn_end');
  assert.equal(h.budgets.at(-1), RESULT_SUBMISSION_RETRY_TOKENS);
  const wire = await h.emit('before_provider_request', {
    payload: { ...payload(), max_completion_tokens: 8192 },
  });
  assert.equal(wire.tool_choice, 'auto');
  assert.equal(resultProviderBudgetEvidence(wire, 8192).verified, true);
  await h.emit('message_end', { message: assistant('length') });
  await h.emit('turn_end');
  assert.equal(h.pi.aborted, true);
});

test('#665 unverified wire budget, provider error, or extra tools abort before correction', async () => {
  for (const [wire, error] of [
    [{ ...payload(), max_completion_tokens: 2048 }, false],
    [{ ...payload(), tools: [submitTool(), submitTool()] }, false],
    [payload(), true],
  ]) {
    const h = fakePi();
    await enterSubmission(h);
    await h.emit('before_provider_request', { payload: wire });
    await h.emit('message_end', { message: assistant('error', [], error) });
    await h.emit('turn_end');
    assert.equal(h.pi.aborted, true);
    assert.equal(h.steers.length, 1, 'failure cannot spin through correction');
  }
});

test('#665 empty, extra and wrongly typed submission arguments never admit execution', async () => {
  for (const input of [{}, { resultText: '' }, { resultText: 3 },
    { resultText: 'ok', already_satisfied: true }]) {
    const h = fakePi();
    await enterSubmission(h);
    const call = { ...emittedCall, input };
    await h.emit('tool_call', call);
    await h.emit('message_end', { message: assistant('toolUse', ['done-665']) });
    await h.emit('turn_end');
    assert.match(h.steers.at(-1).message, /FORMAT CORRECTION/);
  }
});
