import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveMutationTarget } from '../scripts/pi-common/mutation-target.mjs';
import {
  MAX_CEILING_WITHOUT_TOOL_TURNS,
  PREPARATION_FALLBACK_EVIDENCE_BUDGET,
  ProgressController,
  nextCeilingWithoutToolTurns,
  truncatedToolCallGuidance,
} from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';
import { summarizeUsage } from '../scripts/pi-common/usage-ledger.mjs';

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

test('coding-session guidance uses only exposed tools and routes missing evidence through need_more_evidence', () => {
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(runtime, /never invent helper names such as read_for_input/);
  assert.match(runtime, /if one concrete missing fact prevents the next safe action, call need_more_evidence/);
  assert.match(runtime, /action-required: read is not exposed now/);
  assert.match(runtime, /request the one missing fact through \$\{blockerTool\}/);
  assert.match(runtime, /bounded repair read access only for the failing\/changed paths/);
  assert.match(runtime, /Tests must prefer public behavior and public APIs/);
  assert.match(runtime, /do not mutate private\/internal implementation state merely to manufacture fixture state/);
});

test('#470 evidence-consumed notices are correlated to the exact tool call', () => {
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(runtime, /pendingEvidenceConsumptionNotices\.set\(event\.toolCallId, evidenceConsumptionNotice\)/);
  assert.match(runtime, /pendingEvidenceConsumptionNotices\.get\(event\.toolCallId\)/);
  assert.match(runtime, /pendingEvidenceConsumptionNotices\.delete\(event\.toolCallId\)/);
  assert.doesNotMatch(runtime, /const consumedEvidence = controller\.consumeEvidenceActionNotice\(\);/);
});


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

test('the coding session starts only once evidence is complete, never from an unprepared controller', () => {
  const unprepared = new ProgressController(stageConfig('implementer'), {});
  assert.equal(unprepared.checkToolCall('begin_coding_session', {}).block, true, 'preparation cannot be skipped');

  const exploring = new ProgressController(stageConfig('implementer'), {});
  exploring.applyPreparedImplementation({ status: 'prepared', plan: ['plan'], complexity: 'nontrivial', evidenceBudget: 2, largeMutation: false, reason: 'test' });
  assert.equal(exploring.productiveProgressState(), 'evidence_allowed');
  assert.match(exploring.checkToolCall('begin_coding_session', {}).reason, /only once evidence is complete/, 'no 16K during exploration');

  const ready = new ProgressController(stageConfig('implementer'), {});
  ready.applyPreparedImplementation({ status: 'fallback', failureClass: 'preparation_infrastructure_failure', reason: 'planner down' });
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
  assert.ok(!progress.codingSessionTools.includes('bash'), 'raw shell is not a coding-session cleanup capability');
  for (const tool of ['begin_coding_session', 'request_large_mutation_budget', 'subagent', 'subagents_enable', 'grep', 'find', 'ls']) {
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
let lastMetrics = [];
function runtimeScenario(mode) {
  const dir = tempDir();
  try {
    const context = path.join(dir, 'issue.json');
    const loader = path.join(dir, 'loader.mjs');
    const scenario = path.join(dir, 'scenario.mjs');
    const work = path.join(dir, 'work');
    const terminal = path.join(dir, 'terminal.json');
    const preparedFile = path.join(dir, 'prepared-implementation.json');
    const preparedBase = {
      version: 1,
      workspaceRoot: dir,
      freshBaseCommit: '',
      baseRef: 'origin/dev',
      layoutHint: ['no-submit-recovery', 'no-submit-recovery-dead-end'].includes(mode)
        ? {
            sourceRoot: '.',
            sourceDirectory: '.',
            sourceTarget: 'generated.py',
            sourceConvention: null,
            testDirectory: '.',
            testTarget: 'test_generated.py',
            testTargetRequired: true,
            testConvention: null,
          }
        : null,
      plannerUsage: null,
      plannerDurationMs: 1,
    };
    fs.writeFileSync(preparedFile, JSON.stringify(mode === 'fallback'
      ? { ...preparedBase, status: 'fallback', failureClass: 'preparation_infrastructure_failure', reason: 'planner down' }
      : { ...preparedBase, status: 'prepared', plan: ['Create generated.py'], complexity: 'nontrivial', evidenceBudget: 1, largeMutation: false, reason: 'One lookup' }));
    const resultFile = path.join(dir, 'implementer-result.json');
    const scopeFile = path.join(dir, 'accepted-scope.json');
    const runtimeFailure = path.join(dir, 'runtime-failure.json');
    const validationLedger = path.join(dir, 'validation.jsonl');
    const remote = path.join(dir, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    fs.mkdirSync(work);
    execFileSync('git', ['init', '-q', work]);
    execFileSync('git', ['-C', work, 'config', 'user.name', 'Coding Session Test']);
    execFileSync('git', ['-C', work, 'config', 'user.email', 'coding@example.invalid']);
    fs.writeFileSync(path.join(work, 'unchanged_helper.py'), 'HELPER = 1\n');
    execFileSync('git', ['-C', work, 'add', 'unchanged_helper.py']);
    execFileSync('git', ['-C', work, 'commit', '--allow-empty', '-qm', 'base']);
    execFileSync('git', ['-C', work, 'remote', 'add', 'origin', remote]);
    execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:refs/heads/dev']);
    execFileSync('git', ['-C', work, 'update-ref', 'refs/remotes/origin/dev', 'HEAD']);
    fs.writeFileSync(context, JSON.stringify({ title: 'Coding session smoke', body: 'Create generated.py and its test' }));
    fs.writeFileSync(loader, TYPEBOX_STUB_LOADER);
    fs.writeFileSync(scenario, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { EventEmitter } from 'node:events';
      const runtimeUrl = ${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)};
      const terminalReceiptUrl = ${JSON.stringify(new URL('../scripts/pi-common/terminal-receipt.mjs', import.meta.url).href)};
      const implementerResultUrl = ${JSON.stringify(new URL('../scripts/pi-common/implementer-result.mjs', import.meta.url).href)};
      const codingValidationUrl = ${JSON.stringify(new URL('../scripts/pi-common/coding-session-validation.mjs', import.meta.url).href)};
      const { default: runtime, providerErrorStatus } = await import(runtimeUrl);
      const { createSuccessfulTerminalReceipt, writeTerminalReceiptFile } = await import(terminalReceiptUrl);
      const { writeImplementerResult } = await import(implementerResultUrl);
      const { assertCodingBehavioralValidation, recordCodingBehavioralValidation } = await import(codingValidationUrl);
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
      const resultFile = ${JSON.stringify(resultFile)};
      const scopeFile = ${JSON.stringify(scopeFile)};
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
        'request_large_mutation_budget', 'begin_coding_session', 'rollback_last_mutation', 'repo_search', 'subagents_enable'];
      const persist = entry => fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\\n');
      persist({ type: 'session', id: 'parent' });
      persist({ type: 'message', message: { role: 'user', content: 'Implement issue: create generated.py and its test' } });
      const ctx = { cwd, model: { maxTokens: 32000 }, abort: () => { if (!['ceiling-draft', 'action-prose-abort', 'action-repeat-abort', 'action-hidden-abort', 'tool-contract', 'parent-contract', 'parent-contract-reverse', 'deferred-capability', 'deferred-then-removed', 'evidence-missing-executor', 'no-submit-recovery-dead-end'].includes(mode)) throw new Error('unexpected abort'); aborts++; },
        sessionManager: { getSessionId: () => 'parent', getSessionFile: () => (mode === 'no-session' ? null : sessionFile) } };
      const signal = new AbortController();
      const pi = {
        events: { on: (event, fn) => { bus.on(event, fn); return () => bus.off(event, fn); }, emit: (...args) => bus.emit(...args) },
        registerTool: tool => tools.set(tool.name, tool),
        on: (name, fn) => handlers.set(name, fn),
        appendEntry: () => {},
        getAllTools: () => [...new Set([...tools.keys(), 'read', 'write', 'edit', 'bash'])].filter(name => mode !== 'narrow-registry' || name !== 'bash').map(name => ({ name })),
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
        if (mode === 'narrow-registry') assert.ok(!definition.tools.includes('bash'), 'fork allowlist excludes unavailable registry tools');
        if (!definition) return respond(request, { status: 'failed', error: 'Unknown agent: ' + request.agent });
        if (fs.existsSync(cwd + '/.pi/agents/' + request.agent + '.md')) {
          return respond(request, { status: 'failed', error: "Runtime agent '" + request.agent + "' collides with configured agent '" + request.agent + "'." });
        }
        assert.deepEqual(definition.extensions, [controlScripts + '/pi-bash-timeout.mjs', controlScripts + '/pi-agent-runtime.mjs', controlScripts + '/pi-implementer-result-tool.mjs']);
        const inherited = fs.readFileSync(sessionFile, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
        const childTools = new Map(); const childHandlers = new Map();
        let childAborts = 0;
        const childCtx = { cwd, model: { maxTokens: 32000 }, abort: () => {
          if (!['tool-contract', 'repair-nonconvergent', 'repair-broad-rewrite-limit'].includes(mode)) throw new Error('fork aborted');
          childAborts += 1;
        },
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
        const firstActionPayload = {
          model: 'm',
          messages: [],
          tools: childActive.map(name => ({ type: 'function', function: { name } })),
        };
        const firstActionRequest = providerPatch({ payload: firstActionPayload }, childCtx);
        assert.equal(firstActionRequest.tool_choice, 'required', 'the first coding-session provider request is constrained immediately');
        const firstRequestTools = firstActionRequest.tools.map(tool => tool.function?.name ?? tool.name);
        assert.ok(firstRequestTools.includes('need_more_evidence'), 'bounded evidence transition remains reachable');
        assert.ok(!firstRequestTools.includes('read'), 'inherited parent read intent is not advertised on the first request');
        assert.ok(!firstRequestTools.includes('bash'), 'forbidden cleanup shell is not advertised on the first request');
        if (mode === 'incapable-repeat' || mode === 'incapable-transition') {
          // #396/#399: the fork was launched for cleanup that needs raw bash. The model omits
          // required_capability; the trusted surface still blocks bash inside the fork.
          childHandlers.get('turn_start')({ turnIndex: 0 });
          const blocked = await childHandlers.get('tool_call')({ toolName: 'bash', toolCallId: 'cleanup-bash', input: { command: 'rm -f stray.txt' } }, childCtx);
          assert.equal(blocked?.block, true, 'raw bash stays unavailable inside the coding session');
          if (mode === 'incapable-transition') await childHandlers.get('turn_end')({ turnIndex: 0, message: { usage: { input: 7, output: 1, totalTokens: 8 } } }, childCtx);
          return respond(request, { status: 'completed', result: { kind: 'text', value: 'cleanup needs bash' }, usage: { output: 100 } });
        }
        if (mode === 'malformed-contract') {
          const spec = JSON.parse(process.env.PI_CODING_SESSION);
          fs.writeFileSync(spec.failureFile, '{"failure_code":');
          return respond(request, { status: 'failed', error: 'original delegation failure' });
        }
        if (mode === 'fork-deferred-capability') {
          // #441: submit_result became active after this fork payload was assembled.
          const stale = childActive.filter(name => name !== 'submit_result');
          const assembled = providerPatch({ payload: { model: 'm', messages: [], tools: stale.map(name => ({ type: 'function', function: { name } })) } }, childCtx);
          assert.deepEqual(assembled.tools.map(tool => tool.function.name), stale, 'fork request does not advertise a late-active definition');
          const call = { toolName: 'submit_result', toolCallId: 'fork-deferred', isError: true, content: [{ type: 'text', text: 'Tool submit_result not found' }] };
          await childHandlers.get('tool_execution_end')({ ...call, result: { content: call.content } }, childCtx);
          const rewritten = await childHandlers.get('tool_result')(call, childCtx);
          assert.match(rewritten.content[0].text, /not executable in this response/);
          console.log('FORK_DEFERRED_CAPABILITY_OK');
        }
        if (mode === 'tool-contract') {
          // write is in the authoritative first-request snapshot, so a missing executor is a real contract failure.
          await childHandlers.get('tool_execution_end')({ toolName: 'write', isError: true, result: { content: [{ type: 'text', text: 'Tool write not found' }] } }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: 0, message: { usage: { input: 10, output: 2, totalTokens: 12 } } }, childCtx);
          return respond(request, { status: 'failed', error: 'nested executor unavailable', usage: { input: 50, output: 5, totalTokens: 55 } });
        }
        // Executors stubbed; the runtime's gates around them are real.
        const repairFailure = variant => {
          const volatile = variant === 'volatile-a' || variant === 'volatile-b';
          const semanticNumber = variant === 'semantic-42' || variant === 'semantic-43';
          const malformed = variant === 'malformed-initial' || variant === 'malformed-shrunk';
          const volatileMessage = variant === 'volatile-b'
            ? 'test_constant: mismatch at /tmp/pytest-987/result.txt after 84.75ms address 0xdeadbeef'
            : 'test_constant: mismatch at /tmp/pytest-123/result.txt after 12.50ms address 0xabc123';
          let diagnostics = malformed
            ? (variant === 'malformed-shrunk'
              ? [{ file: 'test_generated.py', line: 4, column: null, code: 'SyntaxError', message: 'unterminated string literal' }]
              : [
                  { file: 'test_generated.py', line: 4, column: null, code: 'SyntaxError', message: 'unterminated string literal' },
                  { file: 'test_generated.py', line: 8, column: null, code: 'SyntaxError', message: 'unexpected EOF while parsing' },
                ])
            : volatile
              ? [{ file: 'test_generated.py', line: 4, column: null, code: 'AssertionError', message: volatileMessage }]
              : semanticNumber
                ? [{ file: 'test_generated.py', line: 4, column: null, code: 'AssertionError', message: 'test_constant: expected ' + (variant === 'semantic-43' ? '43' : '42') }]
                : variant === 'shrunk'
                  ? [{ file: 'test_generated.py', line: 4, column: null, code: 'AssertionError', message: 'test_constant: expected required constant' }]
                  : [
                      { file: 'test_generated.py', line: 4, column: null, code: 'AssertionError', message: 'test_constant: expected required constant' },
                      { file: 'test_generated.py', line: 8, column: null, code: 'AssertionError', message: 'test_secondary: expected public restart behavior' },
                    ];
          if (mode === 'repair-evidence' && variant === 'initial') {
            diagnostics = [...diagnostics, {
              file: 'link-source.py',
              line: 1,
              column: null,
              code: 'AssertionError',
              message: 'symlinked source diagnostic',
            }];
          }
          return {
            status: 'fail',
            kind: 'pytest',
            exit_code: 1,
            duration_ms: 7,
            summary: variant === 'shrunk' || variant === 'malformed-shrunk' || volatile || semanticNumber ? '1 failed' : '2 failed',
            diagnostics,
            stdout_tail: '',
            stderr_tail: '',
            truncated: false,
          };
        };
        const repairPass = () => ({
          status: 'pass',
          kind: 'pytest',
          exit_code: 0,
          duration_ms: 5,
          summary: '1 passed',
          diagnostics: [],
          stdout_tail: '',
          stderr_tail: '',
          truncated: false,
        });
        const appendRepairRecord = (params, result) => {
          const records = fs.existsSync(process.env.PI_VALIDATION_LEDGER_FILE)
            ? fs.readFileSync(process.env.PI_VALIDATION_LEDGER_FILE, 'utf8').split('\\n').filter(Boolean)
            : [];
          fs.appendFileSync(process.env.PI_VALIDATION_LEDGER_FILE, JSON.stringify({
            seq: records.length,
            timestamp: new Date().toISOString(),
            kind: result.kind,
            scope: result.kind === 'pytest'
              ? { targets: params.targets }
              : result.kind === 'profile'
                ? { profile: params.profile }
                : { paths: params.paths },
            status: result.status,
            exit_code: result.exit_code,
            source: 'run_check',
            stage: 'implementer',
            backend: 'pi',
            run_id: process.env.PI_VALIDATION_RUN_ID,
            attempt_id: 'primary',
            diagnostics_count: result.diagnostics.length,
            summary: result.summary,
            infrastructure: null,
          }) + '\\n');
        };
        childTools.get('run_check').execute = async (_toolCallId, params) => {
          if (mode === 'repair-empty-scope' && params?.kind === 'profile') {
            const result = {
              status: 'fail',
              kind: 'profile',
              exit_code: 1,
              duration_ms: 3,
              summary: 'profile failed without structured diagnostics',
              diagnostics: [],
              stdout_tail: '',
              stderr_tail: '',
              truncated: false,
            };
            appendRepairRecord(params, result);
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
          }
          if (['repair-evidence', 'repair-nonconvergent', 'repair-pass-reset', 'repair-volatile-message', 'repair-semantic-number', 'repair-iserror-details', 'repair-broad-rewrite-limit'].includes(mode) && params?.kind === 'pytest') {
            const variant = mode === 'repair-volatile-message'
              ? 'volatile-a'
              : mode === 'repair-semantic-number'
                ? 'semantic-42'
                : mode === 'repair-broad-rewrite-limit'
                  ? 'malformed-initial'
                  : 'initial';
            const result = repairFailure(variant);
            appendRepairRecord(params, result);
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
          }
          if (['no-submit-recovery', 'no-submit-recovery-dead-end'].includes(mode) && params?.kind === 'pytest') {
            fs.appendFileSync(process.env.PI_VALIDATION_LEDGER_FILE, JSON.stringify({
              seq: 0,
              timestamp: new Date().toISOString(),
              kind: 'pytest',
              scope: { targets: params.targets },
              status: 'infra_error',
              exit_code: null,
              source: 'run_check',
              stage: 'implementer',
              backend: 'pi',
              run_id: process.env.PI_VALIDATION_RUN_ID,
              attempt_id: 'primary',
              diagnostics_count: 0,
              summary: 'unsupported check environment key: PI_TRUSTED_ACCEPTANCE_TARGETS',
              infrastructure: { component: 'sandbox', code: 'CHECK_ENV', command: 'trusted-run-check-executor' },
            }) + '\\n');
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'infra_error', infrastructure: { code: 'CHECK_ENV' } }) }] };
          }
          if (params?.kind === 'pytest') {
            recordCodingBehavioralValidation({
              scope: { targets: params.targets },
              result: { status: 'pass', kind: 'pytest' },
              env: process.env,
            });
          }
          return { content: [{ type: 'text', text: 'check passed' }] };
        };
        childTools.get('submit_result').execute = async () => {
          writeImplementerResult(resultFile, mode === 'blocked' ? {
            title: 'Blocked task',
            summary: 'The issue cannot be implemented under the supplied constraints.',
            outcome: 'blocked',
            changes: [],
            files: [],
            blocked_reason: 'A required behavior conflicts with a stated constraint.',
          } : {
            title: 't', summary: 's', changes: ['c'], files: ['generated.py', 'test_generated.py'],
            security_notes: 'n', limitations: 'n',
          });
          const receiptEnv = { ...process.env, PI_TERMINAL_RESULT_FILE: terminal };
          writeTerminalReceiptFile(
            terminal,
            createSuccessfulTerminalReceipt({ cwd, resultFile, env: receiptEnv }),
          );
          return { content: [{ type: 'text', text: 'submitted' }] };
        };
        let turn = 0;
        if (mode === 'fork-prose-force') {
          // Simulate the provider ignoring the first request's required tool choice.
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
          if (
            mode === 'repair-iserror-details' &&
            name === 'run_check' &&
            input?.kind === 'pytest' &&
            result?.details?.status === 'fail'
          ) {
            isError = true;
          }
          await childHandlers.get('tool_execution_end')({ ...event, isError, result }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 3000 } } }, childCtx);
          return result;
        };
        const settleRepairRetry = async variant => {
          childHandlers.get('turn_start')({ turnIndex: turn });
          const event = { toolName: 'retry_last_failed_check', toolCallId: 'repair-retry-' + turn, input: {} };
          const blocked = await childHandlers.get('tool_call')(event, childCtx);
          assert.equal(blocked, undefined, 'exact retry passes the real runtime gate');
          const result = variant === 'pass' ? repairPass() : repairFailure(variant);
          appendRepairRecord({ targets: ['test_generated.py'] }, result);
          await childHandlers.get('tool_execution_end')({ ...event, isError: false, result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
          } }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 800 } } }, childCtx);
          return result;
        };
        const settleSyntheticDifferentScopePass = async () => {
          childHandlers.get('turn_start')({ turnIndex: turn });
          const event = {
            toolName: 'run_check',
            toolCallId: 'different-scope-pass-' + turn,
            input: { kind: 'python_compile', paths: ['generated.py'] },
          };
          const result = {
            status: 'pass',
            kind: 'python_compile',
            exit_code: 0,
            duration_ms: 2,
            summary: 'Compiled cleanly',
            diagnostics: [],
            stdout_tail: '',
            stderr_tail: '',
            truncated: false,
          };
          appendRepairRecord({ paths: ['generated.py'] }, result);
          await childHandlers.get('tool_execution_end')({ ...event, isError: false, result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
          } }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, childCtx);
        };
        const settleSyntheticBroaderScopePass = async () => {
          childHandlers.get('turn_start')({ turnIndex: turn });
          const event = {
            toolName: 'run_check',
            toolCallId: 'broader-scope-pass-' + turn,
            input: { kind: 'pytest', targets: ['test_generated.py', 'test_other.py'] },
          };
          const result = repairPass();
          appendRepairRecord(event.input, result);
          await childHandlers.get('tool_execution_end')({ ...event, isError: false, result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
          } }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, childCtx);
        };
        if (mode === 'blocked') {
          await childCall('submit_result', { blocked_reason: 'A required behavior conflicts with a stated constraint.' });
          respond(request, { status: 'completed', result: { kind: 'text', value: 'blocked' }, usage: { output: 100 } });
          return;
        }
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
        const testSource = mode === 'repair-evidence'
          ? 'from generated import REQUIRED_CONSTANT\\nfrom unchanged_helper import HELPER\\n\\ndef test_constant():\\n    assert REQUIRED_CONSTANT == "' + constant + '"\\n'
          : 'from generated import REQUIRED_CONSTANT\\n\\ndef test_constant():\\n    assert REQUIRED_CONSTANT == "' + constant + '"\\n';
        await childCall('write', { path: 'test_generated.py', content: testSource });
        if (mode === 'repair-evidence') {
          const outside = cwd + '/../repair-outside-' + process.pid + '.py';
          fs.writeFileSync(outside, 'OUTSIDE = true\\n');
          fs.symlinkSync(outside, cwd + '/link-source.py');
        }
        if (mode === 'repair-broad-rewrite-limit') {
          const repairPayload = {
            model: 'm',
            messages: [],
            max_completion_tokens: 16384,
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          const repairRequest = providerPatch({ payload: repairPayload }, childCtx);
          assert.equal(repairRequest.chat_template_kwargs.enable_thinking, true);
          assert.equal(repairRequest.max_completion_tokens, 4096);

          const firstRewriteContent = 'from generated import REQUIRED_CONSTANT\\n\\ndef test_constant():\\n    assert REQUIRED_CONSTANT == "' + constant + '"\\n# one justified systemic rewrite\\n';
          const firstRewrite = await childCall('write', {
            path: 'test_generated.py',
            content: firstRewriteContent,
          });
          assert.equal(firstRewrite.block, undefined, 'malformed-file diagnostics allow one bounded whole-file rewrite');
          assert.equal(childAborts, 0);
          await settleRepairRetry('malformed-shrunk');
          assert.equal(childAborts, 0, 'strictly shrinking diagnostics do not themselves abort repair');

          const secondRewrite = await childCall('write', {
            path: 'test_generated.py',
            content: firstRewriteContent + '# second regeneration\\n',
          });
          assert.equal(secondRewrite.block, true, 'second whole-file rewrite is bounded even after strict failure reduction');
          assert.equal(childAborts, 1, 'bounded broad-rewrite guard aborts deterministically');
          assert.equal(fs.readFileSync(cwd + '/test_generated.py', 'utf8'), firstRewriteContent, 'aborted rewrite preserves the checkpoint');
          console.log('CODING_REPAIR_BROAD_REWRITE_LIMIT_OK');
          return respond(request, { status: 'failed', error: 'PI_CODING_REPAIR_BROAD_REWRITE_LIMIT', usage: { output: 3500 } });
        }

        if (mode === 'repair-empty-scope') {
          const hiddenGit = cwd + '/.git-hidden-repair-empty';
          fs.renameSync(cwd + '/.git', hiddenGit);
          try {
            await childCall('run_check', { kind: 'profile', profile: 'repair-empty' });
          } finally {
            fs.renameSync(hiddenGit, cwd + '/.git');
          }
        } else {
          await childCall('run_check', { kind: 'pytest', targets: ['test_generated.py'] });
        }
        if (mode === 'repair-evidence') {
          const repairPayload = {
            model: 'm',
            messages: [],
            max_completion_tokens: 16384,
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          const repairRequest = providerPatch({ payload: repairPayload }, childCtx);
          const repairTools = repairRequest.tools.map(tool => tool.function?.name ?? tool.name);
          assert.equal(repairRequest.tool_choice, 'required', 'failed validation requires one concrete repair action');
          assert.equal(repairRequest.chat_template_kwargs.enable_thinking, true, 'fresh authoritative repair enables bounded reasoning');
          assert.equal(repairRequest.max_completion_tokens, 4096, 'repair reasoning has a bounded ceiling');
          assert.ok(repairTools.includes('read'), 'bounded repair read is provider-visible');
          assert.ok(repairTools.includes('safe_edit'), 'localized mutation stays provider-visible');
          assert.ok(!repairTools.includes('repo_search'), 'repair does not reopen repository discovery');
          assert.ok(!repairTools.includes('need_more_evidence'), 'repair does not spend the generic evidence unlock');

          const unrelated = await childCall('read', { path: 'README.md' });
          assert.equal(unrelated.block, true);
          assert.match(unrelated.reason, /repair read is limited to the authoritative failing\\/changed paths/);

          const symlinkEscape = await childCall('read', { path: 'link-source.py' });
          assert.equal(symlinkEscape.block, true, 'diagnostic symlink escaping the worktree is never authorized');
          assert.ok(!symlinkEscape.reason.includes('link-source.py'), 'symlink escape is removed from the trusted repair path set');

          const boundedRead = await childCall('read', { path: 'test_generated.py' });
          assert.equal(boundedRead.block, undefined, 'failing test file can be read directly');
          const importedRead = await childCall('read', { path: 'unchanged_helper.py' });
          assert.equal(importedRead.block, undefined, 'one-hop imported unchanged source is admitted as bounded repair evidence');
          const exhaustedRead = await childCall('read', { path: 'generated.py' });
          assert.equal(exhaustedRead.block, true, 'repair read allowance remains bounded after readsRemaining is exhausted');

          const blockedRewrite = await childCall('write', {
            path: 'test_generated.py',
            content: testSource + '# broad rewrite should be rejected\\n',
          });
          assert.equal(blockedRewrite.block, true, 'localized diagnostics reject another full-file write');
          assert.match(blockedRewrite.reason, /use edit, safe_edit, or structural_edit/);
          assert.equal(fs.readFileSync(cwd + '/test_generated.py', 'utf8'), testSource, 'blocked rewrite preserves the current checkpoint');

          const targeted = await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 5,
            text: '# targeted repair',
          });
          assert.equal(targeted.block, undefined, 'bounded targeted repair remains allowed');
          const followupPayload = {
            model: 'm',
            messages: [],
            max_completion_tokens: 16384,
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          const followupRequest = providerPatch({ payload: followupPayload }, childCtx);
          assert.equal(followupRequest.chat_template_kwargs.enable_thinking, false, 'deterministic repair follow-up returns to low-overhead thinking');
          assert.equal(followupRequest.max_completion_tokens, 16384, 'repair follow-up keeps the normal coding ceiling');
          assert.ok(childActive.includes('retry_last_failed_check'), 'targeted repair re-enables exact retry');
          await settleRepairRetry('shrunk');
          assert.equal(childAborts, 0, 'a shrinking failure set remains repairable');
          console.log('CODING_REPAIR_EVIDENCE_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after shrinking repair proof', usage: { output: 3000 } });
        }

        if (mode === 'repair-nonconvergent') {
          const flipFlop = [
            ['shrunk', 'a strict reduction resets the non-improving count'],
            ['initial', 'expanding back to a seen failure set is non-improving but still below the bound'],
            ['shrunk', 'returning to the prior best set is not a new strict reduction'],
            ['initial', 'another expansion remains bounded but does not yet abort'],
            ['shrunk', 'the fifth non-improving failure reaches the bounded repair ceiling'],
          ];
          for (let index = 0; index < flipFlop.length; index++) {
            await settleSyntheticDifferentScopePass();
            await childCall('safe_edit', {
              path: 'test_generated.py',
              operation: 'insert_after',
              start_line: 4 + index,
              text: '# targeted repair round ' + (index + 1),
            });
            assert.ok(childActive.includes('retry_last_failed_check'));
            await settleRepairRetry(flipFlop[index][0]);
            assert.equal(
              childAborts,
              index === flipFlop.length - 1 ? 1 : 0,
              flipFlop[index][1],
            );
          }
          console.log('CODING_REPAIR_NONCONVERGENT_OK');
          return respond(request, { status: 'failed', error: 'PI_CODING_VALIDATION_NON_CONVERGENT', usage: { output: 5000 } });
        }

        if (mode === 'repair-volatile-message') {
          await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 4,
            text: '# volatile diagnostic retry',
          });
          assert.ok(childActive.includes('retry_last_failed_check'));
          await settleRepairRetry('volatile-b');
          assert.equal(childAborts, 0, 'volatile diagnostic values stay one semantic failure identity');
          console.log('CODING_REPAIR_VOLATILE_MESSAGE_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after volatile identity proof', usage: { output: 3000 } });
        }

        if (mode === 'repair-semantic-number') {
          await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 4,
            text: '# semantic number retry',
          });
          assert.ok(childActive.includes('retry_last_failed_check'));
          await settleRepairRetry('semantic-43');
          assert.equal(childAborts, 0);
          console.log('CODING_REPAIR_SEMANTIC_NUMBER_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after semantic-number identity proof', usage: { output: 3000 } });
        }

        if (mode === 'repair-iserror-details') {
          assert.ok(childActive.includes('read'), 'structured fail details open repair evidence even when transport marks the tool errored');
          const readAfterErroredFail = await childCall('read', { path: 'test_generated.py' });
          assert.equal(readAfterErroredFail.block, undefined);
          console.log('CODING_REPAIR_ISERROR_DETAILS_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after isError repair proof', usage: { output: 3000 } });
        }

        if (mode === 'repair-empty-scope') {
          const repairPayload = {
            model: 'm',
            messages: [],
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          const repairRequest = providerPatch({ payload: repairPayload }, childCtx);
          const repairTools = repairRequest.tools.map(tool => tool.function?.name ?? tool.name);
          assert.ok(!repairTools.includes('read'), 'an empty trusted repair scope does not expose a read that can only dead-end');
          const repairWrite = await childCall('write', {
            path: 'test_generated.py',
            content: testSource + '# repair without bounded evidence path\\n',
          });
          assert.equal(repairWrite.block, undefined, 'empty repair evidence releases the read-before-mutation gate');
          console.log('CODING_REPAIR_EMPTY_SCOPE_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after empty-scope recovery proof', usage: { output: 3000 } });
        }

        if (mode === 'repair-pass-reset') {
          await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 4,
            text: '# pass reset',
          });
          assert.ok(childActive.includes('retry_last_failed_check'));
          await settleSyntheticBroaderScopePass();
          assert.equal(childAborts, 0);

          await childCall('write', {
            path: 'test_generated.py',
            content: 'from generated import REQUIRED_CONSTANT\\n\\ndef test_constant():\\n    assert REQUIRED_CONSTANT == "' + constant + '"\\n# fail again after covering pass\\n',
          });
          await childCall('run_check', { kind: 'pytest', targets: ['test_generated.py'] });
          assert.equal(childAborts, 0, 'provably covering same-kind pass clears prior convergence history');
          console.log('CODING_REPAIR_PASS_RESET_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after covering-scope reset proof', usage: { output: 3000 } });
        }

        if (!['no-submit', 'no-submit-parent-submit', 'no-submit-recovery', 'no-submit-recovery-dead-end'].includes(mode)) await childCall('submit_result', { title: 't', summary: 's', changes: ['c'], files: ['generated.py', 'test_generated.py'], security_notes: 'n', limitations: 'n' });
        if (['no-submit-recovery', 'no-submit-recovery-dead-end'].includes(mode)) {
          respond(request, {
            status: 'failed',
            error: 'PI_ACTION_REQUIRED_ABORT: simulated child abort after deterministic CHECK_ENV',
            usage: { output: 9000 },
          });
        } else {
          respond(request, { status: 'completed', result: { kind: 'text', value: 'done' }, usage: { output: 9000 } });
        }
      }
      bus.on('prompt-template:subagent:request', async request => {
        assert.notEqual(request.agent, 'implementation-planner', 'planning runs in the bootstrap session, never in the main one');
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
      if (mode === 'bash-error-mutates' || mode === 'bash-error-unknown') {
        process.env.PI_CODING_SESSION_USED = 'true';
        const changedFiles = ['src/game.py', 'tests/test_game.py'];
        recordCodingBehavioralValidation({
          scope: { targets: ['tests/test_game.py'] },
          result: { status: 'pass', kind: 'pytest' },
          env: process.env,
          cwd,
        });
        assert.doesNotThrow(() => assertCodingBehavioralValidation({ changedFiles, env: process.env }));

        handlers.get('turn_start')({ turnIndex: 0 });
        const bashEvent = {
          toolName: 'bash',
          toolCallId: 'failed-bash-validation',
          input: { command: 'git status --short -- generated.py' },
        };
        assert.equal(await handlers.get('tool_call')(bashEvent, ctx), undefined, 'bounded bash reaches execution');
        let hiddenGit = null;
        if (mode === 'bash-error-mutates') {
          fs.writeFileSync(cwd + '/bash-mutated.txt', 'changed\\n');
        } else {
          hiddenGit = cwd + '/.git-hidden-for-test';
          fs.renameSync(cwd + '/.git', hiddenGit);
        }
        try {
          await handlers.get('tool_execution_end')({
            ...bashEvent,
            isError: true,
            result: { content: [{ type: 'text', text: 'command failed after execution' }] },
          }, ctx);
        } finally {
          if (hiddenGit && fs.existsSync(hiddenGit)) fs.renameSync(hiddenGit, cwd + '/.git');
        }
        assert.throws(
          () => assertCodingBehavioralValidation({ changedFiles, env: process.env }),
          /TARGETED_BEHAVIORAL_VALIDATION_REQUIRED/,
          'failed bash must invalidate stale pytest evidence when the worktree changed or fingerprint is unknown',
        );
        console.log(mode === 'bash-error-mutates' ? 'FAILED_BASH_MUTATION_INVALIDATED' : 'FAILED_BASH_UNKNOWN_INVALIDATED');
        process.exit(0);
      }

      if (mode === 'parent-contract' || mode === 'parent-contract-reverse') {
        const resultEvent = { toolCallId: 'missing-bash', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'Tool bash not found' }] };
        const executionEvent = { ...resultEvent, result: { content: resultEvent.content } };
        const hooks = mode === 'parent-contract' ? ['tool_result', 'tool_execution_end'] : ['tool_execution_end', 'tool_result'];
        for (const hook of hooks) await handlers.get(hook)(hook === 'tool_result' ? resultEvent : executionEvent, ctx);
        assert.equal(aborts, 1);
        const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
        assert.equal(failure.failure_class, 'infrastructure');
        assert.equal(failure.failure_code, 'PI_TOOL_CONTRACT_FAILURE');
        assert.equal(sessionRequests.length, 0);
        process.exit(0);
      }
      // pi assembles the payload from the active surface; the runtime's own sync may only shrink it here.
      const unarmedPayload = { model: 'm', messages: [], tools: active.filter(name => name !== 'run_check').map(name => ({ type: 'function', function: { name } })) };
      const firstParentRequest = handlers.get('before_provider_request')({ payload: unarmedPayload }, ctx);
      if (mode === 'restored') {
        assert.equal(firstParentRequest.tool_choice, 'required', 'direct action_required startup constrains the first parent request');
      } else {
        assert.equal(firstParentRequest, unarmedPayload, 'preparation-phase parent request is unchanged');
      }
      const filteredPayload = handlers.get('before_provider_request')({ payload: { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'invented_tool' } }] } }, ctx);
      assert.deepEqual(filteredPayload.tools, [], 'provider never advertises a non-active tool');
      if (mode === 'deferred-capability' || mode === 'deferred-then-removed') {
        // #441: submit_result became active after pi assembled this payload.
        handlers.get('turn_start')({ turnIndex: 0 });
        const stale = active.filter(name => name !== 'submit_result');
        const assembled = handlers.get('before_provider_request')({ payload: { model: 'm', messages: [], tools: stale.map(name => ({ type: 'function', function: { name } })) } }, ctx);
        assert.deepEqual(assembled.tools.map(tool => tool.function.name), stale, 'a late-active definition is not added to the assembled request');
        assert.ok(active.includes('submit_result'), 'the live surface keeps the expansion for the next request');

        // The model calls the deferred tool anyway; pi resolves calls against this turn's context.
        const deferredCall = { toolName: 'submit_result', toolCallId: 'deferred-call', isError: true, content: [{ type: 'text', text: 'Tool submit_result not found' }] };
        await handlers.get('tool_execution_end')({ ...deferredCall, result: { content: deferredCall.content } }, ctx);
        const deferredResult = await handlers.get('tool_result')(deferredCall, ctx);
        assert.equal(aborts, 0, 'a deferred tool call is a lifecycle mismatch, not an infrastructure failure');
        assert.equal(fs.existsSync(runtimeFailure), false);
        assert.match(deferredResult.content[0].text, /became active after provider request \\d+ was built.*Do not retry it in this response.*call it only if that request exposes it/s);
        assert.doesNotMatch(deferredResult.content[0].text.split('CURRENTLY EXPOSED TOOLS')[1], /submit_result/, 'guidance names only this request surface');
        const lifecycleSteers = steers.filter(text => /submit_result became active after provider request/.test(text));
        assert.equal(lifecycleSteers.length, 1, 'one lifecycle steer reaches the next request even though pi skips tool_result');
        assert.match(lifecycleSteers[0], /Do not retry it in this response.*call it only if that request exposes it/s, 'the steer is conditional on the next request snapshot');
        assert.doesNotMatch(lifecycleSteers[0], /executable from|onward/, 'the steer does not promise the next request surface');

        if (mode === 'deferred-then-removed') {
          // Another tool in the same response changes state and removes the deferred tool again.
          pi.setActiveTools(active.filter(name => name !== 'submit_result'));
          handlers.get('turn_start')({ turnIndex: 1 });
          const next = handlers.get('before_provider_request')({ payload: { model: 'm', messages: [], tools: active.map(name => ({ type: 'function', function: { name } })) } }, ctx);
          assert.ok(!next.tools.some(tool => tool.function.name === 'submit_result'), 'the next request does not expose the removed tool');
          // The model follows the old deferral anyway: neither executable nor deferred now.
          const stale = { toolName: 'submit_result', toolCallId: 'stale-deferred', isError: true, content: [{ type: 'text', text: 'Tool submit_result not found' }] };
          const staleResult = await handlers.get('tool_result')(stale, ctx);
          assert.equal(aborts, 0, 'a call that follows stale deferral is not an infrastructure failure');
          assert.match(staleResult.content[0].text, /BLOCKED: submit_result is not exposed/);
          assert.doesNotMatch(staleResult.content[0].text.split('CURRENTLY EXPOSED TOOLS')[1], /submit_result/);
          assert.equal(steers.filter(text => /submit_result became active/.test(text)).length, 1, 'no new lifecycle promise for a tool that is no longer deferred');
          console.log('DEFERRED_THEN_REMOVED_OK');
          process.exit(0);
        }

        // Neither executable nor deferred: an ordinary unavailable-tool attempt.
        const ghost = { toolName: 'ghost_tool', toolCallId: 'ghost', isError: true, content: [{ type: 'text', text: 'Tool ghost_tool not found' }] };
        const ghostResult = await handlers.get('tool_result')(ghost, ctx);
        assert.equal(aborts, 0);
        assert.match(ghostResult.content[0].text, /BLOCKED: ghost_tool is not exposed/);

        // Next request boundary: pi's rebuilt turn context carries the tool.
        handlers.get('turn_start')({ turnIndex: 1 });
        const next = handlers.get('before_provider_request')({ payload: { model: 'm', messages: [], tools: active.map(name => ({ type: 'function', function: { name } })) } }, ctx);
        assert.ok(next.tools.some(tool => tool.function.name === 'submit_result'), 'deferred tool is executable from the next request');

        // An advertised tool that pi cannot execute remains a hard contract failure.
        await handlers.get('tool_result')({ toolName: 'submit_result', toolCallId: 'advertised-missing', isError: true, content: [{ type: 'text', text: 'Tool submit_result not found' }] }, ctx);
        assert.equal(aborts, 1, 'advertised-but-non-executable tool still aborts as infrastructure');
        const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
        assert.equal(failure.failure_code, 'PI_TOOL_CONTRACT_FAILURE');
        assert.equal(failure.tool, 'submit_result');
        console.log('DEFERRED_CAPABILITY_OK');
        process.exit(0);
      }
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
        // Born prepared from the bootstrap artifact: no preparation tool call exists.
        assert.equal(tools.has('prepare_implementation'), false);
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

      if (mode === 'evidence-missing-executor') {
        await call('need_more_evidence', {
          missing: 'Exact import anchor required for the next edit.',
          reason: 'One source lookup is required before mutating.',
        });

        handlers.get('turn_start')({ turnIndex: turn });
        const providerPayload = {
          model: 'm',
          messages: [],
          tools: active.map(name => ({ type: 'function', function: { name } })),
        };
        const request = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
        assert.ok(request.tools.some(tool => tool.function.name === 'read'), 'the unlocked evidence request advertises read');

        const failedRead = { toolName: 'read', toolCallId: 'missing-evidence-read', input: { path: 'src/missing.py' } };
        assert.equal(await handlers.get('tool_call')(failedRead, ctx), undefined, 'evidence read is accepted before executor failure');
        await handlers.get('tool_execution_end')({
          ...failedRead,
          isError: true,
          result: { content: [{ type: 'text', text: 'Tool read not found' }] },
        }, ctx);
        assert.equal(aborts, 1, 'advertised missing executor remains an infrastructure abort');

        handlers.get('turn_start')({ turnIndex: turn + 1 });
        const retryPayload = {
          model: 'm',
          messages: [],
          tools: active.map(name => ({ type: 'function', function: { name } })),
        };
        const retryRequest = handlers.get('before_provider_request')({ payload: retryPayload }, ctx);
        assert.ok(retryRequest.tools.some(tool => tool.function.name === 'read'), 'runtime restored the same evidence permit after executor rejection');
        assert.equal(
          await handlers.get('tool_call')({ toolName: 'read', toolCallId: 'retry-evidence-read', input: { path: 'src/missing.py' } }, ctx),
          undefined,
          'restored evidence action is executable without a second need_more_evidence call',
        );
        console.log('EVIDENCE_MISSING_EXECUTOR_PERMIT_RESTORED');
        process.exit(0);
      }

      if (mode === 'elevated-evidence-write') {
        await call('accept_mutation_scope', {
          paths: ['same-turn-large.py'],
          disposition: 'publishable',
          rationale: 'Regression fixture for elevated evidence followed by a real mutation in one response.',
        });
        await call('request_large_mutation_budget', { reason: 'exercise same-turn evidence plus mutation' });
        assert.equal(caps.at(-1), 16384, 'manual elevated grant applies to the next response');

        handlers.get('turn_start')({ turnIndex: turn });
        const sameTurnCall = async (name, input) => {
          const event = { toolName: name, toolCallId: 'same-turn-' + name + '-' + turn, input };
          assert.equal(await handlers.get('tool_call')(event, ctx), undefined, name + ' was blocked in elevated response');
          let result;
          if (tools.has(name)) {
            result = await tools.get(name).execute(event.toolCallId, input, signal.signal, null, ctx);
          } else if (name === 'write') {
            fs.writeFileSync(cwd + '/' + input.path, input.content);
            result = { content: [{ type: 'text', text: 'ok' }] };
          } else {
            result = { content: [{ type: 'text', text: 'ok' }] };
          }
          await handlers.get('tool_execution_end')({ ...event, isError: false, result }, ctx);
          return result;
        };

        await sameTurnCall('need_more_evidence', {
          missing: 'one final implementation fact',
          reason: 'exercise bounded evidence unlock inside the elevated response',
        });
        await sameTurnCall('write', { path: 'same-turn-large.py', content: 'VALUE = 1\\n' });
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 1000 } } }, ctx);

        handlers.get('turn_start')({ turnIndex: turn });
        const regrant = await handlers.get('tool_call')({
          toolName: 'request_large_mutation_budget',
          toolCallId: 'regrant-' + turn,
          input: { reason: 'prove the prior one-shot grant was consumed' },
        }, ctx);
        assert.equal(regrant, undefined, 'same-turn evidence + mutation consumes the prior elevated grant instead of leaking it');
        console.log('ELEVATED_EVIDENCE_WRITE_CONSUMED_OK');
        process.exit(0);
      }

      if (mode === 'scope-prelude-cap') {
        await call('request_large_mutation_budget', { reason: 'large generated module' });
        assert.equal(caps.at(-1), 16384, 'large mutation grant raises the next response cap');
        await call('accept_mutation_scope', {
          paths: ['first-large.py'],
          disposition: 'publishable',
          rationale: 'Issue requires the large generated implementation file.',
        });
        assert.equal(caps.at(-1), 16384, 'one scope prelude preserves the elevated cap');

        handlers.get('turn_start')({ turnIndex: turn });
        const secondPrelude = await handlers.get('tool_call')({
          toolName: 'accept_mutation_scope',
          toolCallId: 'scope-repeat-' + turn,
          input: {
            paths: ['second-large.py'],
            disposition: 'publishable',
            rationale: 'Attempt a second declaration under the same elevated grant.',
          },
        }, ctx);
        assert.equal(secondPrelude.block, true);
        assert.match(secondPrelude.reason, /already used its one accept_mutation_scope prelude/);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        console.log('SCOPE_PRELUDE_CAP_OK');
        process.exit(0);
      }

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
          // One genuine completion of a one-shot control transition, in its own turn, so its repeat is a no-op.
          handlers.get('turn_start')({ turnIndex: turn });
          const firstEnable = { toolName: 'subagents_enable', toolCallId: 'first-' + turn, input: {} };
          assert.equal(await handlers.get('tool_call')(firstEnable, ctx), undefined);
          await handlers.get('tool_execution_end')({ ...firstEnable, isError: false, result: { content: [{ type: 'text', text: 'ok' }] } }, ctx);
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
          handlers.get('turn_start')({ turnIndex: turn });
          const repeated = await handlers.get('tool_call')({
            toolName: 'subagents_enable',
            toolCallId: 'repeat-' + turn,
            input: {},
          }, ctx);
          assert.ok(repeated?.alreadySatisfied || /already/i.test(String(repeated?.reason ?? '')), 'repeat is rejected as already completed');
          assert.match(String(repeated.reason), /CURRENTLY EXPOSED TOOLS/);
          const afterRepeat = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(afterRepeat.tool_choice, undefined, 'an emitted tool call consumes provider forcing even when it is a no-op');
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
          assert.equal(aborts, 0, 'one no-op repeat is a single strike');
          handlers.get('turn_start')({ turnIndex: turn });
          const again = await handlers.get('tool_call')({ toolName: 'subagents_enable', toolCallId: 'repeat-again-' + turn, input: {} }, ctx);
          assert.equal(again.block, true);
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
          assert.equal(aborts, 1, 'repeated already-satisfied calls still count as no productive action and trip the watchdog');
          process.exit(0);
        }

        if (mode === 'action-hidden-abort') {
          // #469 exact lifecycle: one blocker opens one evidence action, then both read and
          // repeated need_more_evidence disappear until productive progress occurs.
          fs.writeFileSync(cwd + '/evidence.txt', 'exact import anchor\\n');
          await call('need_more_evidence', {
            missing: 'Read evidence.txt to obtain the exact import anchor needed for the edit.',
            reason: 'The exact import anchor is the only unresolved implementation fact.',
          });
          await call('read', { path: 'evidence.txt' });
          fs.rmSync(cwd + '/evidence.txt');

          const consumedSteer = steers.findLast(text => /RUNTIME EVIDENCE PERMIT CONSUMED/.test(text));
          assert.ok(consumedSteer, 'runtime emits an explicit consumed-permit steer');
          assert.ok(consumedSteer.includes('read/search evidence and repeated need_more_evidence are unavailable'));
          assert.ok(!active.includes('read'), 'read is removed after the single evidence action');
          assert.ok(!active.includes('need_more_evidence'), 'blocker is removed until productive progress');

          const staleAttempts = [
            { toolName: 'read', input: { path: 'evidence.txt' }, kind: 'unavailable' },
            {
              toolName: 'need_more_evidence',
              input: {
                missing: 'Read evidence.txt for another fact.',
                reason: 'Attempt a second evidence unlock without productive progress.',
              },
              kind: 'stale',
            },
            { toolName: 'read', input: { path: 'evidence.txt' }, kind: 'unavailable' },
            { toolName: 'read', input: { path: 'evidence.txt' }, kind: 'unavailable' },
          ];
          for (let index = 0; index < staleAttempts.length; index += 1) {
            const attempt = staleAttempts[index];
            handlers.get('turn_start')({ turnIndex: turn });
            const hidden = await handlers.get('tool_call')({
              toolName: attempt.toolName,
              input: attempt.input,
              toolCallId: 'hidden-' + attempt.toolName + '-' + turn,
            }, ctx);
            assert.equal(hidden.block, true);
            if (attempt.kind === 'unavailable') {
              assert.match(hidden.reason, /not currently exposed/);
            } else {
              assert.match(hidden.reason, /capability lifecycle changed/);
              assert.match(hidden.reason, /Do not retry the stale call/);
            }
            assert.match(hidden.reason, /CURRENTLY EXPOSED TOOLS/);
            await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
            assert.equal(
              aborts,
              index === staleAttempts.length - 1 ? 1 : 0,
              'stale lifecycle races reset the strike streak; only two later genuine unavailable turns abort',
            );
          }

          const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
          assert.equal(failure.failure_class, 'model_execution_abort');
          assert.equal(failure.failure_code, 'PI_UNAVAILABLE_CAPABILITY_ABORT');
          assert.ok(failure.reason.includes('unavailable capability'));
          console.log('UNAVAILABLE_CAPABILITY_FAILURE ' + JSON.stringify(failure));
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
      if (mode === 'forbidden-capability') {
        await assert.rejects(
          () => tools.get('begin_coding_session').execute('forbidden-capability', {
            reason: 'Need shell cleanup',
            required_capability: 'bash',
          }, signal.signal, null, ctx),
          /cannot expose required capability "bash"/,
        );
        assert.equal(sessionRequests.length, 0, 'incapable fork is rejected before launch');
        process.exit(0);
      }
      if (mode === 'incapable-repeat' || mode === 'incapable-transition') {
        const first = await call('begin_coding_session', { reason: 'Clean up the stray file' });
        assert.match(first.content[0].text, /ended without submit_result/);
        assert.equal(fs.existsSync(sessionRequests[0].spec.capabilityFile), false, 'capability sidecar is consumed');
        // An arbitrary worktree change is not a material transition: bash is still unreachable.
        fs.writeFileSync(cwd + '/stray.txt', 'accidental\\n');
        if (mode === 'incapable-transition') {
          // A successful trusted recovery transition resolves the cleanup the fork needed bash for.
          active = [...active, 'recover_worktree'];
          process.env.PI_VALIDATION_LEDGER_FILE = sessionFile + '.ledger.jsonl';
          // Run-start baseline (#438): stray.txt appeared after it, so ownership is provable.
          process.env.PI_WORKTREE_BASELINE_FILE = sessionFile + '.baseline.json';
          fs.writeFileSync(process.env.PI_WORKTREE_BASELINE_FILE, JSON.stringify({ schema_version: 2, untracked: [], tracked_dirty: [] }));
          await call('recover_worktree', { action: 'delete_untracked', path: 'stray.txt', expected_files: [], reason: 'Remove the accidental file without a shell' });
          assert.equal(fs.existsSync(cwd + '/stray.txt'), false);
          await tools.get('begin_coding_session').execute('after-transition', { reason: 'Retry after recovery' }, signal.signal, null, ctx);
          assert.equal(sessionRequests.length, 2, 'fork launches again after a trusted recovery transition');
          console.log('INCAPABLE_FORK_TRANSITION_OK');
          process.exit(0);
        }
        await assert.rejects(
          () => tools.get('begin_coding_session').execute('repeat', { reason: 'Try the cleanup again' }, signal.signal, null, ctx),
          /attempting bash, which the coding session can never expose.*An equivalent session was not launched/s,
        );
        assert.equal(sessionRequests.length, 1, 'equivalent incapable fork is rejected before launch, even after an unrelated file write');
        assert.ok(!registered.get('implementer-coding-session').tools.includes('bash'), 'no unrestricted shell is added to the fork');
        console.log('INCAPABLE_FORK_REPEAT_REJECTED_OK');
        process.exit(0);
      }
      const expectError = { cancel: /aborted/, 'no-session': /cannot continue as a coding session/, 'shadow-agent': /collides with configured agent/, 'tool-contract': /PI_TOOL_CONTRACT_FAILURE/, 'malformed-contract': /original delegation failure/ }[mode] ?? null;
      const result = await call('begin_coding_session', { reason: 'Implement generated.py and its test' }, { expectError });
      if (mode === 'malformed-contract') {
        assert.equal(aborts, 0);
        assert.equal(sessionRequests.length, 1);
        assert.equal(fs.existsSync(sessionRequests[0].spec.failureFile), false);
        assert.equal(fs.existsSync(runtimeFailure), false);
        process.exit(0);
      }
      if (mode === 'tool-contract') {
        assert.equal(aborts, 1, 'nested contract failure aborts the parent immediately');
        const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
        assert.equal(failure.failure_class, 'infrastructure');
        assert.equal(failure.failure_code, 'PI_TOOL_CONTRACT_FAILURE');
        assert.equal(failure.tool, 'write');
        assert.equal(sessionRequests.length, 1, 'no additional coding session burned on an unavailable executor');
        assert.equal(fs.existsSync(terminal), false, 'a contract failure never submits');
        process.exit(0);
      }
      assert.equal(process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, '2048', 'parent child-budget mirror restored');
      assert.ok(!process.env.PI_CODING_SESSION, 'coding-session mode is scoped to the fork');
      if (sessionRequests.length) {
        assert.equal(process.env.PI_CODING_SESSION_USED, 'true', 'parent retains the durable coding-lifecycle validation marker');
      }
      if (mode === 'blocked') {
        assert.equal(result.terminate, true, 'a valid blocked terminal receipt ends the parent coding action');
        assert.equal(result.details.outcome, 'blocked');
        assert.equal(result.details.successful_final_submission, false);
        assert.match(result.content[0].text, /blocked outcome/);
        assert.match(result.content[0].text, /implementation was not completed/);
        assert.doesNotMatch(result.content[0].text, /work is done/i);
        assert.match(fs.readFileSync(resultFile, 'utf8'), /"outcome": "blocked"/);
        process.exit(0);
      }
      assert.ok(caps.filter(cap => cap !== 32000).every(cap => cap === 2048), 'parent stays at 2048: ' + caps);
      if (mode === 'no-session') assert.equal(sessionRequests.length, 0, 'no fresh-prompt fallback');
      else {
        assert.equal(sessionRequests.length, 1);
        assert.equal(sessionRequests[0].maxTokens, '16384');
        assert.equal(sessionRequests[0].spec.maxTokens, 16384);
        assert.doesNotMatch(sessionRequests[0].task, /abc123/, 'the constant is NOT handed over in the request');
      }
      if (['flow', 'fallback', 'restored', 'tampered', 'containment', 'no-submit', 'no-submit-parent-submit'].includes(mode)) {
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
      if (['no-submit-recovery', 'no-submit-recovery-dead-end'].includes(mode)) {
        assert.notEqual(result.terminate, true);
        assert.deepEqual(result.details.recovery_receipt, {
          coding_session_status: 'aborted',
          changed_publishable_paths: ['generated.py', 'test_generated.py'],
          prepared_outputs_present: { source: true, test: true },
          last_validation: { kind: 'pytest', status: 'infra_error', infrastructure_code: 'CHECK_ENV' },
          remaining_terminal_obligation: 'validation',
        });
        assert.match(result.content[0].text, /Trusted recovery receipt/);
        assert.match(result.content[0].text, /do not rewrite completed prepared outputs/);
        assert.doesNotMatch(result.content[0].text, /You may call begin_coding_session once more/);
        assert.ok(active.includes('need_more_evidence'), 'parent retains a bounded evidence path for one concrete recovery inspection');
        assert.ok(!active.includes('begin_coding_session'), 'parent cannot blindly launch a second fork while complete child outputs are protected');
        assert.ok(!active.includes('write'), 'parent cannot blindly rewrite complete child outputs');
        assert.equal(sessionRequests.length, 1, 'recovery does not blindly launch another coding session');

        handlers.get('turn_start')({ turnIndex: turn });
        const genericSubmit = {
          toolName: 'submit_result',
          toolCallId: 'generic-recovery-submit-' + turn,
          input: {
            title: 'Recovered child work',
            summary: 'Attempt publication without new evidence.',
            changes: ['Keep existing recovered source and test.'],
            files: ['generated.py', 'test_generated.py'],
            security_notes: 'No security impact.',
            limitations: 'Validation infrastructure is unavailable.',
          },
        };
        assert.equal(await handlers.get('tool_call')(genericSubmit, ctx), undefined);
        await handlers.get('tool_execution_end')({
          ...genericSubmit,
          isError: true,
          result: { content: [{ type: 'text', text: 'transient terminal submission failure' }] },
        }, ctx);
        assert.ok(!active.includes('begin_coding_session'), 'generic terminal errors do not release the recovery guard');
        assert.ok(!active.includes('write'), 'generic terminal errors do not reopen blind mutation');
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);

        handlers.get('turn_start')({ turnIndex: turn });
        const blindFork = await handlers.get('tool_call')({
          toolName: 'begin_coding_session',
          toolCallId: 'blind-recovery-fork-' + turn,
          input: {},
        }, ctx);
        assert.equal(blindFork.block, true);
        assert.match(blindFork.reason, /not currently exposed|capability lifecycle changed/);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);

        if (mode === 'no-submit-recovery-dead-end') {
          active = active.filter(name => name !== 'run_check');
          pi.setActiveTools(active);
          await call('need_more_evidence', {
            missing: 'Inspect the recovered implementation before deciding whether any rewrite is required.',
            reason: 'Exercise the single recovery evidence permit with validation unavailable.',
          });
          await call('read', { path: 'README.md' });
          assert.equal(aborts, 1, 'unrelated evidence plus unavailable validation fails closed instead of reopening mutation');
          const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
          assert.equal(failure.failure_code, 'PI_CODING_RECOVERY_BLOCKED');
          assert.equal(failure.checkpoint.worktree_preserved, true);
          assert.ok(!active.includes('begin_coding_session'));
          assert.ok(!active.includes('write'));
          console.log('CODING_RECOVERY_FAIL_CLOSED_OK ' + JSON.stringify(failure));
          process.exit(0);
        }

        await call('need_more_evidence', {
          missing: 'Inspect the already-created source before deciding whether any parent-side mutation is required.',
          reason: 'The child left complete prepared outputs; one bounded read is enough to recover exact state.',
        });
        const recovered = await call('read', { path: 'generated.py' });
        assert.match(recovered.content[0].text, /REQUIRED_CONSTANT/);
        console.log('CODING_RECOVERY_RECEIPT_OK ' + JSON.stringify(result.details.recovery_receipt));
        console.log('CODING_RECOVERY_BOUNDED_INSPECTION_OK');
      }
      if (mode === 'no-submit-parent-submit') {
        assert.notEqual(result.terminate, true);
        assert.match(result.content[0].text, /ended without submit_result/);
        // Production launches pi-run-stage from the issue worktree. This scenario
        // normally stays in the control checkout so it can exercise trusted
        // runtime modules, but the real parent submit_result uses process.cwd()
        // for integrateLatestDev()/git publication checks. Match production here.
        process.chdir(cwd);
        assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(cwd));
        await call('submit_result', {
          title: 'Parent submit',
          summary: 'Publish coding-session changes from the parent.',
          changes: ['Add generated implementation and test'],
          files: ['generated.py', 'test_generated.py'],
          security_notes: 'No security impact.',
          limitations: 'None.',
        });
        const metadata = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        assert.equal(metadata.scope_enforcement, 'predeclared');
        assert.deepEqual(metadata.accepted_scope.accepted.map(entry => entry.path), ['generated.py', 'test_generated.py']);
        console.log('PARENT_SUBMIT_AFTER_FORK_OK');
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
        PI_IMPLEMENTER_RESULT_FILE: resultFile, PI_ACCEPTED_MUTATION_SCOPE_FILE: scopeFile,
        PI_RESUME_ACTIVE: mode === 'restored' ? 'true' : 'false', PI_VALIDATION_REPAIR: 'false',
        PI_PREPARED_IMPLEMENTATION_FILE: preparedFile,
        PI_VALIDATION_LEDGER_FILE: validationLedger, PI_VALIDATION_RUN_ID: 'issue-481-run',
        PI_SUBAGENT_RESPONSE_MAX_TOKENS: '2048', PI_CODING_SESSION: '', PI_RUNTIME_FAILURE_FILE: runtimeFailure,
        PI_METRICS_FILE: path.join(dir, 'metrics.jsonl'), PI_ISSUE: '7', PI_PHASE: 'implementation' },
    });
    const metricsFile = path.join(dir, 'metrics.jsonl');
    lastMetrics = fs.existsSync(metricsFile)
      ? fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout + result.stderr;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('2K parent -> begin_coding_session -> 16K same-context fork writes code + tests, checks, submits; parent ends', () => {
  const logs = runtimeScenario('flow');
  assert.match(logs, /PI_CODING_SESSION \{"phase":"agent_registered".*"source":"runtime","thinking":"off"/);
  assert.match(logs, /\[PI\]\[coding\] phase=agent_registered/);
  assert.match(logs, /"phase":"requested".*"parentMaxTokens":2048,"codingMaxTokens":16384/);
  assert.match(logs, /"phase":"started".*"context":"fork","agent":"implementer-coding-session"/);
  assert.match(logs, /"phase":"completed".*"submitted":true/);
  assert.match(logs, /PI_CODING_SESSION \{"phase":"thinking_disabled","side":"fork".*"enableThinking":false,"maxTokens":16384/);
  assert.match(logs, /PI_CODING_THINKING_POLICY .*"phase":"creation".*"enableThinking":false.*"maxTokens":16384/);
  assert.match(logs, /PI_CODING_SESSION \{"phase":"first_tool_call","side":"fork".*"tool":"accept_mutation_scope"/);
  assert.match(logs, /PI_CODING_SESSION \{"phase":"first_response","side":"fork".*"attemptedTool":true/);
  assert.equal(logs.match(/PI_MUTATION \{"stage":"implementer","tool":"write","mode":"coding_session"[^\n]*"changed":true/g)?.length, 2, 'several files in one session');
  assert.match(logs, /PI_RUN_CHECK|check passed|"phase":"completed"/);
  assert.doesNotMatch(logs, /PI_LARGE_MUTATION_BUDGET|mutation-writer|PI_MUTATION_TURN/);
});

test('a valid blocked child terminal result propagates as blocked, never implementation success', () => {
  const logs = runtimeScenario('blocked');
  assert.match(logs, /"phase":"blocked"/);
  assert.match(logs, /PI_CODING_SESSION .*"outcome":"blocked"/);
  assert.doesNotMatch(logs, /Coding session completed the implementation/);
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

test('#481 an aborted coding session returns authoritative state and bounded parent inspection', () => {
  const logs = runtimeScenario('no-submit-recovery');
  assert.match(logs, /"phase":"ended_without_submit".*"recoveryReceipt":\{/);
  assert.match(logs, /"infrastructure_code":"CHECK_ENV"/);
  assert.match(logs, /PI_CODING_RECOVERY_HANDOFF/);
  assert.match(logs, /PI_CODING_RECOVERY_GUARD /);
  assert.match(logs, /PI_CODING_RECOVERY_GUARD_RELEASED .*"reason":"bounded_recovery_evidence"/);
  assert.doesNotMatch(logs, /"reason":"terminal_diagnosis"/);
  assert.match(logs, /CODING_RECOVERY_RECEIPT_OK/);
  assert.match(logs, /CODING_RECOVERY_BOUNDED_INSPECTION_OK/);
});

test('#481 recovery guard fails closed after unrelated evidence when validation is unavailable', () => {
  const logs = runtimeScenario('no-submit-recovery-dead-end');
  assert.match(logs, /PI_CODING_RECOVERY_GUARD /);
  assert.doesNotMatch(logs, /PI_CODING_RECOVERY_GUARD_RELEASED/);
  assert.match(logs, /PI_CODING_RECOVERY_BLOCKED/);
  assert.match(logs, /CODING_RECOVERY_FAIL_CLOSED_OK/);
});

test('#499 failing pytest exposes bounded repair evidence and strict failure-set reduction remains repairable', () => {
  const logs = runtimeScenario('repair-evidence');
  assert.match(logs, /PI_TOOL_SURFACE_UPDATE .*"reason":"repair_evidence".*"read"/);
  assert.match(logs, /PI_CODING_REPAIR_READ .*"path":"test_generated.py".*"evidenceBudgetIndependent":true/);
  assert.match(logs, /PI_CODING_REPAIR_READ .*"path":"unchanged_helper.py".*"readsRemaining":0.*"evidenceBudgetIndependent":true/);
  assert.doesNotMatch(logs, /PI_CODING_REPAIR_READ .*"path":"link-source.py"/);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE .*"mode":"required".*"read"/);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":1.*"strictReduction":true/);
  assert.match(logs, /PI_CODING_THINKING_POLICY .*"phase":"repair_reasoning".*"enableThinking":true.*"maxTokens":4096/);
  assert.match(logs, /PI_CODING_REPAIR_LOCALIZED_WRITE_BLOCKED .*"mutation_shape":"whole_file_rewrite".*"worktree_preserved":true/);
  assert.match(logs, /PI_CODING_REPAIR_MUTATION .*"tool":"safe_edit".*"shape":"targeted_edit".*"thinkingPhase":"repair_followup"/);
  assert.match(logs, /PI_CODING_THINKING_POLICY .*"phase":"repair_followup".*"enableThinking":false.*"maxTokens":16384/);
  assert.doesNotMatch(logs, /PI_CODING_VALIDATION_NON_CONVERGENT/);
  assert.match(logs, /CODING_REPAIR_EVIDENCE_OK/);
});

test('#499 repair convergence survives unrelated passes and bounds A-B-A-B failure flip-flops', () => {
  const logs = runtimeScenario('repair-nonconvergent');
  assert.ok((logs.match(/PI_CODING_REPAIR_STATE .*"nonImprovingFailures":1.*"strictReduction":true/g) ?? []).length >= 1);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":2.*"strictReduction":false/);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":4.*"strictReduction":false/);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":5.*"strictReduction":false.*"limit":5/);
  assert.match(logs, /PI_CODING_VALIDATION_NON_CONVERGENT .*"seen_signatures":2.*"limit":5.*"worktree_preserved":true/);
  assert.match(logs, /CODING_REPAIR_NONCONVERGENT_OK/);
});

test('#506 systemic repair allows one whole-file rewrite, preserves its counter across shrinking failures, then aborts with checkpoint intact', () => {
  const logs = runtimeScenario('repair-broad-rewrite-limit');
  assert.match(logs, /PI_CODING_REPAIR_MUTATION_GATE .*"shape":"whole_file_rewrite".*"wholeFileRewriteCount":0/);
  assert.match(logs, /PI_CODING_REPAIR_MUTATION .*"tool":"write".*"shape":"whole_file_rewrite".*"wholeFileRewriteCount":1/);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"strictReduction":true.*"wholeFileRewritesByPath":\{"test_generated.py":1\}/);
  assert.match(logs, /PI_CODING_REPAIR_BROAD_REWRITE_LIMIT .*"whole_file_rewrite_count":1.*"limit":1.*"worktree_preserved":true/);
  assert.match(logs, /PI_CODING_REPAIR_ABORT .*"code":"PI_CODING_REPAIR_BROAD_REWRITE_LIMIT".*"worktree_preserved":true/);
  assert.match(logs, /CODING_REPAIR_BROAD_REWRITE_LIMIT_OK/);
});

test('#499 volatile diagnostic values keep one semantic failure identity', () => {
  const logs = runtimeScenario('repair-volatile-message');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":2.*"strictReduction":false.*"seenSignatures":1/);
  assert.doesNotMatch(logs, /PI_CODING_VALIDATION_NON_CONVERGENT/);
  assert.match(logs, /CODING_REPAIR_VOLATILE_MESSAGE_OK/);
});

test('#503 a provably covering same-kind pass clears narrower coding repair history', () => {
  const logs = runtimeScenario('repair-pass-reset');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"status":"cleared".*"reason":"validation_pass_covering_scope"/);
  const postReset = logs.slice(logs.indexOf('validation_pass_covering_scope'));
  assert.match(postReset, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":1/);
  assert.doesNotMatch(logs, /PI_CODING_VALIDATION_NON_CONVERGENT/);
  assert.match(logs, /CODING_REPAIR_PASS_RESET_OK/);
});

test('#503 semantic diagnostic numbers remain distinct repair identities', () => {
  const logs = runtimeScenario('repair-semantic-number');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":2.*"seenSignatures":2/);
  assert.match(logs, /CODING_REPAIR_SEMANTIC_NUMBER_OK/);
});

test('#503 structured run_check failure details are observed even when isError is true', () => {
  const logs = runtimeScenario('repair-iserror-details');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"status":"fail"/);
  assert.match(logs, /CODING_REPAIR_ISERROR_DETAILS_OK/);
});

test('#503 empty trusted repair scope releases the evidence gate instead of dead-ending', () => {
  const logs = runtimeScenario('repair-empty-scope');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"evidenceGateReleased":true/);
  assert.doesNotMatch(logs, /PI_TOOL_SURFACE_UPDATE .*"reason":"repair_evidence".*"read"/);
  assert.match(logs, /CODING_REPAIR_EMPTY_SCOPE_OK/);
});

test('parent submit inherits accepted scope from a coding-session fork that ended without submit', () => {
  const logs = runtimeScenario('no-submit-parent-submit');
  assert.match(logs, /"phase":"ended_without_submit".*"submitted":false/);
  assert.match(logs, /PARENT_SUBMIT_AFTER_FORK_OK/);
});

test('same elevated response may request bounded evidence then mutate without leaking the one-shot budget', () => {
  const logs = runtimeScenario('elevated-evidence-write');
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"consumed".*"attemptedFinishTool":true/);
  assert.match(logs, /ELEVATED_EVIDENCE_WRITE_CONSUMED_OK/);
});

test('one elevated mutation grant permits at most one scope-only prelude', () => {
  const logs = runtimeScenario('scope-prelude-cap');
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"scope_prelude".*"preserved":true/);
  assert.match(logs, /SCOPE_PRELUDE_CAP_OK/);
});

test('first prose-only action-required retry stays forced through a ceiling turn until a real exposed tool', () => {
  const logs = runtimeScenario('prose-force-direct');
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_ARMED/);
  assert.ok((logs.match(/PI_ACTION_REQUIRED_TOOL_CHOICE .*"mode":"required"/g) ?? []).length >= 2);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED .*"tool":"accept_mutation_scope"/);
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

test('#470 missing evidence executor restores the permit through the real runtime hooks', () => {
  const logs = runtimeScenario('evidence-missing-executor');
  const failureLine = logs.split('\n').find(line => line.startsWith('PI_RUNTIME_FAILURE '));
  assert.ok(failureLine, 'runtime contract failure is recorded');
  const failure = JSON.parse(failureLine.slice('PI_RUNTIME_FAILURE '.length));
  assert.equal(failure.failure_code, 'PI_TOOL_CONTRACT_FAILURE');
  assert.equal(failure.tool, 'read');
  assert.match(logs, /EVIDENCE_MISSING_EXECUTOR_PERMIT_RESTORED/);
});


test('#469 evidence unlock is single-use; stale lifecycle races reset strikes before genuine unavailable calls can abort', () => {
  const logs = runtimeScenario('action-hidden-abort');
  assert.match(logs, /PI_EVIDENCE_PERMIT_CONSUMED .*"tool":"read".*"productiveState":"action_required"/);
  assert.match(logs, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"attemptedTool":"read"/);
  assert.match(logs, /PI_CAPABILITY_LIFECYCLE_MISMATCH .*"attemptedTool":"need_more_evidence"/);
  assert.match(logs, /PI_UNAVAILABLE_CAPABILITY_ABORT: second consecutive unavailable capability turn/);
  assert.match(logs, /UNAVAILABLE_CAPABILITY_FAILURE .*"failure_code":"PI_UNAVAILABLE_CAPABILITY_ABORT"/);
  assert.doesNotMatch(logs, /PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn/);
});

test('coding-session fork shares action_required forcing semantics and clears them on its first tool', () => {
  const logs = runtimeScenario('fork-prose-force');
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_ARMED/);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED .*"tool":"accept_mutation_scope"/);
});

test('coding session rejects an unavailable required capability before launching the fork', () => {
  const logs = runtimeScenario('forbidden-capability');
  assert.match(logs, /"phase":"rejected".*"reason":"required_capability_unavailable"/);
});

test('#440 an equivalent capability-incompatible fork is rejected without model-declared required_capability', () => {
  const logs = runtimeScenario('incapable-repeat');
  assert.match(logs, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"attemptedTool":"bash"/);
  assert.match(logs, /"phase":"ended_without_submit".*"unreachableCapabilities":\["bash"\]/);
  assert.match(logs, /"phase":"rejected".*"reason":"repeated_incapable_session".*"unreachable":\["bash"\]/);
  assert.match(logs, /INCAPABLE_FORK_REPEAT_REJECTED_OK/);
});

test('#440 a trusted recovery transition after an incapable fork permits another coding session', () => {
  const logs = runtimeScenario('incapable-transition');
  assert.doesNotMatch(logs, /repeated_incapable_session/);
  assert.match(logs, /INCAPABLE_FORK_TRANSITION_OK/);
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

test('#397–#402 nested unavailable tools abort as runtime infrastructure without another coding session', () => {
  const logs = runtimeScenario('tool-contract');
  assert.match(logs, /PI_RUNTIME_FAILURE_NESTED/);
  assert.match(logs, /PI_TOOL_CONTRACT_FAILURE/);
  // #425: the contract-failure exit still records the session and keeps the fork's per-response usage.
  const session = lastMetrics.find(record => record.scope === 'session' && record.call === 'coding');
  assert.equal(session?.status, 'contract_failure');
  assert.equal(session.usage.totalTokens, 55);
  // Per-response usage (12) and the failed envelope's roll-up (55) disagree: keep the known 55, flag the mismatch.
  const ledger = summarizeUsage(lastMetrics);
  assert.equal(ledger.calls.get('coding').total, 55);
  assert.equal(ledger.complete, false);
  assert.ok(ledger.unknown.some(entry => entry.reason === 'session_response_usage_mismatch'));
  assert.ok(lastMetrics.some(record => record.call === 'coding' && record.scope === undefined && record.childSession === session.childSession));
});

test('#425 a second coding attempt after recovery keeps both sessions attributed once', () => {
  runtimeScenario('incapable-transition');
  const sessions = lastMetrics.filter(record => record.scope === 'session' && record.call === 'coding');
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].childSession, sessions[1].childSession);
  const perSession = sessions.map(session => lastMetrics.filter(record => record.scope === undefined && record.childSession === session.childSession).length);
  assert.ok(perSession.every(count => count > 0), 'each attempt has its own per-response usage');
  const ledger = summarizeUsage(lastMetrics);
  assert.equal(ledger.calls.get('coding').responses, perSession[0] + perSession[1]);
});

test('coding-session allowlist is derived from the executable registry, including hidden tools', () => {
  runtimeScenario('narrow-registry');
});

test('#470 failed bash invalidates pytest evidence when it changed the worktree', () => {
  assert.match(runtimeScenario('bash-error-mutates'), /FAILED_BASH_MUTATION_INVALIDATED/);
});

test('#470 failed bash invalidates pytest evidence when repository fingerprint is unknown', () => {
  assert.match(runtimeScenario('bash-error-unknown'), /FAILED_BASH_UNKNOWN_INVALIDATED/);
});

test('#399 executor-unavailable bash tool result aborts the parent as infrastructure immediately', () => {
  runtimeScenario('parent-contract');
});

test('malformed fork provenance preserves the original delegation error and removes the artifact', () => {
  assert.match(runtimeScenario('malformed-contract'), /PI_CODING_CONTRACT_METADATA_INVALID/);
});

test('both missing-executor event orders abort only once', () => {
  runtimeScenario('parent-contract');
  runtimeScenario('parent-contract-reverse');
});

test('#441 a tool activated after payload assembly is deferred, not advertised; contract failures still abort', () => {
  const logs = runtimeScenario('deferred-capability');
  assert.match(logs, /PI_PROVIDER_CAPABILITY_DEFERRED .*"request":\d+,"executableTools":\[[^\]]*\],"activeTools":\[[^\]]*"submit_result"[^\]]*\],"deferredTools":\["submit_result"\]/);
  assert.match(logs, /PI_PROVIDER_CAPABILITY_SNAPSHOT .*"deferredTools":\["submit_result"\]/);
  assert.match(logs, /PI_CAPABILITY_LIFECYCLE_MISMATCH .*"kind":"deferred_tool_called","attemptedTool":"submit_result"/);
  assert.equal((logs.match(/PI_CAPABILITY_LIFECYCLE_MISMATCH/g) ?? []).length, 1, 'both pi events for one call log once');
  assert.match(logs, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"kind":"executor_not_found","attemptedTool":"ghost_tool"/);
  assert.match(logs, /PI_RUNTIME_FAILURE .*"tool":"submit_result".*"failure_code":"PI_TOOL_CONTRACT_FAILURE"/);
  assert.match(logs, /DEFERRED_CAPABILITY_OK/);
});

test('#441 a coding-session fork defers a late-active tool and recovers from calling it', () => {
  const logs = runtimeScenario('fork-deferred-capability');
  assert.match(logs, /PI_CAPABILITY_LIFECYCLE_MISMATCH .*"attemptedTool":"submit_result"/);
  assert.match(logs, /FORK_DEFERRED_CAPABILITY_OK/);
  assert.match(logs, /"phase":"completed".*"submitted":true/);
});

test('#441 deferred guidance stays conditional when another tool removes the deferred tool before the next request', () => {
  const logs = runtimeScenario('deferred-then-removed');
  assert.match(logs, /PI_CAPABILITY_LIFECYCLE_MISMATCH .*"attemptedTool":"submit_result"/);
  assert.match(logs, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"kind":"executor_not_found","attemptedTool":"submit_result"/);
  assert.doesNotMatch(logs, /PI_TOOL_CONTRACT_FAILURE/);
  assert.match(logs, /DEFERRED_THEN_REMOVED_OK/);
});
