import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MUTATION_WRITER_SCHEMA,
  CONSERVATIVE_CHARS_PER_TOKEN,
  WRITER_OUTPUT_RESERVE_RATIO,
  applyDelegatedMutation,
  maxEditSourceChars,
  mutationWriterTask,
  validateDelegationRequest,
  validateWriterResult,
} from '../scripts/pi-common/delegated-mutation.mjs';
import { ProgressController, truncatedToolCallGuidance } from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delegated-'));
}

const WRITER_MAX_TOKENS = stageConfig('implementer').productiveProgress.delegatedMutationWriterMaxTokens;
const limits = { writerMaxTokens: WRITER_MAX_TOKENS };

const concrete = {
  operation: 'write',
  path: 'arkanoid.py',
  intent: 'Create the complete standalone curses Arkanoid game',
  requirements: ['stdlib only', 'restart support'],
};

test('delegation requires a concrete path, decided intent and requirements', () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'pkg'));
    fs.writeFileSync(path.join(dir, 'pkg', 'mod.py'), 'x = 1\n');
    const ok = validateDelegationRequest(dir, concrete, limits);
    assert.deepEqual(ok.request, { ...concrete, context: '' });
    assert.equal(ok.currentContent, null);
    const edit = validateDelegationRequest(dir, { ...concrete, operation: 'edit', path: 'pkg/mod.py' }, limits);
    // A worktree-absolute path is normalized to the relative request path.
    assert.equal(validateDelegationRequest(dir, { ...concrete, path: path.join(dir, 'pkg', 'mod.py') }, limits).request.path, path.join('pkg', 'mod.py'));
    assert.equal(edit.currentContent, 'x = 1\n');

    const rejected = [
      [{ intent: 'fix the issue' }, 'vague_intent'],
      [{ intent: 'Fix issue #270' }, 'vague_intent'],
      [{ intent: 'implement the task.' }, 'vague_intent'],
      [{ intent: 'do it' }, 'vague_intent'],
      [{ path: '' }, 'missing_path'],
      [{ path: undefined }, 'missing_path'],
      [{ path: '../outside.py' }, 'invalid_path'],
      [{ path: '/etc/passwd' }, 'invalid_path'],
      [{ path: '.git/config' }, 'invalid_path'],
      [{ path: 'pkg' }, 'invalid_path'],
      [{ requirements: [] }, 'missing_requirements'],
      [{ requirements: ['  '] }, 'missing_requirements'],
      [{ operation: 'delete' }, 'invalid_operation'],
      [{ operation: 'edit', path: 'missing.py' }, 'missing_target'],
    ];
    for (const [patch, code] of rejected) {
      assert.throws(() => validateDelegationRequest(dir, { ...concrete, ...patch }, limits), error => error.code === code, JSON.stringify(patch));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer result must match the delegated path and operation and carry content', () => {
  const request = { operation: 'write', path: 'arkanoid.py' };
  assert.equal(validateWriterResult({ operation: 'write', path: './arkanoid.py', content: 'print(1)\n' }, request), 'print(1)\n');
  const rejected = [
    [{ operation: 'write', path: 'other.py', content: 'x' }, 'path_mismatch'],
    [{ operation: 'edit', path: 'arkanoid.py', content: 'x' }, 'operation_mismatch'],
    [{ operation: 'write', path: 'arkanoid.py', content: '   ' }, 'empty_content'],
    [{ operation: 'write', path: 'arkanoid.py', content: 'x', extra: 1 }, 'invalid_output'],
    [null, 'invalid_output'],
  ];
  for (const [value, code] of rejected) {
    assert.throws(() => validateWriterResult(value, request), error => error.code === code, code);
  }
  assert.deepEqual(MUTATION_WRITER_SCHEMA.required, ['operation', 'path', 'content']);
});

test('writer task carries only the decided mutation, plan or fallback marker, and edit source', () => {
  const request = { ...concrete, operation: 'edit', context: 'API: run(stdscr)' };
  const issue = { title: 'Arkanoid', body: 'Build it' };
  const prepared = mutationWriterTask({ request, currentContent: 'OLD\n', issue, preparation: { state: 'PREPARED', steps: ['Write game'] } });
  assert.match(prepared, /Target path: arkanoid\.py/);
  assert.match(prepared, /- restart support/);
  assert.match(prepared, /API: run\(stdscr\)/);
  assert.match(prepared, /1\. Write game/);
  assert.match(prepared, /<<<CURRENT_FILE\nOLD\n\nCURRENT_FILE>>>/);
  assert.match(prepared, /Do not choose another path or operation/);
  const fallback = mutationWriterTask({ request: { ...concrete, context: '' }, currentContent: null, issue, preparation: { state: 'PREPARATION_FALLBACK', steps: null } });
  assert.match(fallback, /PREPARATION_FALLBACK/);
  assert.doesNotMatch(fallback, /CURRENT_FILE/);
});

test('runtime application is atomic and detects a no-op', () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'nested', 'game.py');
    const request = { operation: 'write', path: 'nested/game.py' };
    assert.deepEqual(applyDelegatedMutation(dir, request, 'print(1)\n'), { changed: true, bytes: 9 });
    assert.equal(fs.readFileSync(target, 'utf8'), 'print(1)\n');
    const mtime = fs.statSync(target).mtimeMs;
    assert.equal(applyDelegatedMutation(dir, request, 'print(1)\n').changed, false);
    assert.equal(fs.statSync(target).mtimeMs, mtime);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['game.py']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('controller treats delegate_mutation as a normal mutation behind the preparation gate', () => {
  const unprepared = new ProgressController(stageConfig('implementer'), {});
  assert.equal(unprepared.checkToolCall('delegate_mutation', concrete).block, true, 'preparation cannot be skipped');

  const state = new ProgressController(stageConfig('implementer'), {});
  assert.equal(state.checkToolCall('prepare_implementation', {}), undefined);
  state.enterPreparationFallback();
  state.onToolExecutionEnd('prepare_implementation', false);
  assert.equal(state.checkToolCall('run_check', {}).block, true);
  assert.equal(state.checkToolCall('delegate_mutation', concrete), undefined);
  state.onToolExecutionEnd('delegate_mutation', true);
  assert.equal(state.verificationPermitted(), false, 'a failed delegation earns no verification permit');
  assert.equal(state.checkToolCall('write', { path: 'a.py', content: 'x' }), undefined, 'direct mutation still available after writer failure');
  assert.equal(state.checkToolCall('delegate_mutation', { ...concrete, path: 'b.py' }), undefined);
  state.onToolExecutionEnd('delegate_mutation', false);
  assert.equal(state.turnMadeProgress, true);
  assert.equal(state.verificationPermitted(), true);
  assert.equal(state.largeMutationBudgetState, 'idle', 'no parent-side large budget state');
});

test('truncated direct writes are steered to delegation instead of a payload retry', () => {
  const guidance = truncatedToolCallGuidance('write', {
    largeMutationBudgetTool: 'request_large_mutation_budget',
    delegatedMutationTool: 'delegate_mutation',
  });
  assert.match(guidance, /NOT executed/);
  assert.match(guidance, /Do not regenerate the full payload in the parent/);
  assert.match(guidance, /Call delegate_mutation with the target path/);
  assert.doesNotMatch(guidance, /request_large_mutation_budget/);
  // Non-payload tools keep the generic guidance.
  assert.doesNotMatch(truncatedToolCallGuidance('submit_result', { delegatedMutationTool: 'delegate_mutation' }), /delegate_mutation/);
});

test('writer agent is tool-less, child-budgeted and registered for the implementer', () => {
  const writer = fs.readFileSync('.pi/agents/mutation-writer.md', 'utf8');
  const settings = JSON.parse(fs.readFileSync('.pi/settings.json', 'utf8'));
  assert.match(writer, /^name: mutation-writer$/m);
  assert.match(writer, /^tools:\s*$/m);
  assert.deepEqual(settings.subagents.agentOverrides['mutation-writer'].subagentOnlyExtensions, ['./scripts/pi-subagent-response-budget.mjs']);
  const progress = stageConfig('implementer').productiveProgress;
  assert.equal(progress.delegatedMutationTool, 'delegate_mutation');
  assert.equal(progress.delegatedMutationWriterAgent, 'mutation-writer');
  assert.equal(progress.delegatedMutationWriterMaxTokens, 16384);
  assert.equal(progress.delegatedMutationWriterRetry, 1);
  assert.equal(progress.actionResponseMaxTokens, 2048);
});

test('writer contract explicitly preserves backslashes through structured JSON transport', () => {
  const writer = fs.readFileSync('.pi/agents/mutation-writer.md', 'utf8');
  assert.match(writer, /structured result is transported as JSON/i);
  assert.match(writer, /Preserve source-code backslashes through that JSON round trip/i);
  assert.match(writer, /\\\\n/);
  assert.match(writer, /literal newline inside the Python string/i);
});

test('symlinked path components cannot redirect a delegated mutation outside the worktree or into .git', () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'link'));
    fs.symlinkSync(path.join(dir, '.git'), path.join(dir, 'gitlink'));
    fs.symlinkSync(path.join(outside, 'missing.py'), path.join(dir, 'dangling.py'));
    for (const target of ['link/generated.py', 'gitlink/hooks/pre-commit', 'dangling.py']) {
      for (const operation of ['write', 'edit']) {
        assert.throws(
          () => validateDelegationRequest(dir, { ...concrete, operation, path: target }, limits),
          error => error.code === 'invalid_path',
          `${operation} ${target}`,
        );
      }
      assert.throws(() => applyDelegatedMutation(dir, { operation: 'write', path: target }, 'x'), error => error.code === 'invalid_path', target);
    }
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.git', 'hooks')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('target state is re-validated between request validation and runtime apply', () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    // A parent directory swapped for a symlink while the writer ran.
    fs.mkdirSync(path.join(dir, 'pkg'));
    const write = validateDelegationRequest(dir, { ...concrete, path: 'pkg/new.py' }, limits);
    fs.rmSync(path.join(dir, 'pkg'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'pkg'));
    assert.throws(() => applyDelegatedMutation(dir, write.request, 'x = 1\n'), error => error.code === 'invalid_path');
    assert.deepEqual(fs.readdirSync(outside), []);

    // An edit target changed (or vanished) while the writer rewrote the old content.
    fs.writeFileSync(path.join(dir, 'mod.py'), 'a = 1\n');
    const edit = validateDelegationRequest(dir, { ...concrete, operation: 'edit', path: 'mod.py' }, limits);
    fs.writeFileSync(path.join(dir, 'mod.py'), 'a = 2\n');
    assert.throws(
      () => applyDelegatedMutation(dir, edit.request, 'a = 1\nb = 2\n', { expectedContent: edit.currentContent }),
      error => error.code === 'target_changed',
    );
    assert.equal(fs.readFileSync(path.join(dir, 'mod.py'), 'utf8'), 'a = 2\n');
    fs.rmSync(path.join(dir, 'mod.py'));
    assert.throws(
      () => applyDelegatedMutation(dir, edit.request, 'a = 1\n', { expectedContent: edit.currentContent }),
      error => error.code === 'target_changed',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('an admitted edit source is expected to fit in the writer output ceiling', () => {
  const limit = maxEditSourceChars(WRITER_MAX_TOKENS);
  // Pessimistic token estimate for the full rewritten file must stay within the ceiling,
  // leaving the reserved share for reasoning, the structured wrapper and the change itself.
  const estimatedTokens = Math.ceil(limit / CONSERVATIVE_CHARS_PER_TOKEN);
  const reservedTokens = Math.floor(WRITER_MAX_TOKENS * WRITER_OUTPUT_RESERVE_RATIO);
  assert.ok(estimatedTokens + reservedTokens <= WRITER_MAX_TOKENS, `${estimatedTokens} + ${reservedTokens} tokens`);
  assert.ok(CONSERVATIVE_CHARS_PER_TOKEN <= 3, 'ratio stays below typical source-code density');
  assert.ok(limit < 30000, `edit cap ${limit} chars is far below the old 120K`);

  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'fits.py'), 'x'.repeat(limit));
    fs.writeFileSync(path.join(dir, 'big.py'), 'x'.repeat(limit + 1));
    assert.equal(validateDelegationRequest(dir, { ...concrete, operation: 'edit', path: 'fits.py' }, limits).currentContent.length, limit);
    assert.throws(
      () => validateDelegationRequest(dir, { ...concrete, operation: 'edit', path: 'big.py' }, limits),
      error => error.code === 'target_too_large',
    );
    // A full-replacement write never ships the existing file to the writer, whatever its size.
    const write = validateDelegationRequest(dir, { ...concrete, operation: 'write', path: 'big.py' }, limits);
    assert.equal(write.currentContent, null);
    assert.doesNotMatch(mutationWriterTask({ request: write.request, currentContent: write.currentContent, issue: null, preparation: null }), /CURRENT_FILE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Drives the real runtime extension end to end. Only typebox's schema builders are stubbed;
// planner/writer subagents answer over the same event bus pi-subagents uses.
function runtimeScenario(mode) {
  const dir = tempDir();
  try {
    const context = path.join(dir, 'issue.json');
    const loader = path.join(dir, 'loader.mjs');
    const scenario = path.join(dir, 'scenario.mjs');
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(context, JSON.stringify({ title: 'Arkanoid smoke', body: 'Create arkanoid.py' }));
    fs.writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'typebox') return {
        url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
        shortCircuit: true,
      };
      return nextResolve(specifier, context);
    }`);
    fs.writeFileSync(scenario, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { EventEmitter } from 'node:events';
      const { default: runtime } = await import(${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)});
      const mode = ${JSON.stringify(mode)};
      const cwd = ${JSON.stringify(work)};
      const GAME = 'import curses\\n\\ndef main(stdscr):\\n    pass\\n';
      const bus = new EventEmitter();
      const tools = new Map();
      const handlers = new Map();
      const caps = [];
      const writerRequests = [];
      const steers = [];
      let active = ['read', 'write', 'edit', 'safe_edit', 'structural_edit', 'run_check', 'submit_result', 'need_more_evidence',
        'request_large_mutation_budget', 'delegate_mutation', 'rollback_last_mutation', 'prepare_implementation'];
      let plannerAttempts = 0;
      const ctx = { cwd, model: { maxTokens: 32000 }, sessionManager: { getSessionId: () => 'parent' }, abort: () => { throw new Error('unexpected abort'); } };
      const signal = new AbortController();
      const pi = {
        events: { on: (event, fn) => { bus.on(event, fn); return () => bus.off(event, fn); }, emit: (...args) => bus.emit(...args) },
        registerTool: tool => tools.set(tool.name, tool),
        on: (name, fn) => handlers.set(name, fn),
        getActiveTools: () => [...active], setActiveTools: names => { active = names; },
        setModel: async model => { caps.push(model.maxTokens); return true; },
        sendUserMessage: async text => { steers.push(text); },
      };
      const respond = (request, payload) => bus.emit('prompt-template:subagent:response', {
        requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, ...payload,
      });
      const missing = { status: 'failed', error: 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.' };
      bus.on('prompt-template:subagent:request', request => {
        if (request.agent === 'implementation-planner') {
          plannerAttempts++;
          return respond(request, mode === 'fallback' ? missing : { status: 'completed', result: { kind: 'structured', value: {
            steps: ['Create arkanoid.py'], complexity: 'nontrivial', evidence_budget: 0, reason: 'Fresh standalone file',
          } } });
        }
        assert.equal(request.agent, 'mutation-writer');
        assert.deepEqual(request.toolBudget, { hard: 2 });
        writerRequests.push({ task: request.task, maxTokens: process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS });
        const value = (overrides = {}) => ({ status: 'completed', result: { kind: 'structured', value: {
          operation: 'write', path: 'arkanoid.py', content: GAME, ...overrides,
        } } });
        if (mode === 'cancel') { signal.abort(); return; }
        if (mode === 'cancel-after-result') { respond(request, value()); signal.abort(); return; }
        if (mode === 'retry' && writerRequests.length === 1) return respond(request, missing);
        if (mode === 'invalid') return respond(request, value({ content: '' }));
        if (mode === 'path-mismatch') return respond(request, value({ path: 'other.py' }));
        if (mode === 'truncated') return respond(request, { status: 'failed', error: 'Response stopped at the output token limit; tool arguments may be truncated' });
        if (mode === 'noop') return respond(request, value({ content: fs.readFileSync(cwd + '/arkanoid.py', 'utf8') }));
        if (mode === 'edit-race') {
          // Someone changes the edit target while the writer is still rewriting the old content.
          fs.writeFileSync(cwd + '/arkanoid.py', 'CHANGED\\n');
          return respond(request, value({ operation: 'edit' }));
        }
        return respond(request, value());
      });
      runtime(pi);
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
            result = { content: [{ type: 'text', text: 'ok' }] };
          }
        } catch (error) {
          isError = true;
          if (!expectError) throw error;
          assert.match(String(error.message), expectError);
          result = { content: [{ type: 'text', text: String(error.message) }] };
        }
        if (expectError) assert.equal(isError, true, name + ' should fail');
        await handlers.get('tool_execution_end')({ ...event, isError, result }, ctx);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        return result;
      }
      const delegate = { operation: 'write', path: 'arkanoid.py', intent: 'Create the complete standalone curses Arkanoid game',
        requirements: ['stdlib only', 'curses UI', 'restart support'] };
      const parentNeverElevated = () => assert.ok(!caps.includes(16384), 'parent response ceiling must never reach 16384: ' + caps);

      if (mode !== 'restored') await call('prepare_implementation');
      if (mode === 'noop') fs.writeFileSync(cwd + '/arkanoid.py', GAME);
      if (mode === 'edit-race') fs.writeFileSync(cwd + '/arkanoid.py', 'OLD\\n');

      if (['flow', 'fallback', 'retry', 'restored'].includes(mode)) {
        // The runtime syncs the action surface on turn_start; observe it at that boundary.
        handlers.get('turn_start')({ turnIndex: turn });
        assert.ok(active.includes('delegate_mutation'));
        assert.ok(!active.includes('run_check'));
        const result = await call('delegate_mutation', delegate);
        assert.equal(result.details.changed, true);
        assert.equal(fs.readFileSync(cwd + '/arkanoid.py', 'utf8'), GAME);
        assert.equal(writerRequests.length, mode === 'retry' ? 2 : 1);
        assert.ok(writerRequests.every(request => request.maxTokens === '16384'), 'writer receives the large ceiling');
        assert.equal(process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, '2048', 'parent child-budget mirror restored');
        assert.match(writerRequests[0].task, mode === 'fallback' ? /PREPARATION_FALLBACK/ : mode === 'restored' ? /Target path: arkanoid\\.py/ : /1\\. Create arkanoid\\.py/);
        assert.equal(caps.at(-1), 2048, 'parent stays at the normal ceiling');
        assert.ok(active.includes('run_check'), 'run_check visible immediately after the delegated mutation');
        await call('run_check', { kind: 'python_compile', paths: ['arkanoid.py'] });
        assert.ok(!active.includes('run_check'), 'one verification per mutation');
        if (mode === 'flow') {
          await call('rollback_last_mutation', { reason: 'exercise snapshot' });
          assert.equal(fs.existsSync(cwd + '/arkanoid.py'), false, 'delegated mutation is rollback-able');
          // Small direct writes stay direct.
          await call('write', { path: 'small.py', content: 'x = 1\\n' });
          assert.ok(active.includes('run_check'));
          await call('run_check', { kind: 'python_compile', paths: ['small.py'] });
        }
        await call('submit_result');
        parentNeverElevated();
      } else if (mode === 'noop') {
        const result = await call('delegate_mutation', delegate);
        assert.equal(result.details.changed, false);
        assert.match(result.content[0].text, /NO CHANGE/);
      } else if (mode === 'vague') {
        await call('delegate_mutation', { ...delegate, intent: 'fix the issue' }, { expectError: /concrete change already decided/ });
        assert.equal(writerRequests.length, 0, 'vague requests never launch a writer');
      } else {
        const expectError = {
          cancel: /aborted/, 'cancel-after-result': /cancelled before the writer result was applied/,
          invalid: /empty_content/, 'edit-race': /changed while the writer ran/, 'path-mismatch': /path_mismatch/, truncated: /writer_output_truncated/,
        }[mode];
        await call('delegate_mutation', mode === 'edit-race' ? { ...delegate, operation: 'edit' } : delegate, { expectError });
        if (mode === 'edit-race') assert.equal(fs.readFileSync(cwd + '/arkanoid.py', 'utf8'), 'CHANGED\\n', 'concurrent change preserved');
        else assert.equal(fs.existsSync(cwd + '/arkanoid.py'), false, 'nothing applied');
        assert.equal(writerRequests.length, mode === 'invalid' ? 2 : 1, 'bounded retry');
        assert.ok(!active.includes('run_check'), 'failed delegation earns no verification permit');
        assert.ok(active.includes('write') && active.includes('delegate_mutation'), 'productive tools stay available');
        parentNeverElevated();
      }

      if (mode === 'flow') {
        const cut = 'Tool call "write" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.';
        const guided = () => steers.filter(text => text.includes('Call delegate_mutation with the target path')).length;
        // Production shape (run 36847315837): pi rejects the cut-off call before execution and
        // emits only tool_execution_end, no tool_call and no tool_result.
        await handlers.get('tool_execution_end')({ toolName: 'write', toolCallId: 'cut-1', isError: true,
          result: { content: [{ type: 'text', text: cut }] } }, ctx);
        assert.equal(guided(), 1, 'execution-end-only truncation steers to delegation');
        // tool_result first, then tool_execution_end: rewritten once, not steered again.
        const rewritten = handlers.get('tool_result')({ toolName: 'write', toolCallId: 'cut-2', isError: true, content: [{ type: 'text', text: cut }] });
        assert.match(rewritten.content[0].text, /Call delegate_mutation with the target path/);
        await handlers.get('tool_execution_end')({ toolName: 'write', toolCallId: 'cut-2', isError: true, result: { content: [{ type: 'text', text: cut }] } }, ctx);
        assert.equal(guided(), 1);
        // tool_execution_end first, then tool_result: steered once, tool_result left alone.
        await handlers.get('tool_execution_end')({ toolName: 'write', toolCallId: 'cut-3', isError: true, result: { content: [{ type: 'text', text: cut }] } }, ctx);
        assert.equal(handlers.get('tool_result')({ toolName: 'write', toolCallId: 'cut-3', isError: true, content: [{ type: 'text', text: cut }] }), undefined);
        assert.equal(guided(), 2);
      }
    `);
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, scenario], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_ISSUE_CONTEXT: context,
        PI_RESUME_ACTIVE: mode === 'restored' ? 'true' : 'false', PI_VALIDATION_REPAIR: 'false',
        PI_SUBAGENT_RESPONSE_MAX_TOKENS: '2048' },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout + result.stderr;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('full flow: parent -> delegate_mutation -> 16K writer -> runtime write -> run_check -> submit_result', () => {
  const logs = runtimeScenario('flow');
  for (const phase of ['requested', 'writer_started', 'writer_completed', 'applied']) {
    assert.match(logs, new RegExp(`PI_DELEGATED_MUTATION \\{"phase":"${phase}"`), phase);
  }
  assert.match(logs, /PI_MUTATION .*"tool":"delegate_mutation","mode":"delegated","path":"arkanoid.py","isError":false,"changed":true/);
  assert.match(logs, /PI_MUTATION .*"tool":"write","mode":"direct"/);
  assert.doesNotMatch(logs, /PI_LARGE_MUTATION_BUDGET/);
  assert.match(logs, /PI_TOOL_CALL_TRUNCATED .*"toolName":"write","source":"tool_execution_end"/);
  assert.match(logs, /PI_TOOL_CALL_TRUNCATED .*"toolName":"write","source":"tool_result"/);
});

test('delegation works under PREPARATION_FALLBACK and on a resumed implementer', () => {
  assert.match(runtimeScenario('fallback'), /PI_PREPARATION_FALLBACK/);
  assert.match(runtimeScenario('restored'), /"phase":"applied"/);
});

test('writer structured-output retry is bounded to one extra attempt', () => {
  const logs = runtimeScenario('retry');
  assert.match(logs, /"phase":"writer_failed".*"reason":"missing_structured_output","retriesExhausted":false/);
  assert.match(logs, /"phase":"writer_retry"/);
  const invalid = runtimeScenario('invalid');
  assert.match(invalid, /"phase":"writer_failed".*"attempt":2,"reason":"empty_content","retriesExhausted":true/);
  assert.match(invalid, /"phase":"rejected".*"stage":"writer","reason":"empty_content"/);
});

test('mismatched, truncated, vague, cancelled and no-op delegations are never applied', () => {
  assert.match(runtimeScenario('path-mismatch'), /"phase":"rejected".*"reason":"path_mismatch"/);
  assert.match(runtimeScenario('truncated'), /"reason":"writer_output_truncated","retriesExhausted":false/);
  assert.match(runtimeScenario('vague'), /"phase":"rejected".*"stage":"request","reason":"vague_intent"/);
  assert.match(runtimeScenario('cancel'), /"phase":"cancelled".*"before":"writer_result"/);
  assert.match(runtimeScenario('cancel-after-result'), /"phase":"cancelled".*"before":"runtime_apply"/);
  const noop = runtimeScenario('noop');
  assert.match(noop, /"phase":"no_op"/);
  assert.match(noop, /PI_MUTATION .*"tool":"delegate_mutation".*"changed":false/);
  assert.match(runtimeScenario('edit-race'), /"phase":"rejected".*"stage":"apply","reason":"target_changed"/);
});
