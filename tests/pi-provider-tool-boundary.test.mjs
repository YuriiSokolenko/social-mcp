import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  providerToolNames,
  reconcileProviderToolSurface,
  withProviderCapabilityInstructions,
} from '../scripts/pi-common/session-state.mjs';

const tool = name => ({
  type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } },
});
const toolNames = payload => providerToolNames(payload);

test('#634 provider boundary intersects serialized definitions with the phase-active tool surface', () => {
  const payload = { tools: [tool('read'), tool('run_check'), tool('bash'), tool('orphan'), tool('submit_result')] };
  const reconciled = reconcileProviderToolSurface(payload, {
    activeTools: ['read', 'run_check', 'orphan', 'submit_result'],
  });
  assert.deepEqual(toolNames(reconciled.payload), ['read', 'run_check', 'orphan', 'submit_result']);
  assert.equal(payload.tools.length, 5, 'the serialized payload and Pi transcript are not mutated');
  // A serialized definition is Pi's already-selected executor context. Do not
  // apply a second, narrower getAllTools() inventory in a delegated coding fork.
  assert.deepEqual(toolNames(reconcileProviderToolSurface(payload, {
    activeTools: ['read', 'run_check', 'bash', 'submit_result'],
  }).payload), ['read', 'run_check', 'bash', 'submit_result']);
  assert.deepEqual(toolNames(reconcileProviderToolSurface(
    { tools: [tool('read')] },
    { activeTools: ['read', 'run_check'] },
  ).payload), ['read'], 'runtime must not late-inject a newly active tool');
  assert.deepEqual(toolNames(reconcileProviderToolSurface(
    { tools: [tool('submit_result')] },
    { activeTools: ['submit_result'] },
  ).payload), ['submit_result'], 'recovery only retains a minimal safe surface');
});

test('#634 effective instructions use only the provider request, and label deferred tools explicitly', () => {
  const snapshot = {
    request: 7, executableTools: ['safe_edit', 'submit_result'], explainDeferred: true,
    deferredTools: ['read', 'run_check', 'retry_last_failed_check', 'bash'],
  };
  const history = [{ role: 'system', content: 'static contract says call run_check' },
    { role: 'user', content: '<role_contract source="agents/implementer/AGENTS.md">task handoff says call read</role_contract>' }];
  const payload = { messages: history, tools: [tool('safe_edit'), tool('submit_result')] };
  const outgoing = withProviderCapabilityInstructions(payload, snapshot, { trustedRuntimeEnvelope: true });
  assert.equal(outgoing.messages.length, history.length, 'request-local guidance must not introduce a role turn');
  assert.deepEqual(outgoing.messages.map(m => m.role), history.map(m => m.role));
  assert.deepEqual(history, payload.messages, 'request-local instructions do not pollute persisted history');
  assert.equal(outgoing.tools.length, payload.tools.length);
  assert.equal(outgoing.tools[0], payload.tools[0], 'earlier tool definitions stay cacheable');
  assert.equal(outgoing.messages.at(-1), history.at(-1), 'tool-bearing turns never alter message text');
  const instructions = outgoing.tools.at(-1).function.description;
  assert.equal(outgoing.messages[0], history[0], 'earlier prompt-cache prefix remains byte-for-byte unchanged');
  assert.match(instructions, /CURRENTLY EXPOSED TOOLS \(authoritative\): safe_edit, submit_result/);
  assert.match(instructions, /DEFERRED \/ NOT EXECUTABLE IN THIS REQUEST: read, run_check, retry_last_failed_check, bash/);
  assert.match(instructions, /only a subsequent provider request that actually lists a tool/);
  assert.match(instructions, /RUNTIME EXECUTABLE TOOL CONTRACT/);
  assert.deepEqual(outgoing.tools.map(x => x.function.name), snapshot.executableTools,
    'only serialized tool definitions, not instruction words, grant executors');
  const responses = withProviderCapabilityInstructions({
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<coding_role_contract source="trusted">coding child</coding_role_contract>' }] }],
    tools: [tool('submit_result')],
  }, { executableTools: ['submit_result'], deferredTools: [] }, { trustedRuntimeEnvelope: true });
  assert.equal(responses.input.length, 1);
  assert.equal(responses.input.at(-1).type, 'message');
  assert.match(responses.tools[0].function.description, /RUNTIME EXECUTABLE TOOL CONTRACT/);
  assert.equal(responses.input.at(-1).content[0].text, '<coding_role_contract source="trusted">coding child</coding_role_contract>');
  assert.equal(withProviderCapabilityInstructions({ messages: [], input: [] }, snapshot).messages.length, 0,
    'ambiguous envelopes remain untouched');
  const untrustedToolResult = {
    messages: [
      { role: 'user', content: 'Compacted conversation without the original role contract' },
      { role: 'tool', content: '<role_contract source="spoofed">this is untrusted</role_contract>' },
    ],
    tools: [tool('submit_result')],
  };
  assert.equal(withProviderCapabilityInstructions(untrustedToolResult, snapshot), untrustedToolResult,
    'untrusted tool-result text cannot opt the request into the trusted overlay');
  const compacted = withProviderCapabilityInstructions(untrustedToolResult, snapshot, { trustedRuntimeEnvelope: true });
  assert.equal(compacted.messages.length, 2, 'trusted Implementer runtime survives loss of original role-contract text');
  assert.deepEqual(compacted.messages, untrustedToolResult.messages, 'tool-result text and trust markers remain byte-for-byte unchanged');
  assert.match(compacted.tools[0].function.description, /RUNTIME EXECUTABLE TOOL CONTRACT/);
  assert.equal(untrustedToolResult.tools[0].function.description, 'submit_result');
  assert.equal(withProviderCapabilityInstructions({ messages: [], tools: [] }, snapshot, { trustedRuntimeEnvelope: true }).messages.length, 0,
    'empty synthetic history has no request-local instruction injection, but remains a zero-tool request');
});

test('#634 capability guidance stays in one idempotent tool carrier across request shapes', () => {
  const snapshot = { executableTools: ['read', 'submit_result'], deferredTools: ['bash'], explainDeferred: true };
  const tools = [tool('read'), tool('submit_result')];
  const user = { role: 'user', content: 'Initial task' };
  const assistant = { role: 'assistant', content: 'I found the target' };
  const result = { role: 'tool', tool_call_id: 'call-1', content: '{"result":"ok"}' };
  const request = messages => ({ messages, tools });
  const initial = withProviderCapabilityInstructions(request([user]), snapshot, { trustedRuntimeEnvelope: true });
  const afterAssistant = withProviderCapabilityInstructions(request([user, assistant]), snapshot, { trustedRuntimeEnvelope: true });
  const afterTool = withProviderCapabilityInstructions(request([user, assistant, result]), snapshot, { trustedRuntimeEnvelope: true });
  assert.equal(initial.tools[0], tools[0]);
  assert.deepEqual(initial.tools, afterAssistant.tools, 'carrier and schema bytes do not oscillate on assistant text');
  assert.deepEqual(initial.tools, afterTool.tools, 'tool result must not move guidance to a new carrier');
  assert.deepEqual(afterTool.messages.at(-1), result);
  assert.equal(afterTool.messages[0], user);
  const repeated = withProviderCapabilityInstructions(afterTool, snapshot, { trustedRuntimeEnvelope: true });
  assert.equal(repeated, afterTool, 'second provider hook pass is an identity-preserving no-op');
  assert.equal((repeated.tools.at(-1).function.description.match(/RUNTIME EXECUTABLE TOOL CONTRACT/g) ?? []).length, 1);
  const revised = withProviderCapabilityInstructions(repeated, {
    executableTools: ['read', 'submit_result'], deferredTools: ['grep'], explainDeferred: true,
  }, { trustedRuntimeEnvelope: true });
  assert.equal((revised.tools.at(-1).function.description.match(/RUNTIME EXECUTABLE TOOL CONTRACT/g) ?? []).length, 1,
    'a changed snapshot replaces the contract without duplicating it');
  assert.match(revised.tools.at(-1).function.description, /DEFERRED \/ NOT EXECUTABLE IN THIS REQUEST: grep/);
  assert.doesNotMatch(revised.tools.at(-1).function.description, /DEFERRED \/ NOT EXECUTABLE IN THIS REQUEST: bash/);
});

test('#634 no safe guidance carrier reports omission and zero-tool dispatch remains closed', () => {
  const omitted = [];
  const payload = { messages: [{ role: 'tool', tool_call_id: 'c1', content: 'raw output' }], tools: [] };
  const unchanged = withProviderCapabilityInstructions(payload, {
    executableTools: [], deferredTools: ['write'],
  }, { trustedRuntimeEnvelope: true, onMissingCarrier: reason => omitted.push(reason) });
  assert.equal(unchanged, payload);
  assert.deepEqual(omitted, ['no_safe_text_or_tool_carrier']);
});

test('#671 zero-tool guidance replaces its prior suffix without growing the prompt', () => {
  const original = {
    messages: [{ role: 'user', content: 'Existing trusted task context' }],
    tools: [],
  };
  const one = withProviderCapabilityInstructions(original, {
    executableTools: [], mode: 'coding', productiveState: 'action_required',
  }, { trustedRuntimeEnvelope: true });
  const two = withProviderCapabilityInstructions(one, {
    executableTools: [], mode: 'main', preparationState: 'PREPARATION_FALLBACK', productiveState: 'evidence_allowed',
  }, { trustedRuntimeEnvelope: true });
  assert.equal(one.messages.length, 1);
  assert.equal(two.messages.length, 1);
  assert.equal((two.messages[0].content.match(/RUNTIME EXECUTABLE TOOL CONTRACT/g) ?? []).length, 1);
  assert.match(two.messages[0].content, /Preparation fallback/);
  assert.doesNotMatch(two.messages[0].content, /Isolated coding session/);
  assert.deepEqual(two.tools, []);
  const three = withProviderCapabilityInstructions(two, {
    executableTools: [], mode: 'main', preparationState: 'PREPARATION_FALLBACK', productiveState: 'evidence_allowed',
  }, { trustedRuntimeEnvelope: true });
  assert.equal(three, two, 'idempotent hook passes must not grow request-local text');
  assert.equal(original.messages[0].content, 'Existing trusted task context', 'persisted history stays unchanged');
});

test('#634 strict chat-template role ordering survives a tool result and consecutive user steers', () => {
  const snapshot = { executableTools: ['safe_edit'], deferredTools: ['read', 'run_check'] };
  const assistantCall = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'safe_edit', arguments: '{}' } }],
  };
  const toolResult = { role: 'tool', tool_call_id: 'call-1', content: 'edit applied' };
  const history = [
    { role: 'system', content: 'stable system prefix' },
    { role: 'user', content: 'Issue and prepared plan' },
    assistantCall,
    toolResult,
  ];
  const payload = { messages: history, tools: [tool('safe_edit')] };
  const patched = withProviderCapabilityInstructions(payload, snapshot, { trustedRuntimeEnvelope: true });
  assert.deepEqual(patched.messages.map(m => m.role), history.map(m => m.role),
    'tool result must remain last; never inject a trailing user turn');
  assert.equal(patched.messages.length, history.length);
  assert.equal(patched.messages[0], history[0], 'unchanged cached prefix');
  assert.equal(patched.messages[2], assistantCall, 'assistant tool_calls are kept intact');
  assert.equal(patched.messages.at(-1).tool_call_id, 'call-1', 'tool linkage is preserved');
  assert.equal(patched.messages.at(-1), toolResult, 'tool output is never polluted with model instructions');
  assert.match(patched.tools[0].function.description, /RUNTIME EXECUTABLE TOOL CONTRACT/);
  assert.equal(payload.tools[0].function.description, 'safe_edit', 'original tool schema remains unchanged');
  assert.equal(history.at(-1).content, 'edit applied', 'the stored transcript must not be rewritten');
  // Non-action steers already use role=user; never append a second user turn.
  const steers = {
    messages: [
      ...history.slice(0, 2),
      { role: 'assistant', content: 'Need the next permitted action' },
      { role: 'user', content: 'RUNTIME UNAVAILABLE CAPABILITY CORRECTION: choose an exposed tool' },
    ],
    tools: payload.tools,
  };
  const corrected = withProviderCapabilityInstructions(steers, snapshot, { trustedRuntimeEnvelope: true });
  assert.equal(corrected.messages.length, steers.messages.length);
  assert.deepEqual(corrected.messages.map(m => m.role), steers.messages.map(m => m.role));
  assert.match(corrected.tools.at(-1).function.description, /RUNTIME EXECUTABLE TOOL CONTRACT/);
  assert.equal(steers.messages.at(-1).content, 'RUNTIME UNAVAILABLE CAPABILITY CORRECTION: choose an exposed tool');
});

test('#634 Responses function-call output retains call_id and no new message is added', () => {
  const payload = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Task' }] },
      { type: 'function_call', name: 'safe_edit', call_id: 'c9', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c9', output: 'Patch succeeded' },
    ],
    tools: [tool('safe_edit')],
  };
  const snapshot = { executableTools: ['safe_edit'], deferredTools: ['read'] };
  const outgoing = withProviderCapabilityInstructions(payload, snapshot, { trustedRuntimeEnvelope: true });
  assert.equal(outgoing.input.length, 3);
  assert.equal(outgoing.input[0], payload.input[0]);
  assert.equal(outgoing.input[1], payload.input[1]);
  assert.equal(outgoing.input[2].type, 'function_call_output');
  assert.equal(outgoing.input[2].call_id, 'c9');
  assert.equal(outgoing.input[2], payload.input[2], 'function-call output bytes are unchanged');
  assert.equal(outgoing.input[2].output, 'Patch succeeded');
  assert.match(outgoing.tools[0].function.description, /RUNTIME EXECUTABLE TOOL CONTRACT/);
  assert.equal(payload.tools[0].function.description, 'safe_edit');
  const opaqueAssistant = { role: 'assistant', content: null, tool_calls: [{ id: 'c9' }] };
  const noText = { messages: [opaqueAssistant], tools: payload.tools };
  const withDescription = withProviderCapabilityInstructions(noText, snapshot, { trustedRuntimeEnvelope: true });
  assert.equal(withDescription.messages[0], opaqueAssistant,
    'opaque assistant tool-call payloads are not restructured');
  assert.match(withDescription.tools[0].function.description, /RUNTIME EXECUTABLE TOOL CONTRACT/);
  const noTransport = { messages: [opaqueAssistant], tools: [] };
  assert.equal(withProviderCapabilityInstructions(noTransport, snapshot, { trustedRuntimeEnvelope: true }), noTransport,
    'without a safe text carrier or executable tool the payload is left untouched and fails closed');
});

test('#634 assistant text with pending tool_calls or legacy function_call is never modified', () => {
  const snapshot = { executableTools: ['safe_edit', 'submit_result'], deferredTools: ['read'] };
  const variants = [
    { role: 'assistant', content: 'I will now write the file', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'safe_edit', arguments: '{}' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'I will write' }], tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'safe_edit', arguments: '{}' } }] },
    { role: 'assistant', content: 'legacy call', function_call: { name: 'safe_edit', arguments: '{}' } },
  ];
  for (const linked of variants) {
    const original = JSON.stringify(linked);
    const firstTool = tool('safe_edit');
    const lastTool = tool('submit_result');
    const payload = { messages: [{ role: 'user', content: 'Implement task' }, linked], tools: [firstTool, lastTool] };
    const outgoing = withProviderCapabilityInstructions(payload, snapshot, { trustedRuntimeEnvelope: true });
    assert.equal(outgoing.messages.length, payload.messages.length);
    assert.equal(outgoing.messages.at(-1), linked, 'linked assistant message must not be rewritten');
    assert.equal(JSON.stringify(outgoing.messages.at(-1)), original);
    assert.equal(outgoing.tools[0], firstTool, 'earlier schema prefix must remain unchanged');
    assert.match(outgoing.tools[1].function.description, /RUNTIME EXECUTABLE TOOL CONTRACT/);
    assert.equal(lastTool.function.description, 'submit_result', 'the input provider tool schema is immutable');
  }
});

test('#634 Responses flat-format tools preserve shape and append guidance only to the last description', () => {
  const first = { type: 'function', name: 'read', description: 'Read a known file', parameters: { type: 'object', properties: {} } };
  const last = { type: 'function', name: 'submit_result', description: 'Finish task', parameters: { type: 'object', properties: {} } };
  const payload = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Task' }] },
      { type: 'function_call', name: 'read', call_id: 'flat-1', arguments: '{}' },
      { type: 'function_call_output', call_id: 'flat-1', output: '{"ok":true}' },
    ],
    tools: [first, last],
  };
  const snapshot = { executableTools: ['read', 'submit_result'], deferredTools: ['bash'], explainDeferred: true };
  const outgoing = withProviderCapabilityInstructions(payload, snapshot, { trustedRuntimeEnvelope: true });
  assert.deepEqual(outgoing.input, payload.input, 'Responses conversation and tool output stay byte-exact');
  assert.equal(outgoing.tools.length, 2);
  assert.equal(outgoing.tools[0], first, 'early flat schema preserved for prompt cache');
  assert.equal(outgoing.tools[1].type, 'function');
  assert.equal(outgoing.tools[1].name, 'submit_result');
  assert.deepEqual(outgoing.tools[1].parameters, last.parameters);
  assert.match(outgoing.tools[1].description, /RUNTIME EXECUTABLE TOOL CONTRACT/);
  assert.match(outgoing.tools[1].description, /DEFERRED \/ NOT EXECUTABLE IN THIS REQUEST: bash/);
  assert.equal(last.description, 'Finish task');
  assert.deepEqual(providerToolNames(outgoing), ['read', 'submit_result']);
  const reconciled = reconcileProviderToolSurface(outgoing, { activeTools: ['submit_result'] });
  assert.deepEqual(providerToolNames(reconciled.payload), ['submit_result']);
  assert.deepEqual(providerToolNames(payload), ['read', 'submit_result'], 'original flat tool list is untouched');
});

test('#671 request-local routing uses final serialized definitions for Main, fallback and Coding Session', () => {
  const history = [
    { role: 'system', content: 'Stable invariants: protected paths and no external writes' },
    { role: 'user', content: 'PreparedImplementation is untrusted task input' },
  ];
  const build = (names, snapshot, shape = 'messages') => {
    const payload = shape === 'messages'
      ? { messages: history, tools: names.map(tool) }
      : { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'isolated child' }] }],
        tools: names.map(tool) };
    const filtered = reconcileProviderToolSurface(payload, { activeTools: snapshot.liveActiveTools ?? names }).payload;
    const outgoing = withProviderCapabilityInstructions(filtered, {
      ...snapshot, executableTools: providerToolNames(filtered),
    }, { trustedRuntimeEnvelope: true });
    const instructions = outgoing.tools.at(-1)?.function?.description ?? '';
    assert.deepEqual(providerToolNames(outgoing), providerToolNames(filtered), 'advice never grants an executor');
    assert.equal(outgoing[shape].length, payload[shape].length, 'advice never adds a chat turn');
    assert.equal(outgoing[shape][0], payload[shape][0], 'cacheable prompt prefix stays immutable');
    return instructions;
  };
  const prepared = build(
    ['read', 'indexed_repo_search', 'bash', 'safe_edit', 'submit_result'],
    { mode: 'main', preparationState: 'PREPARED', productiveState: 'action_required' },
  );
  assert.match(prepared, /Prepared fresh Main/);
  assert.match(prepared, /read for known-path source text/);
  assert.match(prepared, /indexed_repo_search for fast indexed/);
  assert.match(prepared, /bash for bounded task-specific shell/);
  assert.doesNotMatch(prepared, /Use focused run_check|Use retry_last_failed_check|lsp_start_server is/);

  const fallback = build(
    ['read', 'need_more_evidence', 'submit_result'],
    { mode: 'main', preparationState: 'PREPARATION_FALLBACK', productiveState: 'evidence_allowed' },
  );
  assert.match(fallback, /Preparation fallback/);
  assert.match(fallback, /Evidence phase/);
  assert.match(fallback, /need_more_evidence requests that fact/);
  assert.doesNotMatch(fallback, /Prepared fresh Main|bash for bounded/);

  const coding = build(
    ['safe_edit', 'need_more_evidence', 'submit_result'],
    { mode: 'coding', productiveState: 'action_required', liveActiveTools: ['safe_edit', 'need_more_evidence', 'submit_result', 'bash', 'read'] },
    'input',
  );
  assert.match(coding, /Isolated coding session/);
  assert.match(coding, /Action-required phase/);
  assert.doesNotMatch(coding, /Direct inspection:|read for known-path|bash for bounded/);
  assert.doesNotMatch(coding, /DEFERRED \/ NOT EXECUTABLE/, 'deferred inventories are not dumped by default');
  assert.doesNotMatch(coding, /Prepared fresh Main/);

  const codingEvidence = build(
    ['read', 'safe_edit', 'submit_result'],
    { mode: 'coding', productiveState: 'evidence_allowed' },
  );
  assert.match(codingEvidence, /Evidence phase/);
  assert.match(codingEvidence, /read for known-path source text/);
});

test('#671 verification, exact retry, recovery and two-phase terminal routing never imply hidden tools', () => {
  const build = (names, snapshot) => {
    const payload = { messages: [{ role: 'user', content: 'stable invariant only' }], tools: names.map(tool) };
    const outgoing = withProviderCapabilityInstructions(payload, {
      ...snapshot, executableTools: names,
    }, { trustedRuntimeEnvelope: true });
    return outgoing.tools.at(-1)?.function.description ?? '';
  };
  const noPermit = build(['write', 'submit_result'], { mode: 'coding', productiveState: 'action_required', verificationState: 'not_yet_available' });
  assert.doesNotMatch(noPermit, /Use focused run_check|Use retry_last_failed_check/);
  const verify = build(['run_check', 'safe_edit', 'submit_result'], { mode: 'coding', productiveState: 'action_required', verificationState: 'available' });
  assert.match(verify, /Use focused run_check/);
  assert.doesNotMatch(verify, /Use retry_last_failed_check/);
  const retry = build(['retry_last_failed_check', 'safe_edit', 'submit_result'], { mode: 'main', productiveState: 'action_required', verificationState: 'available' });
  assert.match(retry, /Use retry_last_failed_check/);
  assert.doesNotMatch(retry, /Use focused run_check/);
  const recovery = build(['rollback_last_mutation', 'recover_worktree', 'submit_result'], { mode: 'coding', productiveState: 'action_required' });
  assert.match(recovery, /Recovery tools available: rollback_last_mutation, recover_worktree/);
  assert.doesNotMatch(recovery, /undo_mutation/);
  const begin = build(['begin_result_submission', 'submit_result'], { mode: 'coding', productiveState: 'action_required' });
  assert.match(begin, /Changed work: finish the necessary changes and focused checks, then call begin_result_submission/);
  const terminal = build(['submit_result'], { mode: 'coding', productiveState: 'action_required' });
  assert.match(terminal, /Terminal-only request: call submit_result/);
  assert.doesNotMatch(terminal, /begin_result_submission|Isolated coding session|Mutation tools available/);
  const restored = build(['submit_result', 'read', 'safe_edit'], { mode: 'main', resumed: true, productiveState: 'action_required' });
  assert.match(restored, /submit_result with no arguments immediately/);
  assert.doesNotMatch(restored, /Direct inspection:|Mutation tools available/);
  const repair = build(['submit_result'], { mode: 'coding', validationRepair: true });
  assert.match(repair, /submit_result with no arguments immediately/);
  const exactTerminal = build(['safe_edit'], { mode: 'main', terminalRecoveryRequiredTool: 'safe_edit' });
  assert.match(exactTerminal, /Terminal recovery: use safe_edit only/);
  assert.doesNotMatch(exactTerminal, /Mutation tools available/);
  const absentExact = build(['read'], { mode: 'main', terminalRecoveryRequiredTool: 'safe_edit' });
  assert.doesNotMatch(absentExact, /use safe_edit|Mutation tools available/);
});

test('#634 real Implementer boundary blocks late read/run_check/retry/bash even when host is newly active', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-surface-'));
  try {
    const issue = path.join(dir, 'issue.json');
    const loader = path.join(dir, 'loader.mjs');
    fs.writeFileSync(issue, JSON.stringify({ title: 'Surface regression', body: 'phase transition test' }));
    fs.writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'typebox') return {
        url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
        shortCircuit: true,
      };
      return nextResolve(specifier, context);
    }`);
    const script = `
      import assert from 'node:assert/strict';
      import { default as runtime } from ${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)};
      const handlers = new Map();
      const registered = new Set(['read', 'run_check', 'safe_edit', 'submit_result', 'retry_last_failed_check', 'bash']);
      let active = ['safe_edit', 'submit_result'];
      const pi = {
        events: { on: () => {}, emit: () => {} },
        registerTool: def => registered.add(def.name),
        on: (name, fn) => handlers.set(name, fn),
        getAllTools: () => [...registered].map(name => ({ name })),
        getActiveTools: () => [...active],
        setActiveTools: names => { active = [...names]; },
        setModel: async () => true,
        sendUserMessage: async () => {},
      };
      runtime(pi);
      handlers.get('turn_start')({ turnIndex: 0 });
      const payload = {
        model: 'test',
        messages: [
          { role: 'system', content: 'Main Pi system prompt' },
          { role: 'user', content: '<shared_agent_contract source="agents/AGENTS.md">shared</shared_agent_contract>\\n<role_contract source="agents/implementer/AGENTS.md">Task with stale instructions: read, run_check, bash</role_contract>' },
        ],
        tools: ['safe_edit', 'submit_result'].map(name => ({ type: 'function', function: { name } })),
      };
      const outbound = handlers.get('before_provider_request')({ payload });
      assert.deepEqual(outbound.tools.map(x => x.function.name), ['safe_edit', 'submit_result']);
      assert.match(outbound.tools.at(-1).function.description, /CURRENTLY EXPOSED TOOLS \\(authoritative\\): safe_edit, submit_result/);
      // Another phase/executor becomes active after the serialized request was built.
      // The model cannot call those tools in THIS response, even if getActiveTools now lists them.
      active = [...active, 'read', 'run_check', 'retry_last_failed_check', 'bash'];
      for (const name of ['read', 'run_check', 'retry_last_failed_check', 'bash']) {
        const blocked = await handlers.get('tool_call')(
          { toolName: name, toolCallId: 'late-' + name, input: {} },
          { cwd: ${JSON.stringify(dir)}, model: { maxTokens: 2048 }, abort: () => {} },
        );
        assert.equal(blocked?.block, true, name);
        assert.match(blocked.reason, /DEFERRED, not executable now/);
        assert.match(blocked.reason, /CURRENTLY EXPOSED TOOLS \\(authoritative\\): safe_edit, submit_result/);
      }
      // The runtime rechecks phase guards when constructing each NEW request:
      // it never auto-promotes run_check/retry/bash without a trusted check permit.
      const later = handlers.get('before_provider_request')({
        payload: { ...payload, tools: [...payload.tools, ...['run_check', 'retry_last_failed_check', 'bash'].map(name => ({ function: { name } }))] },
      });
      assert.deepEqual(later.tools.map(x => x.function.name), ['safe_edit', 'submit_result']);
      // A genuine request with an actual role envelope and ZERO tool definitions
      // must fail closed even when safe_edit is still live in the host.
      const emptyRequest = handlers.get('before_provider_request')({
        payload: { ...payload, tools: [] },
      });
      assert.deepEqual(emptyRequest.tools, []);
      const denied = await handlers.get('tool_call')(
        { toolName: 'safe_edit', toolCallId: 'real-zero-tools', input: { path: 'ignored.py' } },
        { cwd: ${JSON.stringify(dir)}, model: { maxTokens: 2048 }, abort: () => {} },
      );
      assert.equal(denied?.block, true, 'zero tools means zero dispatch privileges');
      assert.match(denied.reason, /DEFERRED, not executable now|not executable in this provider request/);
    `;
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_ISSUE_CONTEXT: issue, PI_RESUME_ACTIVE: 'true', PI_VALIDATION_REPAIR: 'false' },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /PI_CAPABILITY_LIFECYCLE_MISMATCH/);
    assert.match(result.stdout, /PI_PROVIDER_CAPABILITY_SNAPSHOT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
