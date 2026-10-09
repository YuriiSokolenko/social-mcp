import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Real Implementer hooks, but fully synthetic provider responses: no network or mutations.
test('#682 out-of-request read is blocked, corrected once and then fails durably', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-name-recovery-'));
  try {
    const loader = path.join(dir, 'loader.mjs');
    fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify({ title: 'Tool name boundary', body: 'Synthetic regression' }));
    fs.writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'typebox') return {
        url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
        shortCircuit: true,
      };
      return nextResolve(specifier, context);
    }`);
    const fixture = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { default as runtime } from ${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)};
      const hooks = new Map();
      const messages = [];
      let aborted = 0;
      let active = ['safe_edit', 'submit_result'];
      const pi = {
        events: { on: () => {}, emit: () => {} },
        registerTool: () => {},
        on: (name, fn) => hooks.set(name, fn),
        getActiveTools: () => [...active],
        setActiveTools: names => { active = [...names]; },
        setModel: async () => true,
        sendUserMessage: async (text, options) => { messages.push({ text, options }); },
      };
      const ctx = { cwd: ${JSON.stringify(dir)}, model: { maxTokens: 2048 }, abort: () => { aborted++; } };
      const payload = () => ({
        model: 'test',
        messages: [
          { role: 'system', content: 'Test Implementer' },
          { role: 'user', content: '<shared_agent_contract source="agents/AGENTS.md">shared</shared_agent_contract>\\n<role_contract source="agents/implementer/AGENTS.md">task</role_contract>' },
        ],
        tools: ['safe_edit', 'submit_result'].map(name => ({ type: 'function', function: { name } })),
      });
      const response = id => ({ message: {
        stopReason: 'toolUse', content: [], toolCalls: [{ id, name: 'read', arguments: { path: 'x' } }],
      } });
      runtime(pi);
      hooks.get('turn_start')({ turnIndex: 0 });
      const outbound = hooks.get('before_provider_request')({ payload: payload() }, ctx);
      assert.deepEqual(outbound.tools.map(t => t.function.name), ['safe_edit', 'submit_result']);
      const first = await hooks.get('tool_call')({ toolName: 'read', toolCallId: 'c1', input: { path: 'x' } }, ctx);
      assert.equal(first.block, true);
      assert.match(first.reason, /provider tool-name contract violation/);
      await hooks.get('turn_end')(response('c1'), ctx);
      assert.equal(aborted, 0);
      assert.equal(messages.length, 1);
      assert.match(messages[0].text, /RUNTIME PROVIDER TOOL CONTRACT CORRECTION/);
      hooks.get('turn_start')({ turnIndex: 1 });
      const next = hooks.get('before_provider_request')({ payload: payload() }, ctx);
      assert.deepEqual(next.tools.map(t => t.function.name), ['safe_edit', 'submit_result']);
      const repeated = await hooks.get('tool_call')({ toolName: 'read', toolCallId: 'c2', input: {} }, ctx);
      assert.equal(repeated.block, true);
      await hooks.get('turn_end')(response('c2'), ctx);
      assert.equal(aborted, 1);
      assert.equal(messages.length, 1, 'no second corrective steer');
      const failure = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir,'failure.json'))}, 'utf8'));
      assert.equal(failure.failure_code, 'PI_PROVIDER_TOOL_NAME_CORRECTION_FAILED');
      assert.equal(failure.failure_class, 'model_execution_abort');
      assert.deepEqual(failure.requestedToolNames, ['safe_edit', 'submit_result']);
      assert.deepEqual(failure.returnedToolNames, ['read']);
      assert.equal(failure.correctionAttempts, 1);
      assert.equal(failure.checkpoint.worktree_preserved, true);
    `;
    const child = spawnSync(process.execPath, [
      '--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', fixture,
    ], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PI_STAGE: 'implementer',
        PI_ISSUE_CONTEXT: path.join(dir, 'issue.json'),
        PI_RESUME_ACTIVE: 'true', PI_VALIDATION_REPAIR: 'false',
        PI_RUNTIME_FAILURE_FILE: path.join(dir, 'failure.json') },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.match(child.stderr, /PI_PROVIDER_TOOL_NAME_VIOLATION/);
    assert.match(child.stderr, /PI_PROVIDER_TOOL_NAME_CORRECTION_FAILED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
