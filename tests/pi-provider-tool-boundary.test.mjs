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

test('#634 provider boundary is the intersection of serialized definitions, active phase, and host executors', () => {
  const payload = { tools: [tool('read'), tool('run_check'), tool('bash'), tool('orphan'), tool('submit_result')] };
  const reconciled = reconcileProviderToolSurface(payload, {
    activeTools: ['read', 'run_check', 'orphan', 'submit_result'],
    registeredTools: ['read', 'run_check', 'submit_result', 'bash'],
  });
  assert.deepEqual(toolNames(reconciled.payload), ['read', 'run_check', 'submit_result']);
  assert.deepEqual(reconciled.unregistered, ['orphan']);
  assert.equal(payload.tools.length, 5, 'neither runtime registry nor Pi transcript is mutated');
  // A tool added to the active host surface AFTER the payload was captured is still absent.
  assert.deepEqual(toolNames(reconcileProviderToolSurface(payload, {
    activeTools: ['read', 'run_check', 'bash', 'submit_result'],
    registeredTools: ['read', 'run_check', 'bash', 'submit_result'],
  }).payload), ['read', 'run_check', 'bash', 'submit_result']);
  assert.deepEqual(toolNames(reconcileProviderToolSurface(
    { tools: [tool('read')] },
    { activeTools: ['read', 'run_check'], registeredTools: ['read', 'run_check'] },
  ).payload), ['read'], 'runtime must not late-inject a newly active tool');
  assert.deepEqual(toolNames(reconcileProviderToolSurface(
    { tools: [tool('submit_result')] },
    { activeTools: ['submit_result'], registeredTools: ['submit_result'] },
  ).payload), ['submit_result'], 'recovery only retains a minimal safe surface');
});

test('#634 effective instructions use only the provider request, and label deferred tools explicitly', () => {
  const snapshot = {
    request: 7, executableTools: ['safe_edit', 'submit_result'],
    deferredTools: ['read', 'run_check', 'retry_last_failed_check', 'bash'],
  };
  const history = [{ role: 'system', content: 'static contract says call run_check' },
    { role: 'user', content: '<role_contract source="agents/implementer/AGENTS.md">task handoff says call read</role_contract>' }];
  const payload = { messages: history, tools: [tool('safe_edit'), tool('submit_result')] };
  const outgoing = withProviderCapabilityInstructions(payload, snapshot);
  assert.equal(outgoing.messages.length, 3);
  assert.deepEqual(history, payload.messages, 'request-local instructions do not pollute persisted history');
  assert.equal(outgoing.tools, payload.tools);
  const instructions = outgoing.messages.at(-1).content;
  assert.match(instructions, /CURRENTLY EXPOSED TOOLS \(authoritative\): safe_edit, submit_result/);
  assert.match(instructions, /DEFERRED \/ NOT EXECUTABLE IN THIS REQUEST: read, run_check, retry_last_failed_check, bash/);
  assert.match(instructions, /only a subsequent provider request that actually lists a tool/);
  assert.doesNotMatch(instructions.split('Call only a tool from this list.')[0], /\bread\b/);
  const responses = withProviderCapabilityInstructions({
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<coding_role_contract source="trusted">coding child</coding_role_contract>' }] }],
    tools: [tool('submit_result')],
  }, { executableTools: ['submit_result'], deferredTools: [] });
  assert.equal(responses.input.at(-1).type, 'message');
  assert.match(responses.input.at(-1).content[0].text, /submit_result/);
  assert.equal(withProviderCapabilityInstructions({ messages: [], input: [] }, snapshot).messages.length, 0,
    'ambiguous envelopes remain untouched');
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
      assert.match(outbound.messages.at(-1).content, /CURRENTLY EXPOSED TOOLS \\(authoritative\\): safe_edit, submit_result/);
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
