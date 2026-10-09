import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProviderReturnedTool } from '../scripts/pi-common/session-state.mjs';
import { providerToolContractEvidence } from '../scripts/pi-common/model-trace-proxy.mjs';

const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const payload = (names, choice = 'required') => ({ tools: names.map(tool), tool_choice: choice });
const message = calls => JSON.stringify({ choices: [{ index: 0, message: {
  tool_calls: calls.map((name, index) => ({ id: 'c' + index, index, type: 'function', function: { name, arguments: '{}' } })),
}, finish_reason: 'tool_calls' }] });
const snapshot = (names, deferredTools = []) => ({ executableTools: names, deferredTools });

test('#682 allowed read in an evidence-phase request is not a violation', () => {
  assert.equal(classifyProviderReturnedTool('read', snapshot(['read', 'submit_result'])), 'allowed');
  assert.deepEqual(providerToolContractEvidence(payload(['read']), message(['read'])).violations, []);
});
test('#682 replay #677: read absent from the exact 16-tool wire inventory', () => {
  const names = ['safe_edit', 'submit_result', ...Array.from({ length: 14 }, (_, i) => 'tool_' + i)];
  const observed = providerToolContractEvidence(payload(names), message(['read']));
  assert.deepEqual(observed.requestedToolNames, names);
  assert.deepEqual(observed.returnedToolNames, ['read']);
  assert.deepEqual(observed.violations, ['read']);
  assert.equal(observed.outcome, 'absent_name_in_provider_response');
  assert.equal(classifyProviderReturnedTool('read', snapshot(names, ['read'])), 'deferred');
});
test('#682 unknown and known-but-disabled names differ from tool runtime errors', () => {
  assert.equal(classifyProviderReturnedTool('made_up_tool', snapshot(['write'])), 'unknown');
  assert.equal(classifyProviderReturnedTool('read', snapshot(['write']), { knownTools: ['read'] }), 'known_disabled');
  assert.equal(classifyProviderReturnedTool('read', snapshot(['write']), { activeTools: ['read'] }), 'deferred');
  assert.equal(classifyProviderReturnedTool('write', null), 'missing_request_snapshot');
});
test('#682 multiple invalid names survive per-call reconstruction', () => {
  assert.deepEqual(providerToolContractEvidence(payload(['submit_result']), message(['read', 'ghost'])).violations, ['read', 'ghost']);
});
test('#682 SSE fragments reconstruct tool name without parsing prose', () => {
  const sse = [
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call-1', function: { name: 're', arguments: '{' } },
    ] } }] }),
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { name: 'ad', arguments: 'broken' } },
    ] }, finish_reason: 'tool_calls' }] }),
    'data: [DONE]', '',
  ].join('\n\n');
  assert.deepEqual(providerToolContractEvidence(payload(['write']), sse).violations, ['read']);
  assert.deepEqual(providerToolContractEvidence(payload(['read']), sse).violations, []);
});
test('#682 corrupted tool arguments are not confused with an absent tool name', () => {
  const response = JSON.stringify({ choices: [{ message: { tool_calls: [
    { index: 0, function: { name: 'write', arguments: '{malformed json' } },
  ] } }] });
  assert.deepEqual(providerToolContractEvidence(payload(['write']), response).violations, []);
});
test('#682 no serialized tools never grants arbitrary runtime executors', () => {
  assert.deepEqual(providerToolContractEvidence(payload([]), message(['read'])).violations, ['read']);
  assert.equal(classifyProviderReturnedTool('read', snapshot([]), { activeTools: ['read'] }), 'deferred');
});
test('#682 terminal one-tool requests cannot use retired read/write tools', () => {
  for (const terminal of ['submit_plan', 'submit_result']) {
    assert.deepEqual(providerToolContractEvidence(payload([terminal]), message([terminal])).violations, []);
    assert.deepEqual(providerToolContractEvidence(payload([terminal]), message(['read'])).violations, ['read']);
  }
});
test('#682 HTTP 400/422 without a tool response does not invent a name', () => {
  assert.deepEqual(providerToolContractEvidence(payload(['write'], 'required'), '{"error":{"message":"Bad request"}}').violations, []);
  assert.deepEqual(providerToolContractEvidence(payload(['write'], 'auto'), '').returnedToolNames, []);
  assert.deepEqual(providerToolContractEvidence(payload(['write'], {type:'function',function:{name:'write'}}), message(['write'])).tool_choice, {name:'write'});
});
