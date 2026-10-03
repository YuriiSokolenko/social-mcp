import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveMutationTarget } from '../scripts/pi-common/mutation-target.mjs';
import {
  MAX_CEILING_WITHOUT_TOOL_TURNS,
  PREPARATION_FALLBACK_EVIDENCE_BUDGET,
  ProgressController,
  nextCeilingWithoutToolTurns,
  truncatedToolCallGuidance,
} from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-coding-session-'));
}

const TYPEBOX_STUB_LOADER = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox') return {
    url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
    shortCircuit: true,
  };
  return nextResolve(specifier, context);
}`;

test('every file mutation target must be physically inside the worktree', () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'pkg'));
    fs.writeFileSync(path.join(dir, 'pkg', 'mod.py'), 'x = 1\n');
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'link'));
    fs.symlinkSync(path.join(dir, '.git'), path.join(dir, 'gitlink'));
    fs.symlinkSync(path.join(outside, 'missing.py'), path.join(dir, 'dangling.py'));
    assert.equal(resolveMutationTarget(dir, 'game.py').exists, false);
    assert.equal(resolveMutationTarget(dir, path.join(dir, 'pkg', 'mod.py')).relative, path.join('pkg', 'mod.py'));
    const rejected = [
      ['', 'missing_path'], [undefined, 'missing_path'], ['../outside.py', 'invalid_path'], ['/etc/passwd', 'invalid_path'],
      ['.git/config', 'invalid_path'], ['pkg', 'invalid_path'], ['link/generated.py', 'invalid_path'],
      ['gitlink/hooks/pre-commit', 'invalid_path'], ['dangling.py', 'invalid_path'],
    ];
    for (const [target, code] of rejected) {
      assert.throws(() => resolveMutationTarget(dir, target), error => error.code === code, String(target));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the coding session starts only after preparation and once evidence is complete', () => {
  const unprepared = new ProgressController(stageConfig('implementer'), {});
  assert.equal(unprepared.checkToolCall('begin_coding_session', {}).block, true, 'preparation cannot be skipped');

  const exploring = new ProgressController(stageConfig('implementer'), {});
  assert.equal(exploring.checkToolCall('prepare_implementation', {}), undefined);
  exploring.setComplexity('nontrivial');
  exploring.setEvidenceBudget(2);
  exploring.onToolExecutionEnd('prepare_implementation', false);
  assert.equal(exploring.productiveProgressState(), 'evidence_allowed');
  assert.match(exploring.checkToolCall('begin_coding_session', {}).reason, /only once evidence is complete/, 'no 16K during exploration');

  const ready = new ProgressController(stageConfig('implementer'), {});
  assert.equal(ready.checkToolCall('prepare_implementation', {}), undefined);
  ready.enterPreparationFallback();
  ready.onToolExecutionEnd('prepare_implementation', false);
  assert.match(ready.checkToolCall('begin_coding_session', {}).reason, /only once evidence is complete/);
  for (let i = 0; i < PREPARATION_FALLBACK_EVIDENCE_BUDGET; i++) {
    assert.equal(ready.checkToolCall('read', { path: 'fallback-evidence-' + i }), undefined);
  }
  assert.equal(ready.checkToolCall('begin_coding_session', {}), undefined, 'available after fallback evidence is complete');
  ready.onToolExecutionEnd('begin_coding_session', true);
  assert.equal(ready.verificationPermitted(), false, 'a failed session earns no verification permit');
  assert.equal(ready.checkToolCall('begin_coding_session', {}), undefined);
  ready.onToolExecutionEnd('begin_coding_session', false);
  assert.equal(ready.turnMadeProgress, true);
  assert.equal(ready.verificationPermitted(), true);
  assert.equal(ready.largeMutationBudgetState, 'idle', 'no parent-side large budget state');
});

test('truncated direct mutations are steered into the coding session, not a payload retry or the legacy grant', () => {
  for (const tool of ['write', 'edit', 'safe_edit', 'structural_edit']) {
    const guidance = truncatedToolCallGuidance(tool, { largeMutationBudgetTool: 'request_large_mutation_budget', codingSessionTool: 'begin_coding_session' });
    assert.match(guidance, /NOT executed/);
    assert.match(guidance, /Do not regenerate the payload in this response/);
    assert.match(guidance, /Call begin_coding_session now/);
    assert.doesNotMatch(guidance, /request_large_mutation_budget/);
  }
});

test('ceiling-hit responses without a tool are counted, reset by any tool attempt, and bounded', () => {
  const step = (count, overrides = {}) => nextCeilingWithoutToolTurns(count, {
    actionRequired: true, attemptedTool: false, madeProgress: false, responseHitOutputCeiling: true, ...overrides,
  });
  assert.equal(step(0), 1);
  assert.equal(step(2), 3);
  assert.equal(step(2, { attemptedTool: true }), 0);
  assert.equal(step(2, { madeProgress: true }), 0);
  assert.equal(step(2, { responseHitOutputCeiling: false }), 0);
  assert.equal(step(2, { actionRequired: false }), 0);
  assert.equal(MAX_CEILING_WITHOUT_TOOL_TURNS, 3);
});

test('the coding session is the same Implementer runtime, defined only in trusted harness code', () => {
  const settings = JSON.parse(fs.readFileSync('.pi/settings.json', 'utf8'));
  for (const name of ['implementer-coding-session', 'implementer-mutation-turn', 'mutation-writer']) {
    assert.equal(fs.existsSync(`.pi/agents/${name}.md`), false, name);
    assert.equal(settings.subagents.agentOverrides[name], undefined, name);
  }
  assert.equal(fs.existsSync('scripts/pi-mutation-turn-child.mjs'), false);
  const progress = stageConfig('implementer').productiveProgress;
  assert.equal(progress.codingSessionTool, 'begin_coding_session');
  assert.equal(progress.codingSessionAgent, 'implementer-coding-session');
  assert.equal(progress.codingSessionMaxTokens, 16384);
  assert.equal(progress.actionResponseMaxTokens, 2048);
  assert.ok(progress.actionTools.includes('begin_coding_session'));
  for (const tool of ['write', 'edit', 'safe_edit', 'structural_edit', 'accept_mutation_scope', 'run_check', 'rollback_last_mutation', 'need_more_evidence', 'submit_result', 'read']) {
    assert.ok(progress.codingSessionTools.includes(tool), tool);
  }
  for (const tool of ['begin_coding_session', 'request_large_mutation_budget', 'subagent', 'subagents_enable', 'prepare_implementation', 'grep', 'find', 'ls']) {
    assert.ok(!progress.codingSessionTools.includes(tool), tool);
  }
});

// Drives the real runtime end to end, in BOTH roles: the 2K parent, and (through the simulated
// pi-subagents host below) the forked 16K coding session, which loads the registered extension
// paths and runs this same runtime in coding-session mode. pi-subagents 0.71.0 behavior is
// mirrored: runtime-agent registry; same-name configured (worktree) agents collide at launch;
// worktree agentOverrides only narrow model/thinking; an explicit "extensions" list disables
// ambient extensions; "tools" is the strict allowlist; context "fork" branches the parent's
// persisted transcript. pi-bash-timeout.mjs needs the pi package, so the host asserts its path
// but does not import it; run_check / submit_result executors are stubbed (their gates are real).
function runtimeScenario(mode) {
  const dir = tempDir();
  try {
    const context = path.join(dir, 'issue.json');
    const loader = path.join(dir, 'loader.mjs');
    const scenario = path.join(dir, 'scenario.mjs');
    const work = path.join(dir, 'work');
    const terminal = path.join(dir, 'terminal.json');
    const runtimeFailure = path.join(dir, 'runtime-failure.json');
    fs.mkdirSync(work);
    fs.writeFileSync(context, JSON.stringify({ title: 'Coding session smoke', body: 'Create generated.py and its test' }));
    fs.writeFileSync(loader, TYPEBOX_STUB_LOADER);
    fs.writeFileSync(scenario, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { EventEmitter } from 'node:events';
      const runtimeUrl = ${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)};
      const { default: runtime, providerErrorStatus } = await import(runtimeUrl);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: '400: {"message":"validation error","type":"Bad Request","code":400}' }), 400);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: '400 {"error":"bad request"}' }), 400);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: '400 status code (no body)' }), 400);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: 'BadRequestError: 422 tool_choice unsupported' }), 422);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: 'InternalServerError: 500 upstream failure' }), 500);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: 'hp-laguna API error (422): unsupported' }), 422);
      assert.equal(providerErrorStatus({ stopReason: 'error', status: 429, errorMessage: 'ignored' }), 429);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: 'Maximum context: 400 tokens' }), null);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: 'fetch failed: 422 something' }), null);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: '500 tokens exceeded' }), null);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: '400abc' }), null);
      assert.equal(providerErrorStatus({ stopReason: 'stop', errorMessage: '400 nope' }), null);
      const mode = ${JSON.stringify(mode)};
      const fallbackEvidenceBudget = ${PREPARATION_FALLBACK_EVIDENCE_BUDGET};
      const cwd = ${JSON.stringify(work)};
      const terminal = ${JSON.stringify(terminal)};
      const runtimeFailure = ${JSON.stringify(runtimeFailure)};
      const controlScripts = ${JSON.stringify(path.dirname(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).pathname))};
      const sessionFile = ${JSON.stringify(path.join(dir, 'parent-session.jsonl'))};
      const bus = new EventEmitter();
      const tools = new Map();
      const handlers = new Map();
      const caps = [];
      const childCaps = [];
      const steers = [];
      const sessionRequests = [];
      const registrations = [];
      const registered = new Map();
      let aborts = 0;
      let active = ['read', 'write', 'edit', 'bash', 'safe_edit', 'structural_edit', 'accept_mutation_scope', 'run_check', 'submit_result', 'need_more_evidence',
        'request_large_mutation_budget', 'begin_coding_session', 'rollback_last_mutation', 'repo_search', 'prepare_implementation'];
      const persist = entry => fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\\n');
      persist({ type: 'session', id: 'parent' });
      persist({ type: 'message', message: { role: 'user', content: 'Implement issue: create generated.py and its test' } });
      const ctx = { cwd, model: { maxTokens: 32000 }, abort: () => { if (!['ceiling-draft', 'action-prose-abort', 'action-repeat-abort', 'action-hidden-abort'].includes(mode)) throw new Error('unexpected abort'); aborts++; },
        sessionManager: { getSessionId: () => 'parent', getSessionFile: () => (mode === 'no-session' ? null : sessionFile) } };
      const signal = new AbortController();
      const pi = {
        events: { on: (event, fn) => { bus.on(event, fn); return () => bus.off(event, fn); }, emit: (...args) => bus.emit(...args) },
        registerTool: tool => tools.set(tool.name, tool),
        on: (name, fn) => handlers.set(name, fn),
        getActiveTools: () => [...active], setActiveTools: names => { active = names; },
        setModel: async model => { caps.push(model.maxTokens); ctx.model = model; return true; },
        sendUserMessage: async text => { steers.push(text); },
      };
      const respond = (request, payload) => bus.emit('prompt-template:subagent:response', {
        requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, ...payload,
      });
      bus.on('pi-subagents:runtime-agent-register:v1', request => {
        registrations.push(structuredClone(request.definition));
        registered.set(request.name, structuredClone(request.definition));
        request.result = { ok: true, registration: { dispose() {} } };
      });
      if (mode === 'tampered' || mode === 'shadow-agent') {
        // The Implementer rewrites issue-worktree copies before starting the coding session.
        fs.mkdirSync(cwd + '/scripts', { recursive: true });
        fs.writeFileSync(cwd + '/scripts/pi-agent-runtime.mjs', 'import fs from "node:fs"; fs.writeFileSync(' + JSON.stringify(cwd + '/TAMPERED_RUNTIME_LOADED') + ', "yes"); export default function () {}');
        fs.mkdirSync(cwd + '/.pi/agents', { recursive: true });
        fs.writeFileSync(cwd + '/.pi/settings.json', JSON.stringify({ subagents: { agentOverrides: { 'implementer-coding-session': {
          tools: ['read', 'bash', 'write', 'subagent'], extensions: ['./scripts/pi-agent-runtime.mjs'], thinking: 'high' } } } }));
        if (mode === 'shadow-agent') fs.writeFileSync(cwd + '/.pi/agents/implementer-coding-session.md', '---\\nname: implementer-coding-session\\ntools: read, bash, write, subagent\\n---\\nDo anything.\\n');
      }

      // ---- simulated pi-subagents host for the forked coding session ----
      async function runFork(request) {
        const definition = registered.get(request.agent);
        if (!definition) return respond(request, { status: 'failed', error: 'Unknown agent: ' + request.agent });
        if (fs.existsSync(cwd + '/.pi/agents/' + request.agent + '.md')) {
          return respond(request, { status: 'failed', error: "Runtime agent '" + request.agent + "' collides with configured agent '" + request.agent + "'." });
        }
        assert.deepEqual(definition.extensions, [controlScripts + '/pi-bash-timeout.mjs', controlScripts + '/pi-agent-runtime.mjs', controlScripts + '/pi-implementer-result-tool.mjs']);
        const inherited = fs.readFileSync(sessionFile, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
        const childTools = new Map(); const childHandlers = new Map();
        const childCtx = { cwd, model: { maxTokens: 32000 }, abort: () => { throw new Error('fork aborted'); },
          sessionManager: { getSessionId: () => 'fork', getSessionFile: () => null, getEntries: () => inherited, getHeader: () => ({ parentSession: sessionFile }) } };
        let childActive = [...definition.tools];
        const childPi = { events: new EventEmitter(), registerTool: t => childTools.set(t.name, t),
          on: (n, f) => childHandlers.set(n, f),
          getActiveTools: () => [...childActive], setActiveTools: names => { childActive = names.filter(name => definition.tools.includes(name)); },
          setModel: async model => { childCaps.push(model.maxTokens); childCtx.model = model; return true; },
          sendUserMessage: async () => {} };
        // Load exactly the registered extensions (ambient extensions disabled).
        for (const extensionPath of definition.extensions) {
          if (extensionPath.endsWith('/pi-bash-timeout.mjs')) continue;
          const { default: extension } = await import(new URL('file://' + extensionPath).href);
          extension(childPi);
        }
        // Thinking off on the wire, from the trusted runtime, whatever the settings say.
        const providerPatch = childHandlers.get('before_provider_request');
        assert.ok(providerPatch, 'coding-session runtime patches provider requests');
        const patched = providerPatch({ payload: { model: 'm', messages: [], max_completion_tokens: 16384, chat_template_kwargs: { keep: 1, enable_thinking: true } } }, childCtx);
        assert.deepEqual(patched.chat_template_kwargs, { keep: 1, enable_thinking: false });
        assert.equal(patched.max_completion_tokens, 16384, 'the 16K ceiling is untouched');
        const other = { input: 'not a chat payload' };
        assert.equal(providerPatch({ payload: other }, childCtx), other, 'non-chat payloads are left alone');
        // Executors stubbed; the runtime's gates around them are real.
        childTools.get('run_check').execute = async () => ({ content: [{ type: 'text', text: 'check passed' }] });
        childTools.get('submit_result').execute = async () => { fs.writeFileSync(terminal, 'submitted\\n'); return { content: [{ type: 'text', text: 'submitted' }] }; }; // same marker terminalResult() writes
        let turn = 0;
        if (mode === 'fork-prose-force') {
          childHandlers.get('turn_start')({ turnIndex: turn });
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, childCtx);
          const actionPayload = {
            model: 'm',
            messages: [],
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          const forced = providerPatch({ payload: actionPayload }, childCtx);
          assert.equal(forced.tool_choice, 'required', 'coding-session action_required uses the same forced-tool rule');
        }
        const childCall = async (name, input) => {
          childHandlers.get('turn_start')({ turnIndex: turn });
          if (!definition.tools.includes(name)) { turn++; return { block: true, reason: name + ' is not in the agent tool allowlist' }; }
          const event = { toolName: name, toolCallId: 'c' + turn, input };
          const blocked = await childHandlers.get('tool_call')(event, childCtx);
          if (blocked) { await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 400 } } }, childCtx); return blocked; }
          let result; let isError = false;
          try {
            if (childTools.has(name)) result = await childTools.get(name).execute(event.toolCallId, input, null, null, childCtx);
            else { if (name === 'write') fs.writeFileSync(cwd + '/' + input.path, input.content); result = { content: [{ type: 'text', text: 'ok' }] }; }
          } catch (error) { isError = true; result = { content: [{ type: 'text', text: String(error.message) }] }; }
          await childHandlers.get('tool_execution_end')({ ...event, isError, result }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 3000 } } }, childCtx);
          return result;
        };
        // The forked "model": its knowledge comes from the inherited transcript + task only.
        const transcript = inherited.flatMap(entry => Array.isArray(entry.message?.content)
          ? entry.message.content.map(part => part?.text ?? '') : [String(entry.message?.content ?? '')]).join('\\n');
        const constant = /REQUIRED_CONSTANT = "([^"]+)"/.exec(transcript)?.[1];
        if (mode === 'tampered') {
          assert.ok((await childCall('subagent', {})).block, 'worktree override cannot add subagent');
          assert.ok((await childCall('begin_coding_session', {})).block, 'no nested coding session');
        }
        if (mode === 'containment') {
          fs.symlinkSync('/tmp', cwd + '/link');
          assert.match((await childCall('write', { path: 'link/escape.py', content: 'x' })).reason, /symbolic links/);
          assert.match((await childCall('write', { path: '.git/hooks/pre-commit', content: 'x' })).reason, /cannot target .git/);
        }
        await childCall('accept_mutation_scope', {
          paths: ['generated.py', 'test_generated.py'],
          disposition: 'publishable',
          rationale: 'Issue requires the implementation module and its focused regression test.',
        });
        await childCall('write', { path: 'generated.py', content: 'REQUIRED_CONSTANT = "' + constant + '"\\nHELP = "q: quit\\\\nr: restart"\\n' });
        if (mode === 'fork-prose-force') {
          const actionPayload = {
            model: 'm',
            messages: [],
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          assert.equal(providerPatch({ payload: actionPayload }, childCtx).tool_choice, undefined, 'child tool call clears forcing');
        }
        await childCall('run_check', { kind: 'python_compile', paths: [cwd + '/generated.py'] });
        await childCall('write', { path: 'test_generated.py', content: 'from generated import REQUIRED_CONSTANT\\n\\ndef test_constant():\\n    assert REQUIRED_CONSTANT == "' + constant + '"\\n' });
        await childCall('run_check', { kind: 'pytest', targets: ['test_generated.py'] });
        if (mode !== 'no-submit') await childCall('submit_result', { title: 't', summary: 's', changes: ['c'], files: ['generated.py', 'test_generated.py'], security_notes: 'n', limitations: 'n' });
        respond(request, { status: 'completed', result: { kind: 'text', value: 'done' }, usage: { output: 9000 } });
      }
      bus.on('prompt-template:subagent:request', async request => {
        if (request.agent === 'implementation-planner') {
          return respond(request, mode === 'fallback'
            ? { status: 'failed', error: 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.' }
            : { status: 'completed', result: { kind: 'structured', value: { steps: ['Create generated.py'], complexity: 'nontrivial', evidence_budget: 1, reason: 'One lookup' } } });
        }
        assert.equal(request.agent, 'implementer-coding-session');
        assert.equal(request.context, 'fork', 'same-context fork, not a fresh prompt');
        assert.deepEqual(request.result, { kind: 'text' });
        assert.equal(request.toolBudget, undefined, 'no artificial tool budget on the coding session');
        // Request-level thinking: pi-subagents 0.71.0 resolves thinkingOverride ?? agent.thinking
        // (replaceExisting suffix), so it wins over worktree agentOverrides.thinking / defaults.
        assert.equal(request.thinking, 'off', 'coding session requested with thinking off');
        sessionRequests.push({ task: request.task, maxTokens: process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, spec: JSON.parse(process.env.PI_CODING_SESSION) });
        if (mode === 'cancel') { signal.abort(); return; }
        await runFork(request);
      });

      runtime(pi);
      // The parent also carries the real implementer result tool (and its submit nudge).
      const { default: parentResultTool } = await import(${JSON.stringify(new URL('../scripts/pi-implementer-result-tool.mjs', import.meta.url).href)});
      parentResultTool(pi);
      assert.equal(handlers.has('before_provider_request'), true, 'the parent installs the provider constraint hook');
      assert.equal(handlers.has('turn_end'), true, 'the parent installs provider error recovery on the authoritative turn boundary');
      const unarmedPayload = { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'write' } }] };
      assert.equal(handlers.get('before_provider_request')({ payload: unarmedPayload }, ctx), unarmedPayload, 'unarmed parent request is unchanged');
      tools.get('run_check').execute = async () => ({ content: [{ type: 'text', text: 'check passed' }] });
      let turn = 0;
      async function call(name, input = {}, { expectError = null } = {}) {
        handlers.get('turn_start')({ turnIndex: turn });
        const event = { toolName: name, toolCallId: name + turn, input };
        assert.equal(await handlers.get('tool_call')(event, ctx), undefined, name + ' was blocked');
        let result; let isError = false;
        try {
          if (tools.has(name)) result = await tools.get(name).execute(event.toolCallId, input, signal.signal, null, ctx);
          else {
            if (name === 'write') fs.writeFileSync(cwd + '/' + input.path, input.content);
            if (name === 'read') result = { content: [{ type: 'text', text: fs.existsSync(cwd + '/' + input.path) ? fs.readFileSync(cwd + '/' + input.path, 'utf8') : '' }] };
            result ??= { content: [{ type: 'text', text: 'ok' }] };
          }
        } catch (error) {
          isError = true;
          if (!expectError) throw error;
          assert.match(String(error.message), expectError);
          result = { content: [{ type: 'text', text: String(error.message) }] };
        }
        if (expectError) assert.equal(isError, true, name + ' should fail');
        persist({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name, arguments: input }] } });
        persist({ type: 'message', message: { role: 'toolResult', toolName: name, content: result.content } });
        await handlers.get('tool_execution_end')({ ...event, isError, result }, ctx);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        return result;
      }

      if (mode !== 'restored') {
        await call('prepare_implementation');
        if (mode !== 'fallback') {
          const early = await handlers.get('tool_call')({ toolName: 'begin_coding_session', toolCallId: 'early', input: {} }, ctx);
          assert.match(early.reason, /only once evidence is complete/, 'no 16K during exploration');
        }
      }
      // Evidence gathered by the parent earlier in its own session; never repeated in the request.
      fs.writeFileSync(cwd + '/config.py', 'REQUIRED_CONSTANT = "abc123"\\n');
      if (mode === 'fallback') {
        for (let i = 1; i < fallbackEvidenceBudget; i++) {
          fs.writeFileSync(cwd + '/fallback-layout-' + i + '.txt', 'layout evidence ' + i + '\\n');
          await call('read', { path: 'fallback-layout-' + i + '.txt' });
        }
        await call('read', { path: 'config.py' });
      } else {
        if (mode === 'restored') await call('need_more_evidence', { missing: 'constant', reason: 'value' });
        await call('read', { path: 'config.py' });
      }
      fs.rmSync(cwd + '/config.py');
      for (let i = 1; i < fallbackEvidenceBudget; i++) fs.rmSync(cwd + '/fallback-layout-' + i + '.txt', { force: true });

      if (['prose-force-direct', 'prose-force-provider-statuses', 'action-prose-abort', 'action-repeat-abort', 'action-hidden-abort'].includes(mode)) {
        // First action_required response is prose only: the runtime arms provider-level
        // required-tool forcing and keeps it armed until a real exposed tool is attempted.
        handlers.get('turn_start')({ turnIndex: turn });
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        const exposedBeforeForce = [...active];
        for (const name of ['write', 'begin_coding_session', 'submit_result', 'need_more_evidence']) {
          assert.ok(exposedBeforeForce.includes(name), name + ' remains an available model choice');
        }
        const providerPayload = {
          model: 'm',
          messages: [],
          tools: exposedBeforeForce.map(name => ({ type: 'function', function: { name } })),
        };
        const nonActionPayload = { model: 'm', messages: [] };
        assert.equal(
          handlers.get('before_provider_request')({ payload: nonActionPayload }, ctx),
          nonActionPayload,
          'non-action provider requests without tools are not forced',
        );
        if (mode === 'prose-force-provider-statuses') {
          for (const [status, errorMessage] of [
            [408, '408 status code (no body)'],
            [429, '429 {"error":"rate limit"}'],
          ]) {
            handlers.get('turn_start')({ turnIndex: turn });
            const retry = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
            assert.equal(retry.tool_choice, 'required', 'provider status ' + status + ' keeps tool forcing armed');
            const boundary = await handlers.get('turn_end')({
              turnIndex: turn++,
              message: {
                stopReason: 'error',
                errorMessage,
                usage: { output: 0 },
              },
            }, ctx);
            assert.equal(boundary, undefined, 'provider error turn is ignored by model-progress accounting');
          }

          handlers.get('turn_start')({ turnIndex: turn });
          const rejected = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(rejected.tool_choice, 'required');
          const boundary = await handlers.get('turn_end')({
            turnIndex: turn++,
            message: {
              stopReason: 'error',
              errorMessage: '422: {"error":"tool_choice required is unsupported"}',
              usage: { output: 0 },
            },
          }, ctx);
          assert.equal(boundary, undefined, 'turn_end return value is not the continuation mechanism');

          handlers.get('turn_start')({ turnIndex: turn });
          const fallback = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(fallback.tool_choice, undefined, '422 clears provider-level forced-tool fallback');
          assert.match(steers.at(-1), /provider rejected the provider-level required-tool request/);
          assert.match(steers.at(-1), /CURRENTLY EXPOSED TOOLS/);
          assert.match(steers.at(-1), /submit_result with blocked_reason/);
          process.exit(0);
        }

        const constrained = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
        assert.equal(constrained.tool_choice, 'required');
        assert.deepEqual(constrained.tools, providerPayload.tools, 'tool forcing does not choose or remove an exposed tool');

        if (mode === 'action-repeat-abort') {
          handlers.get('turn_start')({ turnIndex: turn });
          const repeated = await handlers.get('tool_call')({
            toolName: 'prepare_implementation',
            toolCallId: 'repeat-' + turn,
            input: {},
          }, ctx);
          assert.ok(repeated?.alreadySatisfied || /already/i.test(String(repeated?.reason ?? '')), 'repeat is rejected as already completed');
          assert.match(String(repeated.reason), /CURRENTLY EXPOSED TOOLS/);
          const afterRepeat = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(afterRepeat.tool_choice, undefined, 'an emitted tool call consumes provider forcing even when it is a no-op');
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
          assert.equal(aborts, 1, 'already-satisfied repeat still counts as no productive action and trips the watchdog');
          process.exit(0);
        }

        if (mode === 'action-hidden-abort') {
          handlers.get('turn_start')({ turnIndex: turn });
          const hidden = await handlers.get('tool_call')({
            toolName: 'read',
            toolCallId: 'hidden-' + turn,
            input: { path: 'config.py' },
          }, ctx);
          assert.equal(hidden.block, true);
          assert.match(hidden.reason, /not currently exposed/);
          assert.match(hidden.reason, /CURRENTLY EXPOSED TOOLS/);
          const afterHidden = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(afterHidden.tool_choice, undefined, 'hidden provider-emitted tool clears transport forcing');
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
          assert.equal(aborts, 1, 'hidden tool remains non-progress and trips the second-strike watchdog');
          process.exit(0);
        }

        if (mode === 'prose-force-direct') {
          // A forced response that still hits the output ceiling without a tool must not consume
          // the requirement. The following provider request remains constrained.
          handlers.get('turn_start')({ turnIndex: turn });
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 2048 } } }, ctx);
          const afterCeiling = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(afterCeiling.tool_choice, 'required', 'ceiling-hit response does not consume tool forcing');

          await call('accept_mutation_scope', {
            paths: ['small.txt'],
            disposition: 'publishable',
            rationale: 'Direct forced-tool test requires one small implementation file.',
          });
          await call('write', { path: 'small.txt', content: 'small change\\n' });
          assert.equal(fs.readFileSync(cwd + '/small.txt', 'utf8'), 'small change\\n');
          const afterTool = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(afterTool.tool_choice, undefined, 'a real tool attempt satisfies the provider constraint');
          process.exit(0);
        }

        // Deliberately simulate a non-compliant provider/model that returned prose even though
        // tool_choice was required. The existing second-strike watchdog must still terminate.
        handlers.get('turn_start')({ turnIndex: turn });
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        assert.equal(aborts, 1);
        const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
        assert.equal(failure.failure_class, 'model_execution_abort');
        assert.equal(failure.failure_code, 'PI_ACTION_REQUIRED_ABORT');
        assert.match(failure.reason, /second consecutive prose-only/);
        console.log('RUNTIME_FAILURE_RECORD ' + JSON.stringify(failure));
        process.exit(0);
      }

      if (mode === 'ceiling-draft') {
        for (let i = 1; i <= 3; i++) {
          handlers.get('turn_start')({ turnIndex: turn });
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 2048 } } }, ctx);
          if (i < 3) assert.ok(steers.at(-1).includes('call begin_coding_session now'), steers.at(-1));
        }
        assert.equal(aborts, 1, 'third ceiling-hit response without a tool aborts');
        process.exit(0);
      }
      if (mode === 'direct-containment') {
        const blocked = await handlers.get('tool_call')({ toolName: 'write', toolCallId: 'w', input: { path: '.git/config', content: 'x' } }, ctx);
        assert.match(blocked.reason, /cannot target .git/);
        process.exit(0);
      }

      handlers.get('turn_start')({ turnIndex: turn });
      assert.ok(active.includes('begin_coding_session'));
      const expectError = { cancel: /aborted/, 'no-session': /cannot continue as a coding session/, 'shadow-agent': /collides with configured agent/ }[mode] ?? null;
      const result = await call('begin_coding_session', { reason: 'Implement generated.py and its test' }, { expectError });
      assert.equal(process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, '2048', 'parent child-budget mirror restored');
      assert.ok(!process.env.PI_CODING_SESSION, 'coding-session mode is scoped to the fork');
      assert.ok(caps.filter(cap => cap !== 32000).every(cap => cap === 2048), 'parent stays at 2048: ' + caps);
      if (mode === 'no-session') assert.equal(sessionRequests.length, 0, 'no fresh-prompt fallback');
      else {
        assert.equal(sessionRequests.length, 1);
        assert.equal(sessionRequests[0].maxTokens, '16384');
        assert.equal(sessionRequests[0].spec.maxTokens, 16384);
        assert.doesNotMatch(sessionRequests[0].task, /abc123/, 'the constant is NOT handed over in the request');
      }
      if (['flow', 'fallback', 'restored', 'tampered', 'containment', 'no-submit'].includes(mode)) {
        assert.ok(childCaps.length > 0 && childCaps.every(cap => cap === 16384), 'every coding-session response is 16384: ' + childCaps);
        assert.match(fs.readFileSync(cwd + '/generated.py', 'utf8'), /REQUIRED_CONSTANT = "abc123"/, 'the fork used context the request never carried');
        assert.equal(fs.readFileSync(cwd + '/generated.py', 'utf8').split('\\n')[1], 'HELP = "q: quit\\\\nr: restart"');
        assert.ok(fs.existsSync(cwd + '/test_generated.py'), 'the session wrote tests too');
      }
      if (['flow', 'fallback', 'restored', 'tampered', 'containment'].includes(mode)) {
        assert.equal(result.terminate, true, 'parent ends after the fork submitted');
        assert.ok(fs.existsSync(terminal));
        // Smoke #285: the parent's own submit flag is false (the fork submitted), so the nudge
        // must honor the run-wide terminal marker instead of restarting the parent.
        assert.equal(handlers.get('agent_before_settle')(), undefined, 'no submit nudge after the fork submitted');
      }
      if (mode === 'no-submit') {
        assert.notEqual(result.terminate, true);
        assert.equal(handlers.get('agent_before_settle')()?.continue, true, 'without a submission the nudge still fires');
        assert.match(result.content[0].text, /ended without submit_result/);
        await call('begin_coding_session', {});
        // The per-run limit (2) is enforced when the third session is requested.
        await call('begin_coding_session', {}, { expectError: /coding session limit .2. for this run is reached/ });
      }
      if (mode === 'tampered' || mode === 'shadow-agent') {
        assert.equal(fs.existsSync(cwd + '/TAMPERED_RUNTIME_LOADED'), false, 'the issue-worktree runtime copy is never loaded');
        for (const definition of registrations) {
          assert.equal(definition.thinking, 'off');
          assert.ok(definition.extensions.every(p => p.startsWith(controlScripts + '/') && !p.startsWith(cwd)), 'absolute control-checkout paths only');
          assert.ok(!definition.tools.includes('subagent'));
        }
      }
    `);
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, scenario], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_ISSUE_CONTEXT: context, PI_TERMINAL_RESULT_FILE: terminal,
        PI_RESUME_ACTIVE: mode === 'restored' ? 'true' : 'false', PI_VALIDATION_REPAIR: 'false',
        PI_SUBAGENT_RESPONSE_MAX_TOKENS: '2048', PI_CODING_SESSION: '', PI_RUNTIME_FAILURE_FILE: runtimeFailure },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout + result.stderr;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('2K parent -> begin_coding_session -> 16K same-context fork writes code + tests, checks, submits; parent ends', () => {
  const logs = runtimeScenario('flow');
  assert.match(logs, /PI_CODING_SESSION \{"phase":"agent_registered".*"source":"runtime","thinking":"off"/);
  assert.match(logs, /"phase":"requested".*"parentMaxTokens":2048,"codingMaxTokens":16384/);
  assert.match(logs, /"phase":"started".*"context":"fork","agent":"implementer-coding-session"/);
  assert.match(logs, /"phase":"completed".*"submitted":true/);
  assert.match(logs, /PI_CODING_SESSION \{"phase":"thinking_disabled","side":"fork".*"enableThinking":false,"maxTokens":16384/);
  assert.match(logs, /PI_CODING_SESSION \{"phase":"first_tool_call","side":"fork".*"tool":"accept_mutation_scope"/);
  assert.match(logs, /PI_CODING_SESSION \{"phase":"first_response","side":"fork".*"attemptedTool":true/);
  assert.equal(logs.match(/PI_MUTATION \{"stage":"implementer","tool":"write","mode":"coding_session"[^\n]*"changed":true/g)?.length, 2, 'several files in one session');
  assert.match(logs, /PI_RUN_CHECK|check passed|"phase":"completed"/);
  assert.doesNotMatch(logs, /PI_LARGE_MUTATION_BUDGET|mutation-writer|PI_MUTATION_TURN/);
});

test('coding session works after PREPARATION_FALLBACK and on a resumed implementer', () => {
  assert.match(runtimeScenario('fallback'), /"phase":"requested".*"preparationState":"PREPARATION_FALLBACK"/);
  assert.match(runtimeScenario('restored'), /"phase":"completed".*"submitted":true/);
});

test('trusted runtime protections hold inside the coding session and in the 2K phase', () => {
  assert.match(runtimeScenario('containment'), /PI_MUTATION_BLOCKED .*"reason":"invalid_path"/);
  assert.match(runtimeScenario('direct-containment'), /PI_MUTATION_BLOCKED .*"tool":"write".*"reason":"invalid_path"/);
});

test('a session that ends without submit returns control at 2K, with a bounded number of sessions', () => {
  const logs = runtimeScenario('no-submit');
  assert.match(logs, /"phase":"ended_without_submit".*"submitted":false/);
  assert.match(logs, /"phase":"rejected".*"reason":"max_sessions"/);
});

test('first prose-only action-required retry stays forced through a ceiling turn until a real exposed tool', () => {
  const logs = runtimeScenario('prose-force-direct');
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_ARMED/);
  assert.ok((logs.match(/PI_ACTION_REQUIRED_TOOL_CHOICE .*"mode":"required"/g) ?? []).length >= 2);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED .*"tool":"write"/);
  assert.doesNotMatch(logs, /PI_ACTION_REQUIRED_ABORT/);
});

test('OpenAI SDK provider error turns preserve forcing on 408/429 and recover once from a forced 422', () => {
  const logs = runtimeScenario('prose-force-provider-statuses');
  assert.ok((logs.match(/PI_ACTION_REQUIRED_TOOL_CHOICE .*"mode":"required"/g) ?? []).length >= 3);
  assert.match(logs, /PI_PROVIDER_ERROR_TURN .*"status":408.*"forced":true/);
  assert.match(logs, /PI_PROVIDER_ERROR_TURN .*"status":429.*"forced":true/);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_CLEARED .*"reason":"provider_request_rejected".*"status":422.*"source":"turn_end"/);
  assert.doesNotMatch(logs, /PI_ACTION_REQUIRED_ABORT/);
});

test('an already-completed repeated tool call clears forcing but still fails closed via the progress watchdog', () => {
  const logs = runtimeScenario('action-repeat-abort');
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED .*"alreadySatisfied":true/);
  assert.match(logs, /PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn/);
});

test('a hidden provider-emitted tool clears forcing but remains non-progress and aborts on the watchdog', () => {
  const logs = runtimeScenario('action-hidden-abort');
  assert.match(logs, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"attemptedTool":"read"/);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED .*"tool":"read".*"unavailable":true/);
  assert.match(logs, /PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn/);
});

test('coding-session fork shares action_required forcing semantics and clears them on its first tool', () => {
  const logs = runtimeScenario('fork-prose-force');
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_ARMED/);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED .*"tool":"write"/);
});

test('a deliberately non-compliant second prose-only turn still aborts with durable execution-failure metadata', () => {
  const logs = runtimeScenario('action-prose-abort');
  assert.match(logs, /PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn/);
  assert.match(logs, /RUNTIME_FAILURE_RECORD .*"failure_class":"model_execution_abort".*"failure_code":"PI_ACTION_REQUIRED_ABORT"/);
});

test('cancellation, a missing session, and drafting loops fail closed', () => {
  assert.match(runtimeScenario('cancel'), /"phase":"cancelled"/);
  assert.match(runtimeScenario('no-session'), /"phase":"rejected".*"reason":"fork_unavailable"/);
  const draft = runtimeScenario('ceiling-draft');
  assert.match(draft, /PI_ACTION_REQUIRED_STEER: ceiling without tool \(1\/3\)/);
  assert.match(draft, /PI_ACTION_REQUIRED_ABORT: 3 consecutive action-required responses hit the output ceiling without a tool call/);
});

test('rewriting the issue-worktree runtime, settings or agent definition cannot change the coding session', () => {
  assert.match(runtimeScenario('tampered'), /"phase":"completed".*"submitted":true/);
  assert.match(runtimeScenario('shadow-agent'), /"phase":"ended_without_submit".*collides with configured agent/);
});

test('the submit nudge honors a submission recorded by another process', async () => {
  const { terminalMarkerSubmitted } = await import('../scripts/pi-common/terminal-tool.mjs');
  const dir = tempDir();
  try {
    const marker = path.join(dir, 'terminal');
    assert.equal(terminalMarkerSubmitted({ PI_TERMINAL_RESULT_FILE: marker }), false, 'no marker');
    fs.writeFileSync(marker, 'something else\n');
    assert.equal(terminalMarkerSubmitted({ PI_TERMINAL_RESULT_FILE: marker }), false, 'foreign content');
    fs.writeFileSync(marker, 'submitted\n');
    assert.equal(terminalMarkerSubmitted({ PI_TERMINAL_RESULT_FILE: marker }), true);
    assert.equal(terminalMarkerSubmitted({}), false, 'no marker configured');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run_check scope normalization from current dev accepts relative and worktree-absolute paths (#281)', async () => {
  const { normalizeRunCheckPaths } = await import('../scripts/pi-common/run-check.mjs');
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'generated.py'), 'x = 1\n');
    assert.deepEqual(normalizeRunCheckPaths(dir, { kind: 'python_compile', paths: [path.join(dir, 'generated.py')] }).paths, ['generated.py']);
    assert.deepEqual(normalizeRunCheckPaths(dir, { kind: 'python_compile', paths: ['generated.py'] }).paths, ['generated.py']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
