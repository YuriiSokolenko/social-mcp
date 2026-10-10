import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCodingThinkingPolicy,
  disableThinkingInPayload,
  requireToolChoiceInPayload,
  withoutProviderTools,
  implementerToolChoiceDecision,
  retryableProviderErrorStatus,
  providerErrorStatus,
} from '../scripts/pi-common/provider-wire-policy.mjs';

const wireTool = name => ({ type: 'function', function: { name, parameters: { type: 'object' } } });

test('#741 thinking policy preserves unrelated wire fields and does not mutate requests', () => {
  const request = {
    messages: [{ role: 'user', content: 'go' }],
    tools: [wireTool('write')],
    tool_choice: 'required',
    chat_template_kwargs: { legacy: 1, enable_thinking: true },
  };
  const disabled = disableThinkingInPayload(request);
  assert.deepEqual(disabled, {
    ...request,
    chat_template_kwargs: { legacy: 1, enable_thinking: false },
  });
  assert.equal(request.chat_template_kwargs.enable_thinking, true);
  assert.notStrictEqual(disabled, request);
  assert.strictEqual(applyCodingThinkingPolicy(request, { enableThinking: 'true' }).chat_template_kwargs.enable_thinking, false);
  assert.strictEqual(applyCodingThinkingPolicy(request, { enableThinking: true }).chat_template_kwargs.enable_thinking, true);
  for (const invalid of [null, false, [], {}, { messages: null }]) {
    assert.strictEqual(applyCodingThinkingPolicy(invalid), invalid);
  }
});

test('#741 required choice only applies to a non-empty serialized tool array', () => {
  for (const request of [null, 0, [], {}, { tools: [] }, { tools: null }]) {
    assert.strictEqual(requireToolChoiceInPayload(request), request);
  }
  const request = { tools: [wireTool('submit_result')], tool_choice: 'auto', messages: [] };
  assert.deepEqual(requireToolChoiceInPayload(request), { ...request, tool_choice: 'required' });
  assert.equal(request.tool_choice, 'auto');
});

test('#741 zero-tool payload stripping is exact and preserves non-tool properties', () => {
  const request = { messages: [], model: 'm', tools: [], tool_choice: 'required', temperature: 0 };
  assert.deepEqual(withoutProviderTools(request), { messages: [], model: 'm', temperature: 0 });
  assert.deepEqual(request.tools, []);
  for (const invalid of [null, 1, 'x', []]) assert.strictEqual(withoutProviderTools(invalid), invalid);
});

test('#741 tool decision derives executability only from the wire surface', () => {
  const request = { tools: [wireTool('read'), wireTool('write')], tool_choice: 'auto', messages: [] };
  const action = implementerToolChoiceDecision(request, { productiveState: 'action_required' });
  assert.deepEqual(action, {
    payload: { ...request, tool_choice: 'required' },
    toolChoice: 'required', source: 'productive_action', exemption: null,
  });
  assert.equal(request.tool_choice, 'auto');
  assert.deepEqual(implementerToolChoiceDecision(request, { productiveState: 'evidence_allowed' }), {
    payload: request, toolChoice: 'auto', source: null, exemption: 'evidence_allowed',
  });
  const corrected = implementerToolChoiceDecision(request, { productiveState: 'evidence_allowed', correctionSource: 'trusted_correction' });
  assert.equal(corrected.toolChoice, 'required');
  assert.equal(corrected.source, 'trusted_correction');
  const compatible = implementerToolChoiceDecision(request, { productiveState: 'action_required', exemption: 'provider_422' });
  assert.equal(compatible.toolChoice, 'auto');
  assert.equal(compatible.exemption, 'provider_422');
  assert.strictEqual(compatible.payload.tools, request.tools);
});

test('#741 named constraints are honored only when target is serialized', () => {
  const named = { type: 'function', function: { name: 'write' } };
  const request = { tools: [wireTool('write')], tool_choice: named, messages: [] };
  assert.deepEqual(implementerToolChoiceDecision(request, { productiveState: 'action_required' }), {
    payload: request, toolChoice: named, source: 'named_tool', exemption: null,
  });
  const stale = implementerToolChoiceDecision({ ...request, tools: [wireTool('read')] }, { productiveState: 'action_required' });
  assert.deepEqual(stale.payload, { messages: [] });
  assert.equal(stale.exemption, 'named_tool_not_executable');
  const empty = implementerToolChoiceDecision({ tools: [], tool_choice: 'required' }, { productiveState: 'action_required' });
  assert.deepEqual(empty.payload, {});
  assert.equal(empty.exemption, 'zero_executable_tools');
  assert.equal(empty.toolChoice, null);
  const absent = { tool_choice: 'required', messages: [] };
  assert.deepEqual(implementerToolChoiceDecision(absent), {
    payload: absent, toolChoice: 'required', source: null, exemption: 'no_serialized_tool_surface',
  });
  assert.equal(implementerToolChoiceDecision({ tools: [{ type: 'function', function: { name: '' } }] }).exemption, 'zero_executable_tools');
});

test('#741 provider status parser accepts structured and known SDK formats only', () => {
  const error = detail => ({ stopReason: 'error', ...detail });
  for (const [message, status] of [
    [error({ status: 429 }), 429],
    [error({ error: { statusCode: '503' } }), 503],
    [error({ errorMessage: '400: {"error":"bad request"}' }), 400],
    [error({ errorMessage: '400 {"error":"bad request"}' }), 400],
    [error({ errorMessage: '400 status code (no body)' }), 400],
    [error({ errorMessage: 'BadRequestError: 422 tool_choice unsupported' }), 422],
    [error({ errorMessage: 'hp-laguna API error (500): upstream' }), 500],
    [error({ errorMessage: 'Maximum context: 400 tokens' }), null],
    [error({ errorMessage: 'fetch failed: 422 something' }), null],
    [error({ errorMessage: '500 tokens exceeded' }), null],
    [error({ errorMessage: '400abc' }), null],
    [{ stopReason: 'stop', errorMessage: '400: bad request' }, null],
  ]) assert.equal(providerErrorStatus(message), status, JSON.stringify(message));
});

test('#741 retry policy is unchanged for retryable transport statuses', () => {
  for (const status of [null, undefined, 408, 429, 500, 502, 599]) {
    assert.equal(retryableProviderErrorStatus(status), true);
  }
  for (const status of [0, 400, 401, 404, 422, 499]) {
    assert.equal(retryableProviderErrorStatus(status), false);
  }
});
