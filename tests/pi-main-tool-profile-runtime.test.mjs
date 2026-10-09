import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('#684 real fresh Main provider hook filters first schema and defers grants until next request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-main-profile-'));
  try {
    const issue = path.join(dir, 'issue.json');
    const loader = path.join(dir, 'loader.mjs');
    fs.writeFileSync(issue, JSON.stringify({ title: 'Small Python helper', body: 'Add unique_terms() and focused tests.' }));
    fs.writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'typebox') return {
        url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, { get: () => (...args) => ({}) });'),
        shortCircuit: true,
      };
      return nextResolve(specifier, context);
    }`);
    const script = `
      import assert from 'node:assert/strict';
      import { default as runtime } from ${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)};
      const handlers = new Map();
      const definitions = new Map();
      const initiallyRegistered = ['read', 'write', 'safe_edit', 'edit',
        'accept_mutation_scope', 'run_check', 'recover_worktree', 'submit_result',
        'begin_result_submission', 'need_more_evidence', 'searxng_web_search',
        'context7_query-docs', 'lsp_start_server', 'lsp_find_symbol', 'file_history',
        'subagent', 'set_response_budget'];
      for (const name of initiallyRegistered) definitions.set(name, { name });
      let active = [...definitions.keys(), 'request_capabilities'];
      const steers = [];
      const pi = {
        events: { on: () => {}, emit: () => {} },
        registerTool: def => { definitions.set(def.name, def); if (!active.includes(def.name)) active.push(def.name); },
        on: (name, fn) => handlers.set(name, fn),
        getAllTools: () => [...definitions.values()],
        getActiveTools: () => [...active],
        setActiveTools: names => { active = [...names]; },
        setModel: async () => true,
        sendUserMessage: async message => { steers.push(message); },
      };
      runtime(pi);
      assert.ok(definitions.has('request_capabilities'));
      const raw = {
        model: 'test',
        messages: [
          { role: 'system', content: 'Trusted Main system' },
          { role: 'user', content: '<shared_agent_contract source="agents/AGENTS.md">shared</shared_agent_contract>\\n<role_contract source="agents/implementer/AGENTS.md">role</role_contract>' },
        ],
        tools: [...definitions.keys()].map(name => ({
          type: 'function', function: { name, description: name, parameters: { type: 'object' } },
        })),
      };
      const initial = handlers.get('before_provider_request')({ payload: raw });
      const names = payload => (payload.tools ?? []).map(def => def.function.name);
      assert.ok(names(initial).includes('write'));
      assert.ok(names(initial).includes('read'));
      assert.ok(names(initial).includes('safe_edit'));
      assert.ok(names(initial).includes('request_capabilities'));
      assert.ok(!names(initial).includes('searxng_web_search'));
      assert.ok(!names(initial).includes('lsp_start_server'));
      assert.ok(!names(initial).includes('file_history'));
      assert.ok(names(initial).length < names(raw).length);
      assert.match(initial.tools.at(-1).function.description, /CURRENTLY EXPOSED TOOLS/);
      assert.doesNotMatch(initial.tools.at(-1).function.description, /lsp_find_symbol|searxng_web_search/);
      const context = { cwd: process.cwd(), model: { maxTokens: 2048 }, abort: () => { throw Error('unexpected abort'); } };
      const hiddenCall = { toolName: 'lsp_start_server', toolCallId: 'hidden-1', input: {} };
      const blocked = await handlers.get('tool_call')(hiddenCall, context);
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /intentionally hidden by the Main tool profile/);
      assert.match(blocked.reason, /request_capabilities.*group=lsp/);
      assert.doesNotMatch(blocked.reason, /became active/);
      assert.equal(steers.length, 1);
      await handlers.get('tool_call')(hiddenCall, context);
      assert.equal(steers.length, 1, 'repeated hidden call does not add steers or loop strikes');
      const invalid = await definitions.get('request_capabilities').execute('invalid-grant', {
        group: 'not-a-group', reason: 'Unknown group must not spend grant slots',
      });
      assert.equal(invalid.isError, true);
      assert.match(invalid.content[0].text, /unknown_group/);
      const grant = await definitions.get('request_capabilities').execute('call-grant', {
        group: 'docs', reason: 'Need to inspect authorized dependency docs',
      });
      assert.match(grant.content[0].text, /NEXT provider request/);
      const repeated = await definitions.get('request_capabilities').execute('repeat-docs', {
        group: 'docs', reason: 'Duplicate request is a no-op',
      });
      assert.match(repeated.content[0].text, /already approved/);
      assert.ok(!names(initial).includes('searxng_web_search'),
        'the already serialized provider request must not acquire new tools');
      const second = handlers.get('before_provider_request')({ payload: raw });
      assert.ok(names(second).includes('searxng_web_search'));
      assert.ok(names(second).includes('context7_query-docs'));
      assert.ok(!names(second).includes('lsp_find_symbol'));
      assert.ok(!names(second).includes('file_history'));
      const lspGrant = await definitions.get('request_capabilities').execute('grant-lsp', {
        group: 'lsp', reason: 'Inspect actual language-server relationships',
      });
      assert.equal(lspGrant.isError, undefined);
      const historyGrant = await definitions.get('request_capabilities').execute('grant-history', {
        group: 'history', reason: 'Inspect authorized historical change intent',
      });
      assert.equal(historyGrant.isError, undefined);
      const full = handlers.get('before_provider_request')({ payload: raw });
      assert.ok(names(full).includes('lsp_start_server'));
      assert.ok(names(full).includes('file_history'));
      assert.ok(!names(full).includes('request_capabilities'), 'three real grants exhaust the budget, not failed/repeat calls');
      const exhausted = await handlers.get('tool_call')({ toolName: 'request_capabilities', toolCallId: 'exhausted', input: { group: 'delegation' } }, context);
      assert.equal(exhausted.block, true);
      assert.match(exhausted.reason, /three successful Main capability grants have been used/);
      assert.doesNotMatch(exhausted.reason, /became active after/);
      const zero = handlers.get('before_provider_request')({ payload: { ...raw, tools: [] } });
      assert.equal(zero.tools, undefined, 'zero-tool request remains closed');
      assert.equal(zero.tool_choice, undefined);
    `;
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_ISSUE_CONTEXT: issue, PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /PI_MAIN_TOOL_PROFILE/);
    assert.match(result.stdout, /PI_MAIN_CAPABILITY_ESCALATION/);
    assert.match(result.stdout + result.stderr, /PI_MAIN_PROFILE_TOOL_HIDDEN/);
    assert.match(result.stdout, /PI_MAIN_TOOL_PROFILE_FINAL/);
    assert.match(result.stdout, /"toolSchemaBytesBeforeRaw":\d+/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
