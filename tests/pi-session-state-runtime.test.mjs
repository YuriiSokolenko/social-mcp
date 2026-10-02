import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { projectConfig } from '../scripts/pi-common/project-config.mjs';

// Real runtime with a stubbed pi host: after PREPARATION_FALLBACK, subagents_enable and
// lsp_start_server succeed once; the runtime must materialize state, update the tool surface,
// and turn repeats into already_satisfied without executing them.
test('runtime materializes completed transitions into context and tool surface', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-state-'));
  try {
    const context = path.join(dir, 'issue.json');
    const ledger = path.join(dir, 'ledger.jsonl');
    const loader = path.join(dir, 'loader.mjs');
    const expectedFinalPipeline = projectConfig().checks.final.map(step => step.name).join(' -> ');
    const expectedFinalGuidance =
      `Authoritative final checks still run automatically after submit_result and before publication: ${expectedFinalPipeline}.`;
    fs.writeFileSync(context, JSON.stringify({ title: 'Example task', body: 'Implement example.py' }));
    fs.writeFileSync(path.join(dir, 'example.py'), 'value = 1\n');
    fs.writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'typebox') return {
        url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
        shortCircuit: true,
      };
      return nextResolve(specifier, context);
    }`);
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { EventEmitter } from 'node:events';
      const { default: runtime } = await import(${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)});
      const bus = new EventEmitter();
      const tools = new Map();
      const handlers = new Map();
      const messages = [];
      // Intentionally omit retry_last_failed_check: the runtime must activate
      // its own deterministic recovery tool when an exact retry becomes ready.
      let active = ['read', 'safe_edit', 'edit', 'run_check', 'submit_result', 'rollback_last_mutation', 'need_more_evidence', 'begin_coding_session',
        'request_large_mutation_budget', 'prepare_implementation', 'subagents_enable', 'lsp_start_server'];
      const ctx = { cwd: ${JSON.stringify(dir)}, model: { maxTokens: 32000 },
        sessionManager: { getSessionId: () => 'parent' }, abort: () => { aborts++; } };
      let aborts = 0;
      const pi = {
        events: { on: (e, fn) => { bus.on(e, fn); return () => bus.off(e, fn); }, emit: (...a) => bus.emit(...a) },
        registerTool: tool => tools.set(tool.name, tool),
        on: (name, fn) => handlers.set(name, fn),
        getActiveTools: () => [...active], setActiveTools: names => { active = names; },
        setModel: async () => true,
        sendUserMessage: async text => { messages.push(text); },
      };
      bus.on('prompt-template:subagent:request', request => bus.emit('prompt-template:subagent:response', {
        requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
        status: 'failed', error: 'Missing structured_output call',
      }));
      runtime(pi);
      let turn = 0;
      let startups = 0;
      async function call(name, input = {}, { enables } = {}) {
        handlers.get('turn_start')({ turnIndex: turn });
        const event = { toolName: name, toolCallId: name + turn, input };
        const blocked = await handlers.get('tool_call')(event, ctx);
        if (blocked) return blocked;
        let result = { content: [{ type: 'text', text: 'ok' }] };
        if (name === 'lsp_start_server') startups++;
        if (name === 'edit') fs.appendFileSync(path.join(ctx.cwd, input.path), '# mutation ' + turn + '\\n');
        if (tools.has(name) && name !== 'run_check') result = await tools.get(name).execute(event.toolCallId, input, null, null, ctx);
        if (enables) active.push(enables); // extension adds the newly enabled tool
        await handlers.get('tool_execution_end')({ ...event, isError: false, result }, ctx);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        return undefined;
      }
      await call('prepare_implementation');
      assert.ok(!active.includes('prepare_implementation'), 'prepare_implementation removed');
      assert.ok(!active.includes('run_check'), 'run_check hidden before a mutation grants a permit');
      assert.ok(messages.some(m => /preparation: fallback-complete/.test(m)), 'preparation state injected');
      handlers.get('turn_start')({ turnIndex: turn });
      await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
      const beforeMutationGuidance = messages.join('\\n');
      assert.match(beforeMutationGuidance, /run_check is not yet available; it becomes available after a successful mutation/);
      assert.doesNotMatch(beforeMutationGuidance, /run_check is exhausted for the current mutation state/);

      await call('edit', { path: 'example.py' });
      assert.ok(active.includes('run_check'), 'run_check exposed after a successful mutation grants a permit');
      const validationMessageStart = messages.length;
      await call('run_check', { kind: 'ruff', paths: ['example.py'] });
      assert.ok(!active.includes('run_check'), 'run_check hidden immediately after its permit is consumed');
      const validationGuidance = messages.slice(validationMessageStart).join('\\n');
      assert.match(validationGuidance, /run_check is exhausted for the current mutation state and is unavailable now/);
      assert.ok(validationGuidance.includes(${JSON.stringify(expectedFinalGuidance)}));
      assert.doesNotMatch(validationGuidance, /run_check is available once for the current mutation state/);

      await call('edit', { path: 'example.py' });
      assert.ok(active.includes('run_check'), 'a second successful mutation re-exposes run_check after exhaustion');
      active = active.filter(name => name !== 'run_check'); // simulate an unrelated control/runtime removal

      await call('subagents_enable', {}, { enables: 'subagent' });
      assert.ok(!active.includes('run_check'), 'permit gating must not resurrect a tool removed by another owner');
      assert.ok(!active.includes('subagents_enable'), 'subagents_enable removed');
      assert.ok(!active.includes('subagent'), 'subagent hidden while action_required (gate would block it)');
      assert.ok(messages.some(m => /subagents: enabled/.test(m) && /Do not call subagents_enable again/.test(m)));

      const lsp = { server_id: 'python', workspace_root: ctx.cwd };
      await call('lsp_start_server', lsp);
      assert.equal(startups, 1);
      assert.ok(messages.some(m => /python LSP: running/.test(m)));
      const repeat = await call('lsp_start_server', lsp);
      assert.equal(repeat.block, true);
      assert.match(repeat.reason, /ALREADY_SATISFIED/);
      assert.match(repeat.reason, /CURRENTLY EXPOSED TOOLS/);
      assert.equal(startups, 1, 'startup not re-executed');
      const again = await call('subagents_enable');
      assert.match(again.reason, /ALREADY_SATISFIED/);

      // Watchdog: a prose-only turn followed by a repeated satisfied transition is still the
      // second consecutive prose-only turn; the repeat must not reset the counter.
      assert.equal(aborts, 0);
      handlers.get('turn_start')({ turnIndex: turn });
      await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
      assert.equal(aborts, 0);
      handlers.get('turn_start')({ turnIndex: turn });
      const repeated = await handlers.get('tool_call')({ toolName: 'subagents_enable', toolCallId: 'r' + turn, input: {} }, ctx);
      assert.equal(repeated.alreadySatisfied, true);
      await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
      assert.equal(aborts, 1, 'already_satisfied repeat did not reset the prose-only counter');

      // Failed-check recovery is exercised through the real runtime hooks, not
      // by regex-matching pi-agent-runtime.mjs source text.
      const appendRuntimeCheck = (status, scope = { paths: ['example.py'] }, summary = status) => {
        fs.appendFileSync(process.env.PI_VALIDATION_LEDGER_FILE, JSON.stringify({
          kind: 'python_compile',
          scope,
          status,
          exit_code: status === 'pass' ? 0 : 1,
          source: 'run_check',
          stage: 'implementer',
          backend: 'pi',
          run_id: 'runtime-test-1',
          attempt_id: 'primary',
          diagnostics_count: status === 'fail' ? 1 : 0,
          summary,
          infrastructure: status === 'infra_error'
            ? { component: 'sandbox', code: 'SANDBOX_EXECUTOR_ERROR' }
            : null,
        }) + '\\n');
      };

      // The earlier unrelated-owner scenario deliberately removed run_check.
      // An unresolved failure must not let retry_last_failed_check resurrect
      // verification capability that another owner took away.
      appendRuntimeCheck('fail', { paths: ['example.py'] }, 'focused failure');
      handlers.get('turn_start')({ turnIndex: turn });
      assert.ok(!active.includes('run_check'));
      assert.ok(!active.includes('retry_last_failed_check'), 'exact retry does not resurrect an externally removed run_check');

      // Model that external owner explicitly enabling verification again. The
      // runtime may now substitute its deterministic exact retry.
      active.push('run_check');
      handlers.get('turn_start')({ turnIndex: turn });
      assert.ok(active.includes('retry_last_failed_check'), 'runtime activates exact retry once run_check capability is present');
      assert.ok(active.includes('rollback_last_mutation'), 'rollback remains available during recovery');
      assert.ok(active.includes('need_more_evidence'), 'one-evidence escape remains available during recovery');
      assert.ok(active.includes('submit_result'), 'terminal submission remains available during recovery');
      assert.ok(!active.includes('run_check'), 'arbitrary run_check is hidden while exact recovery is actionable');

      const broader = await handlers.get('tool_call')({
        toolName: 'run_check',
        toolCallId: 'broader-' + turn,
        input: { kind: 'python_compile', paths: ['example.py', 'other.py'] },
      }, ctx);
      assert.equal(broader.block, true);
      assert.match(broader.reason, /retry_last_failed_check/);

      const submitEvent = {
        toolName: 'submit_result',
        toolCallId: 'submit-pending-' + turn,
        input: {},
      };
      const submitWhilePending = await handlers.get('tool_call')(submitEvent, ctx);
      assert.equal(submitWhilePending, undefined, 'recovery never deadlocks terminal submission');
      await handlers.get('tool_execution_end')({
        ...submitEvent,
        isError: true,
        result: { content: [{ type: 'text', text: 'stub terminal tool did not actually exit' }] },
      }, ctx);

      // Leaving action_required removes the recovery substitution instead of
      // exposing run_check while hard-blocking it with an invisible retry tool.
      await call('need_more_evidence', { missing: 'one fact', reason: 'exercise recovery surface' });
      assert.ok(!active.includes('retry_last_failed_check'), 'exact retry is action-phase only');
      assert.ok(active.includes('run_check'), 'ordinary run_check surface returns outside action_required');
      const hiddenRetry = await handlers.get('tool_call')({
        toolName: 'retry_last_failed_check',
        toolCallId: 'hidden-retry-' + turn,
        input: {},
      }, ctx);
      assert.equal(hiddenRetry.block, true, 'a hidden retry cannot execute outside its action surface');
      assert.match(hiddenRetry.reason, /not available in the current action state/);
      const outsideActionCheck = {
        toolName: 'run_check',
        toolCallId: 'outside-action-check-' + turn,
        input: { kind: 'python_compile', paths: ['example.py', 'other.py'] },
      };
      const outsideActionBlocked = await handlers.get('tool_call')(outsideActionCheck, ctx);
      assert.equal(outsideActionBlocked, undefined, 'recovery hard-block is tied to the action-phase retry surface');
      await handlers.get('tool_execution_end')({
        ...outsideActionCheck,
        isError: true,
        result: { content: [{ type: 'text', text: 'stub check not executed' }] },
      }, ctx);

      // A relevant mutation returns to action_required and re-arms exactly one
      // verification permit, so the exact retry substitutes for run_check again.
      await call('edit', { path: 'example.py' });
      assert.ok(active.includes('retry_last_failed_check'));
      assert.ok(!active.includes('run_check'));

      const retryEvent = { toolName: 'retry_last_failed_check', toolCallId: 'retry-pass-' + turn, input: {} };
      assert.equal(await handlers.get('tool_call')(retryEvent, ctx), undefined, 'exact retry is accepted through the normal run_check permit');
      appendRuntimeCheck('pass', { paths: ['example.py'] }, 'exact retry passed');
      await handlers.get('tool_execution_end')({
        ...retryEvent,
        isError: false,
        result: { content: [{ type: 'text', text: '{"status":"pass"}' }] },
      }, ctx);
      assert.ok(!active.includes('retry_last_failed_check'), 'successful exact retry clears recovery');
      assert.ok(!active.includes('run_check'), 'consumed permit keeps run_check hidden until another mutation');

      await call('edit', { path: 'example.py' });
      assert.ok(active.includes('run_check'), 'ordinary run_check is restored after recovery clears and a later mutation grants a permit');
      assert.ok(!active.includes('retry_last_failed_check'));

      // A new failure followed by an exact infrastructure error must end the
      // forced-retry episode. Verification remains fail-closed in the ledger,
      // but runtime must not keep steering into a broken sandbox.
      appendRuntimeCheck('fail', { paths: ['example.py'] }, 'second failure');
      handlers.get('turn_start')({ turnIndex: turn });
      assert.ok(active.includes('retry_last_failed_check'));
      const infraRetry = { toolName: 'retry_last_failed_check', toolCallId: 'retry-infra-' + turn, input: {} };
      assert.equal(await handlers.get('tool_call')(infraRetry, ctx), undefined);
      appendRuntimeCheck('infra_error', { paths: ['example.py'] }, 'sandbox unavailable');
      await handlers.get('tool_execution_end')({
        ...infraRetry,
        isError: false,
        result: { content: [{ type: 'text', text: '{"status":"infra_error"}' }] },
      }, ctx);
      assert.ok(!active.includes('retry_last_failed_check'), 'infra_error closes forced retry instead of looping');

      await call('edit', { path: 'example.py' });
      assert.ok(active.includes('run_check'), 'after infra exit a later mutation exposes ordinary verification rather than forced retry');
      assert.ok(!active.includes('retry_last_failed_check'));

      // Defensive legacy/malformed history: a fail with an unreconstructable
      // whole_repo scope must never replace ordinary run_check with a retry
      // tool that can only throw.
      appendRuntimeCheck('fail', { whole_repo: true }, 'legacy whole-repo failure');
      handlers.get('turn_start')({ turnIndex: turn });
      assert.ok(active.includes('run_check'), 'unreconstructable recovery history leaves ordinary run_check available');
      assert.ok(!active.includes('retry_last_failed_check'), 'unreconstructable recovery history never exposes a dead-end retry tool');

      fs.appendFileSync(process.env.PI_VALIDATION_LEDGER_FILE, '{"broken":');
      handlers.get('turn_start')({ turnIndex: ++turn });
      assert.ok(active.includes('run_check'), 'corrupt ledger does not permanently disable new local verification');
      assert.ok(!active.includes('retry_last_failed_check'), 'corrupt ledger hides exact retry because historical scope is unknowable');
      assert.ok(active.includes('submit_result'), 'corrupt ledger still allows terminal submission while final verification remains fail-closed');
      const corruptCheckEvent = {
        toolName: 'run_check',
        toolCallId: 'corrupt-check-' + turn,
        input: { kind: 'python_compile', paths: ['example.py'] },
      };
      const corruptCheck = await handlers.get('tool_call')(corruptCheckEvent, ctx);
      assert.equal(corruptCheck, undefined, 'ordinary run_check remains usable after ledger corruption');
      await handlers.get('tool_execution_end')({
        ...corruptCheckEvent,
        isError: true,
        result: { content: [{ type: 'text', text: 'stub check not executed' }] },
      }, ctx);
      const corruptRetry = await handlers.get('tool_call')({
        toolName: 'retry_last_failed_check',
        toolCallId: 'corrupt-retry-' + turn,
        input: {},
      }, ctx);
      assert.equal(corruptRetry.block, true);
      assert.match(corruptRetry.reason, /ledger is corrupted/);
    `;
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_ISSUE_CONTEXT: context,
        GITHUB_RUN_ID: 'runtime-test', GITHUB_RUN_ATTEMPT: '1',
        PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false', PI_VALIDATION_LEDGER_FILE: ledger,
        PI_SUBAGENT_RESPONSE_MAX_TOKENS: '2048' },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const logs = result.stdout + result.stderr;
    for (const marker of ['PI_STATE_TRANSITION_COMPLETE', 'PI_SESSION_STATE', 'PI_TOOL_SURFACE_UPDATE', 'PI_ALREADY_SATISFIED']) {
      assert.match(logs, new RegExp(marker), marker);
    }
    assert.match(logs, /PI_SESSION_STATE .*"activeTools":\[/, 'transition log includes the authoritative active surface');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
