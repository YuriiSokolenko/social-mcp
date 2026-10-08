import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compactRuntimeActionSteers, ACTION_REQUIRED_STEER_LEAD } from '../scripts/pi-common/runtime-steering.mjs';

const directive = (tools, verification = 'not yet available') =>
  `${ACTION_REQUIRED_STEER_LEAD}CURRENTLY EXPOSED TOOLS (authoritative): ${tools}. Verification status: ${verification}.`;
const user = content => ({ role: 'user', content });
const count = payload => payload.messages.filter(message =>
  message.role === 'user' && typeof message.content === 'string' &&
  message.content.startsWith(ACTION_REQUIRED_STEER_LEAD)
).length;

test('#594 identical and changed runtime steers are replaced with one current provider directive', () => {
  const original = {
    model: 'test', tools: [{ function: { name: 'safe_edit' } }],
    messages: [
      { role: 'system', content: 'system contract' },
      user('Task and prepared plan'),
      user(directive('read')),
      { role: 'assistant', content: 'thinking' },
      user(directive('read')),
      user('Current task facts must remain available'),
      user(directive('old_mutation_tool', 'exhausted')),
    ],
  };
  const current = directive('safe_edit, submit_result', 'available');
  const { payload, removed, blocked } = compactRuntimeActionSteers(original, current);
  assert.equal(blocked, null);
  assert.equal(removed, 2);
  assert.equal(count(payload), 1);
  assert.equal(payload.messages.at(-1).content, current);
  assert.equal(payload.messages[0], original.messages[0]);
  assert.equal(payload.messages[1], original.messages[1]);
  assert.equal(payload.messages[3], original.messages[4]);
  assert.equal(original.messages.length, 7, 'original Pi session payload remains untouched');
  assert.equal(original.messages[2].content, directive('read'));
  assert.equal(payload.tools, original.tools);
});

test('#594 repeated outgoing requests and retries do not reintroduce historical action steering', () => {
  const storedHistory = [
    user('Original request'),
    user(directive('read')),
    { role: 'assistant', content: 'No tool was called' },
    user(directive('read')),
    { role: 'assistant', content: 'No tool was called again' },
    user(directive('write')),
  ];
  for (const current of [directive('write'), directive('safe_edit'), directive('submit_result')]) {
    const outgoing = compactRuntimeActionSteers({ messages: storedHistory }, current);
    assert.equal(count(outgoing.payload), 1);
    assert.equal(outgoing.payload.messages.at(-1).content, current);
    assert.equal(storedHistory.length, 6, 'provider rewrite must not mutate replay history');
  }
  assert.equal(compactRuntimeActionSteers({ messages: storedHistory }, null).payload.messages.length, 3,
    'after a state transition, even the newest previously active directive must expire');
});

test('#594 preserves all unrelated steers, normal user messages, and assistant/tool-call pairs', () => {
  const call = { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'safe_edit', arguments: '{}' } }] };
  const result = { role: 'tool', tool_call_id: 'call-1', content: 'edit applied' };
  const repair = user('RUNTIME REPAIR ACTION FALLBACK: must fix a validation error');
  const capability = user('RUNTIME UNAVAILABLE CAPABILITY CORRECTION: tool surface changed');
  const review = user('RUNTIME REVIEW ACTION REQUIRED: different directive class');
  const human = user('RUNTIME ACTION REQUIRED: this is a quoted user note, not a generated steer');
  const payload = { messages: [
    user('Task'), user(directive('read')),
    call, result,
    repair, capability, review, human,
    user(directive('safe_edit')),
  ] };
  const compacted = compactRuntimeActionSteers(payload, directive('submit_result')).payload;
  assert.equal(count(compacted), 1);
  assert.deepEqual(compacted.messages.filter(x => x.role === 'assistant' || x.role === 'tool'), [call, result]);
  assert.ok(compacted.messages.includes(repair));
  assert.ok(compacted.messages.includes(capability));
  assert.ok(compacted.messages.includes(review));
  assert.ok(compacted.messages.includes(human));
  assert.ok(compacted.messages.indexOf(result) === compacted.messages.indexOf(call) + 1);
});

test('#594 supports provider text parts, but leaves ambiguous multipart or tool-linked history alone', () => {
  const old = { role: 'user', content: [{ type: 'text', text: directive('old') }] };
  const unchanged = { role: 'user', content: [{ type: 'text', text: directive('old') }, { type: 'text', text: 'human' }] };
  const fresh = directive('new');
  const payload = { messages: [old, unchanged, user(directive('old'))] };
  const outgoing = compactRuntimeActionSteers(payload, fresh);
  assert.equal(outgoing.removed, 1);
  assert.equal(outgoing.payload.messages.length, 2);
  assert.equal(outgoing.payload.messages[0], unchanged);
  assert.equal(outgoing.payload.messages[1].content, fresh);
  assert.equal(compactRuntimeActionSteers({ messages: [old] }, fresh).payload.messages[0].content[0].text, fresh);
  const linked = { ...old, tool_call_id: 'tool-123' };
  const blocked = compactRuntimeActionSteers({ messages: [old, linked] }, fresh);
  assert.equal(blocked.blocked, 'tool_linked_steer');
  assert.equal(blocked.removed, 0);
  assert.equal(blocked.payload.messages[1], linked);
  assert.equal(compactRuntimeActionSteers({ input: [] }, fresh).removed, 0);
  assert.equal(compactRuntimeActionSteers({ messages: [old] }, 'bad').blocked, 'invalid_replacement');
});

test('#594 keeps a bounded outbound byte footprint instead of repeated 1.2KB steering blocks', () => {
  const long = directive('safe_edit, submit_result') + ' Additional action guidance.'.repeat(48);
  const history = Array.from({ length: 5 }, () => user(long));
  const baseline = Buffer.byteLength(JSON.stringify({ messages: history }));
  const current = compactRuntimeActionSteers({ messages: history }, long);
  const after = Buffer.byteLength(JSON.stringify(current.payload));
  assert.equal(current.removed, 4);
  assert.equal(count(current.payload), 1);
  assert.ok(baseline - after > 4000, `expected >4KB eliminated; saw ${baseline - after}`);
});

test('#594 actual Implementer provider hook drops historical steers without rewriting Pi session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-steering-'));
  try {
    const context = path.join(dir, 'issue.json');
    const loader = path.join(dir, 'loader.mjs');
    fs.writeFileSync(context, JSON.stringify({ title: 'Example task', body: 'Example' }));
    fs.writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'typebox') return {
        url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
        shortCircuit: true,
      };
      return nextResolve(specifier, context);
    }`);
    const script = `
      import assert from 'node:assert/strict';
      const { default: runtime } = await import(${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)});
      const handlers = new Map();
      let active = ['safe_edit', 'submit_result'];
      const pi = {
        events: { on: () => {}, emit: () => {} },
        registerTool: () => {},
        on: (name, fn) => handlers.set(name, fn),
        getActiveTools: () => [...active],
        setActiveTools: names => { active = names; },
        setModel: async () => true,
        sendUserMessage: async () => {},
      };
      runtime(pi);
      handlers.get('turn_start')({ turnIndex: 0 });
      const old = ${JSON.stringify(directive('read'))};
      const history = [
        { role: 'user', content: 'Original issue request' },
        { role: 'user', content: old },
        { role: 'assistant', content: 'No tool' },
        { role: 'user', content: old },
        { role: 'user', content: 'RUNTIME UNAVAILABLE CAPABILITY CORRECTION: current obligation' },
      ];
      const tools = ['safe_edit', 'submit_result'].map(name => ({
        type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } },
      }));
      const outgoing = handlers.get('before_provider_request')({ payload: { model: 'test', messages: history, tools } });
      const action = outgoing.messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('RUNTIME ACTION REQUIRED:'));
      assert.equal(action.length, 1);
      assert.match(action[0].content, /safe_edit/);
      assert.doesNotMatch(action[0].content, /CURRENTLY EXPOSED TOOLS \\(authoritative\\): read[.,]/);
      assert.equal(outgoing.messages.filter(m => m.content?.startsWith?.('RUNTIME UNAVAILABLE CAPABILITY')).length, 1);
      assert.equal(history.length, 5);
      assert.equal(history[1].content, old);

      // A provider retry starts again from Pi's unchanged history; compaction must
      // apply afresh rather than mutating the transcript only on the first request.
      const retry = handlers.get('before_provider_request')({ payload: { model: 'test', messages: history, tools } });
      assert.equal(retry.messages.filter(m => m.content?.startsWith?.('RUNTIME ACTION REQUIRED:')).length, 1);
    `;
    const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 20000,
      env: {
        ...process.env, PI_STAGE: 'implementer', PI_ISSUE_CONTEXT: context,
        PI_RESUME_ACTIVE: 'true', PI_VALIDATION_REPAIR: 'false',
      },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.match(child.stdout, /PI_RUNTIME_STEERING_COMPACTION/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
