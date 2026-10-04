import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { PREPARATION_FALLBACK_EVIDENCE_BUDGET, ProgressController } from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

// Bootstrap resolves preparation before the main session exists, so the controller is born prepared.
function fallbackController() {
  const state = new ProgressController(stageConfig('implementer'), {});
  state.applyPreparedImplementation({ status: 'fallback', failureClass: 'preparation_infrastructure_failure', reason: 'planner down' });
  return state;
}

function preparedController({ evidenceBudget, largeMutation = false, complexity = 'nontrivial' }) {
  const state = new ProgressController(stageConfig('implementer'), {});
  state.applyPreparedImplementation({
    status: 'prepared', plan: ['step'], complexity, evidenceBudget, largeMutation, reason: 'because',
  });
  return state;
}

test('fallback satisfies preparation without fabricating complexity, and an unprepared controller fails closed', () => {
  const unprepared = new ProgressController(stageConfig('implementer'), {});
  for (const tool of ['write', 'edit', 'safe_edit', 'request_large_mutation_budget', 'run_check', 'read', 'prepare_implementation']) {
    assert.equal(unprepared.checkToolCall(tool, {}).block, true, tool);
  }
  const state = fallbackController();
  assert.equal(state.preparationState, 'PREPARATION_FALLBACK');
  assert.equal(state.preparationSatisfied(), true);
  assert.equal(state.complexityRecorded(), false);
  assert.equal(state.complexity, null);
  state.onTurnStart(10);
  assert.equal(state.preComplexityActionRequired(), false);
  assert.equal(state.currentMaxTokens(), 2048);
  assert.equal(state.largeMutationBudgetState, 'idle');
});

test('the Implementer stage no longer defines a preparation tool or pre-complexity transition', () => {
  const config = stageConfig('implementer');
  assert.deepEqual(config.preComplexityAllowedTools ?? [], []);
  assert.deepEqual(config.preComplexityTransitionTools ?? [], []);
  assert.deepEqual(config.singleUseTools ?? [], []);
  assert.equal(config.productiveProgress.activationTool, undefined);
  assert.equal(config.implementationPlannerTimeoutMs, 900000, 'bootstrap planner hard maximum is 15 minutes');
});

test('fallback grants the bounded evidence window and closes it on exhaustion or mutation', () => {
  const exhausted = fallbackController();
  assert.equal(exhausted.productiveProgressState(), 'evidence_allowed');
  assert.equal(exhausted.checkToolCall('run_check', {}).block, true, 'verification still requires mutation');
  assert.equal(exhausted.checkToolCall('request_large_mutation_budget', {}).block, true);
  for (const tool of ['write', 'edit', 'safe_edit', 'structural_edit', 'submit_result']) {
    assert.equal(fallbackController().checkToolCall(tool, {}), undefined, tool + ' remains allowed during fallback evidence');
  }
  for (let i = 0; i < PREPARATION_FALLBACK_EVIDENCE_BUDGET; i++) {
    assert.equal(exhausted.checkToolCall('read', { path: 'evidence-' + i }), undefined);
    assert.equal(
      exhausted.productiveProgressState(),
      i === PREPARATION_FALLBACK_EVIDENCE_BUDGET - 1 ? 'action_required' : 'evidence_allowed',
    );
  }
  assert.equal(exhausted.checkToolCall('read', { path: 'after-budget' }).block, true);

  const failed = fallbackController();
  for (let i = 0; i < PREPARATION_FALLBACK_EVIDENCE_BUDGET; i++) {
    assert.equal(failed.checkToolCall('read', { path: 'missing-' + i }), undefined);
    failed.onToolExecutionEnd('read', true);
  }
  assert.equal(failed.productiveProgressState(), 'action_required', 'failed evidence still consumes accepted attempts');
  assert.equal(failed.checkToolCall('read', { path: 'still-blocked' }).block, true);
  assert.equal(
    failed.checkToolCall('need_more_evidence', { missing: 'layout', reason: 'accepted attempts produced no usable evidence' }),
    undefined,
    'post-window escape hatch remains available after failed evidence attempts',
  );
  assert.equal(failed.checkToolCall('read', { path: 'retry-after-blocker' }), undefined);

  const mutated = fallbackController();
  assert.equal(mutated.checkToolCall('read', { path: 'src' }), undefined);
  assert.equal(mutated.productiveProgressState(), 'evidence_allowed');
  assert.equal(mutated.checkToolCall('write', { path: 'example.py', content: 'x' }), undefined);
  mutated.onToolExecutionEnd('write', false);
  assert.equal(mutated.productiveProgressState(), 'action_required');
  assert.equal(mutated.checkToolCall('read', { path: 'tests' }).block, true);
  assert.equal(mutated.checkToolCall('run_check', {}), undefined, 'successful mutation grants verification');
});

test('automatic large mutation budget waits for evidence completion and remains one-shot', () => {
  const state = preparedController({ evidenceBudget: 1, largeMutation: true });
  assert.equal(state.automaticLargeMutationBudgetArmed, true);
  assert.equal(state.productiveProgressState(), 'evidence_allowed');
  assert.equal(state.maybeGrantAutomaticLargeMutationBudget(), false);
  assert.equal(state.largeMutationBudgetState, 'idle');

  assert.equal(state.checkToolCall('read', { path: 'src/example.py' }), undefined);
  state.onToolExecutionEnd('read', false);
  assert.equal(state.productiveProgressState(), 'action_required');
  assert.equal(state.maybeGrantAutomaticLargeMutationBudget(), true);
  assert.equal(state.largeMutationBudgetPending(), true);
  assert.equal(state.activateLargeMutationBudget(), true);
  assert.equal(state.checkToolCall('read', { path: 'src/other.py' }).block, true);
  assert.equal(state.checkToolCall('write', { path: 'src/example.py' }), undefined);
  state.onToolExecutionEnd('write', false);
  assert.equal(state.resetLargeMutationBudget(), true);
  assert.equal(state.largeMutationBudgetState, 'idle');
  assert.equal(state.maybeGrantAutomaticLargeMutationBudget(), false, 'automatic grant is not reusable');
});

test('automatic large mutation intent is discarded by a direct mutation before activation', () => {
  const state = preparedController({ evidenceBudget: 2, largeMutation: true });
  assert.equal(state.productiveProgressState(), 'evidence_allowed');

  assert.equal(state.checkToolCall('safe_edit', { path: 'src/example.py' }), undefined);
  state.onToolExecutionEnd('safe_edit', false);
  assert.equal(state.productiveProgressState(), 'action_required');
  assert.equal(state.automaticLargeMutationBudgetArmed, false);
  assert.equal(state.maybeGrantAutomaticLargeMutationBudget(), false, 'stale planner intent must not grant a later action');
});

test('zero-evidence automatic large mutation is pending from the first main request', () => {
  const state = preparedController({ evidenceBudget: 0, largeMutation: true });
  assert.equal(state.productiveProgressState(), 'action_required');
  assert.equal(state.checkToolCall('read', { path: 'src/example.py' }).block, true, 'zero evidence starts action-required');
  assert.equal(state.maybeGrantAutomaticLargeMutationBudget(), true);
  assert.equal(state.largeMutationBudgetPending(), true);
});

test('explicit large mutation request clears any planner-owned armed intent', () => {
  const state = preparedController({ evidenceBudget: 1, largeMutation: true });
  assert.equal(state.productiveProgressState(), 'evidence_allowed');

  assert.equal(state.checkToolCall('read', { path: 'src/example.py' }), undefined);
  state.onToolExecutionEnd('read', false);
  assert.equal(state.productiveProgressState(), 'action_required');

  assert.equal(state.checkToolCall('request_large_mutation_budget', { reason: 'explicit fallback' }), undefined);
  state.onToolExecutionEnd('request_large_mutation_budget', false);
  assert.equal(state.automaticLargeMutationBudgetArmed, false);
  assert.equal(state.largeMutationBudgetPending(), true);
});

test('a positive planner evidence_budget starts evidence_allowed with exactly that many attempts', () => {
  const state = preparedController({ evidenceBudget: 2 });
  assert.equal(state.complexity, 'nontrivial');
  assert.equal(state.productiveProgressState(), 'evidence_allowed');
  assert.equal(state.checkToolCall('read', { path: 'a' }), undefined);
  assert.equal(state.productiveProgressState(), 'evidence_allowed');
  assert.equal(state.checkToolCall('read', { path: 'b' }), undefined);
  assert.equal(state.productiveProgressState(), 'action_required');
  assert.equal(state.checkToolCall('read', { path: 'c' }).block, true);
});

test('fallback preserves one-shot mutation budget and post-window evidence escape hatch', () => {
  const state = fallbackController();
  for (let i = 0; i < PREPARATION_FALLBACK_EVIDENCE_BUDGET; i++) {
    assert.equal(state.checkToolCall('read', { path: 'evidence-' + i }), undefined);
  }
  assert.equal(state.checkToolCall('request_large_mutation_budget', {}), undefined);
  state.onToolExecutionEnd('request_large_mutation_budget', false);
  assert.equal(state.largeMutationBudgetPending(), true);
  assert.equal(state.activateLargeMutationBudget(), true);
  assert.equal(state.checkToolCall('read', {}).block, true, 'elevated response remains mutation-only');
  assert.equal(state.checkToolCall('write', {}), undefined);
  state.onToolExecutionEnd('write', false);
  state.resetLargeMutationBudget();
  assert.equal(state.checkToolCall('run_check', {}), undefined);
  state.onToolExecutionEnd('run_check', false);
  assert.equal(state.checkToolCall('run_check', {}).block, true);
  assert.equal(state.checkToolCall('submit_result', {}), undefined);

  for (const tool of ['read', 'repo_search', 'lsp_goto_definition', 'subagent']) {
    const evidence = fallbackController();
    for (let i = 0; i < PREPARATION_FALLBACK_EVIDENCE_BUDGET; i++) {
      assert.equal(evidence.checkToolCall('read', { path: 'evidence-' + i }), undefined);
    }
    assert.equal(evidence.checkToolCall('need_more_evidence', { missing: 'target', reason: 'resolve edit' }), undefined);
    assert.equal(evidence.checkToolCall(tool, {}), undefined, tool);
    assert.equal(evidence.productiveProgressState(), 'action_required');
  }
});

// Exercise the real runtime, including delegation retry and event-driven tool surfaces.
// Only typebox's schema builders are stubbed; no planner/state-machine logic is replaced.
function runtimeScenario(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preparation-'));
  try {
    const context = path.join(dir, 'issue.json');
    const loader = path.join(dir, 'loader.mjs');
    const issue = mode === 'layout-aware'
      ? {
          title: '[Workflow smoke] Add smoke widget parser',
          body: 'Add `demo_pkg.diagnostics.smoke_widget.parse_widget` in a new diagnostics module with focused pytest coverage.',
        }
      : mode === 'non-additive-target'
        ? {
            title: 'Adjust existing parser',
            body: 'Update `demo_pkg.diagnostics.parse_widget` and `demo_pkg.diagnostics.Parser.parse_widget` with focused tests.',
          }
        : mode === 'small-auto'
          ? {
              title: 'Rename one config label',
              body: 'Change the single label in config.py from old to new.',
            }
          : { title: 'Example task', body: 'Implement example.py' };
    fs.writeFileSync(context, mode === 'invalid-context' ? '{' : JSON.stringify(issue));
    if (mode === 'small-auto') fs.writeFileSync(path.join(dir, 'config.py'), 'old\n');
    if (mode === 'layout-aware' || mode === 'non-additive-target') {
      fs.mkdirSync(path.join(dir, 'src', 'demo_pkg', 'diagnostics'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'tests', 'diagnostics'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'demo_pkg', '__init__.py'), '');
      fs.writeFileSync(path.join(dir, 'src', 'demo_pkg', 'diagnostics', '__init__.py'), '');
      fs.writeFileSync(path.join(dir, 'src', 'demo_pkg', 'diagnostics', 'smoke_ratio.py'), 'def ratio(): return 1\n');
      fs.writeFileSync(path.join(dir, 'src', 'demo_pkg', 'diagnostics', 'smoke_chunks.py'), 'def chunks(): return []\n');
      fs.writeFileSync(path.join(dir, 'tests', 'diagnostics', 'test_smoke_ratio.py'), 'def test_ratio(): pass\n');
      fs.writeFileSync(path.join(dir, 'tests', 'diagnostics', 'test_smoke_chunks.py'), 'def test_chunks(): pass\n');
      if (mode === 'non-additive-target') {
        fs.writeFileSync(path.join(dir, 'src', 'demo_pkg', 'diagnostics', '__init__.py'), 'def parse_widget(): return 1\n');
      }
    }
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Preparation Test']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'preparation@example.invalid']);
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'base']);
    execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD']);
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
      import { EventEmitter } from 'node:events';
      const { default: runtime } = await import(${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)});
      const { default: bootstrap } = await import(${JSON.stringify(new URL('../scripts/pi-implementer-bootstrap.mjs', import.meta.url).href)});
      const planner = await import(${JSON.stringify(new URL('../scripts/pi-common/implementation-planner.mjs', import.meta.url).href)});
      const { stageConfig } = await import(${JSON.stringify(new URL('../scripts/pi-common/stage-config.mjs', import.meta.url).href)});
      const mode = ${JSON.stringify(mode)};
      const fallbackEvidenceBudget = ${PREPARATION_FALLBACK_EVIDENCE_BUDGET};
      const bus = new EventEmitter();
      const tools = new Map();
      const handlers = new Map();
      const messages = [];
      const caps = [];
      let active = ['read', 'write', 'edit', 'safe_edit', 'accept_mutation_scope', 'run_check', 'submit_result', 'need_more_evidence', 'request_large_mutation_budget'];
      let attempts = 0;
      let aborts = 0;
      let shutdowns = 0;
      const ctx = { cwd: ${JSON.stringify(dir)}, model: { maxTokens: 32000 },
        sessionManager: { getSessionId: () => 'parent' }, abort: () => { aborts++; }, shutdown: () => { shutdowns++; } };
      const bootstrapCtx = { ...ctx, sessionManager: { getSessionId: () => 'bootstrap-session' } };
      const artifactFile = process.env.PI_PREPARED_IMPLEMENTATION_FILE;
      const signal = new AbortController();
      const pi = {
        events: { on: (event, fn) => { bus.on(event, fn); return () => bus.off(event, fn); }, emit: (...args) => bus.emit(...args) },
        registerTool: tool => tools.set(tool.name, tool),
        on: (name, fn) => handlers.set(name, fn),
        getActiveTools: () => [...active], setActiveTools: names => { active = names; },
        setModel: async model => { caps.push(model.maxTokens); return true; },
        sendUserMessage: async text => { messages.push(text); },
      };
      bus.on('prompt-template:subagent:request', request => {
        attempts++;
        assert.equal(request.agent, 'implementation-planner');
        if (mode === 'layout-aware') {
          assert.match(request.task, /Add smoke widget parser/);
          assert.match(request.task, /source_root=src/);
          assert.ok(request.task.includes('source_target=src/demo_pkg/diagnostics/smoke_widget.py'));
          assert.ok(request.task.includes('nearest_source_convention=src/demo_pkg/diagnostics/smoke_chunks.py'));
          assert.ok(request.task.includes('test_directory=tests/diagnostics'));
          assert.ok(request.task.includes('nearest_test_convention=tests/diagnostics/test_smoke_chunks.py'));
          assert.ok(request.task.includes('inspect only the nearest relevant sibling source/test'));
          assert.match(request.task, /do not spend evidence re-proving fresh-worktree provenance/);
        } else if (mode === 'non-additive-target') {
          assert.match(request.task, /Adjust existing parser/);
          assert.doesNotMatch(request.task, /Runtime repository layout hint/);
          assert.doesNotMatch(request.task, /source_target=/);
        } else if (mode === 'small-auto') {
          assert.match(request.task, /Rename one config label/);
          assert.match(request.task, /single label in config\.py/);
        } else {
          assert.match(request.task, /Example task/);
          assert.match(request.task, /Implement example.py/);
        }
        assert.equal(request.ownerRunId, 'bootstrap-session', 'planner is hosted by the bootstrap session, never the main one');
        if (attempts === 1) assert.ok(request.timeoutMs <= 900000 && request.timeoutMs > 890000, '15 minute hard planner deadline');
        else assert.ok(request.timeoutMs <= 900000 && request.timeoutMs > 0, 'retry only gets the remaining deadline');
        assert.equal(process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, '2048');
        if (mode === 'abort') { signal.abort(); return; }
        const good = mode === 'layout-aware'
          ? {
              steps: ['Read the nearest smoke convention once, then add the module and focused tests'],
              complexity: 'nontrivial',
              evidence_budget: 1,
              large_mutation: true,
              reason: 'Layout is resolved and the new module plus tests need a large write',
            }
          : mode === 'small-auto'
            ? {
                steps: ['Change the one config label'],
                complexity: 'trivial',
                evidence_budget: 0,
                large_mutation: false,
                reason: 'One bounded line replacement',
              }
            : {
                steps: ['Implement example.py'],
                complexity: 'nontrivial',
                evidence_budget: 2,
                large_mutation: false,
                reason: 'Needs source evidence',
              };
        const schemaError = 'Structured output validation failed: value: must have required properties value; steps: schema is false; root: must not have additional properties';
        let reply;
        if (mode === 'envelope-retry') {
          if (attempts === 1) assert.doesNotMatch(request.task, /REPAIR/);
          else {
            const repairAt = request.task.indexOf('REPAIR: the previous structured_output envelope was rejected');
            const contractAt = request.task.indexOf('Output contract: call structured_output with exactly { "value": { "steps"');
            assert.ok(repairAt >= 0, 'retry prompt carries repair guidance');
            assert.ok(contractAt > repairAt, 'repair guidance immediately precedes the exact output contract');
          }
          reply = attempts === 2 ? { status: 'completed', result: { kind: 'structured', value: good } } : { status: 'failed', error: schemaError };
        } else if (mode === 'envelope-exhausted') reply = { status: 'failed', error: schemaError };
        else if (mode === 'timeout') reply = { status: 'failed', error: 'Subagent timed out after 120000ms.' };
        else if (mode === 'deadline-timeout') reply = { status: 'timed_out', error: 'planner exceeded its deadline' };
        else if (mode === 'bad-output-schema') reply = { status: 'failed', error: 'invalid outputSchema: unsupported keyword' };
        else if (mode === 'overlong') reply = { status: 'completed', result: { kind: 'structured', value: { ...good, steps: ['  ' + 'x'.repeat(300) + '  ', ' short step '], reason: ' padded ' } } };
        else if (mode === 'extra-fields') reply = { status: 'completed', result: { kind: 'structured', value: { ...good, evidence_budget_note: 'extra' } } };
        else if (mode === 'invalid-complexity') reply = { status: 'completed', result: { kind: 'structured', value: { ...good, complexity: 'medium' } } };
        else if (mode === 'missing-reason') reply = { status: 'completed', result: { kind: 'structured', value: { steps: good.steps, complexity: 'trivial', evidence_budget: 1, large_mutation: false } } };
        else if (mode === 'missing-large-mutation') {
          const { large_mutation, ...withoutLargeMutation } = good;
          reply = { status: 'completed', result: { kind: 'structured', value: withoutLargeMutation } };
        }
        else if (mode === 'invalid-large-mutation') reply = { status: 'completed', result: { kind: 'structured', value: { ...good, large_mutation: 'true' } } };
        else if (mode === 'success' || mode === 'layout-aware' || mode === 'non-additive-target' || mode === 'small-auto' || mode === 'retry-success' && attempts === 2) reply = { status: 'completed', result: { kind: 'structured', value: good } };
        else reply = { status: 'failed', error: 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.' };
        if (attempts === 1) {
          const { steps, additionalProperties, required } = request.result.schema;
          assert.equal(steps, undefined);
          assert.equal(request.result.schema.properties.steps.items.maxLength, undefined);
          assert.equal(additionalProperties, true);
          assert.deepEqual(required, ['steps', 'complexity', 'evidence_budget', 'reason']);
          assert.equal(request.result.schema.properties.large_mutation.type, 'boolean');
          assert.match(request.task, /"value"/);
          assert.match(request.task, /large_mutation/);
          assert.match(request.task, /substantial new module plus tests/);
          assert.match(request.task, /240 characters/);
        }
        bus.emit('prompt-template:subagent:response', {
          requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, ...reply,
        });
      });
      const mainPi = pi;
      let artifact = null;
      if (mode === 'abort') {
        const config = stageConfig('implementer');
        await assert.rejects(planner.prepareImplementation(pi, bootstrapCtx, config, signal.signal), /aborted/);
        assert.equal(attempts, 1);
        process.exit(0);
      }
      if (mode !== 'restored') {
        // Session A: separate bootstrap session hosts the planner and shuts down before any model turn.
        const bootstrapHandlers = new Map();
        process.env.PI_IMPLEMENTER_BOOTSTRAP = 'true';
        bootstrap({ ...pi, on: (name, fn) => bootstrapHandlers.set(name, fn) });
        await bootstrapHandlers.get('resources_discover')({}, bootstrapCtx);
        delete process.env.PI_IMPLEMENTER_BOOTSTRAP;
        assert.equal(shutdowns, 1, 'bootstrap session shuts itself down');
        artifact = planner.readPreparedImplementation(artifactFile);
        assert.ok(artifact, 'bootstrap wrote the PreparedImplementation artifact');
        // Hard context boundary: only the normalized artifact crosses, never planner transcript/retries.
        const allowed = ['version', 'status', 'workspaceRoot', 'freshBaseCommit', 'baseRef', 'plan', 'repositoryFacts', 'complexity', 'evidenceBudget', 'largeMutation', 'reason', 'layoutHint', 'plannerUsage', 'plannerDurationMs', 'plannerEvidenceUsed', 'plannerEvidenceCap', 'plannerProviderTurns', 'failureClass'];
        assert.deepEqual(Object.keys(artifact).filter(key => !allowed.includes(key)), []);
      } else {
        assert.equal(fs.existsSync(artifactFile), false, 'restored work never runs fresh planner bootstrap');
      }
      const attemptsBeforeMain = attempts;
      runtime(mainPi);
      assert.equal(attempts, attemptsBeforeMain, 'main runtime never invokes the planner');
      assert.equal(tools.has('prepare_implementation'), false, 'no model-visible preparation tool');
      assert.equal(tools.has('declare_task_complexity'), false);
      assert.equal(active.includes('prepare_implementation'), false);
      tools.get('run_check').execute = async () => ({ content: [{ type: 'text', text: 'check passed' }] });
      let turn = 0;
      async function call(name, input = {}) {
        handlers.get('turn_start')({ turnIndex: turn });
        const event = { toolName: name, toolCallId: name + turn, input };
        assert.equal(await handlers.get('tool_call')(event, ctx), undefined, name);
        let result;
        if (tools.has(name)) result = await tools.get(name).execute(event.toolCallId, input, signal.signal, null, ctx);
        else {
          if (name === 'write') fs.writeFileSync(ctx.cwd + '/example.py', input.content);
          result = { content: [{ type: 'text', text: 'ok' }] };
        }
        await handlers.get('tool_execution_end')({ ...event, isError: false, result }, ctx);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        return result;
      }
      if (mode === 'restored') {
        await call('submit_result');
        assert.equal(attempts, 0);
      } else if (mode === 'invalid-context') {
        assert.equal(attempts, 0);
        assert.equal(artifact.status, 'fallback');
        assert.match(artifact.reason, /JSON|Unexpected end/);
        await call('read', { path: 'example.py' });
        assert.ok(active.includes('write'));
      } else {
        // The first main-session request is born prepared: no tool call exists to obtain the plan.
        const block = planner.preparedImplementationBlock(artifact, { largeMutationArmed: artifact.status === 'prepared' && artifact.largeMutation });
        const prepared = { details: artifact, text: block };
        assert.doesNotMatch(block, /prepare_implementation|REPAIR|structured_output/);
        assert.match(block, /Runtime-prepared implementation state/);
        const oneAttempt = ['success', 'layout-aware', 'non-additive-target', 'small-auto', 'missing-large-mutation', 'invalid-large-mutation', 'timeout', 'deadline-timeout', 'bad-output-schema', 'overlong', 'extra-fields', 'invalid-complexity', 'missing-reason'].includes(mode);
        assert.equal(attempts, oneAttempt ? 1 : 2);
        if (['failure', 'prose', 'envelope-exhausted', 'timeout', 'deadline-timeout', 'bad-output-schema', 'invalid-complexity', 'invalid-large-mutation', 'missing-reason'].includes(mode)) {
          assert.equal(artifact.status, 'fallback');
          assert.equal(artifact.failureClass, mode === 'deadline-timeout' ? 'planner_deadline_timeout' : 'preparation_infrastructure_failure');
          assert.equal('plan' in artifact, false);
          assert.equal('complexity' in artifact, false);
          assert.match(block, /PREPARATION_FALLBACK/);
          assert.match(block, /nothing to prepare or retry/);
          assert.ok(block.includes('canonical source/test layout is not already clear'));
          assert.ok(block.includes('guidance, not a mutation gate'));
          assert.ok(block.includes('up to ' + fallbackEvidenceBudget + ' repository evidence attempts'));
          assert.ok(block.includes('every accepted non-control evidence action consumes one attempt'));
          assert.ok(block.includes('even if it fails or returns no useful result'));
          assert.ok(block.includes('coding-session action becomes valid only after the evidence window is closed'));
          assert.ok(block.includes('Focused verification becomes available only after a successful mutation'));
          assert.ok(!caps.includes(16384), 'fallback alone must not grant large response');
          assert.ok(active.includes('read'));
          assert.ok(active.includes('request_large_mutation_budget'));
          const earlyBudget = await handlers.get('tool_call')({
            toolName: 'request_large_mutation_budget',
            input: { reason: 'too early' },
          }, ctx);
          assert.equal(earlyBudget.block, true);
          assert.match(earlyBudget.reason, /finish gathering evidence first/);
          for (let i = 0; i < fallbackEvidenceBudget; i++) {
            await call('read', { path: 'evidence-' + i });
            assert.equal(active.includes('read'), i < fallbackEvidenceBudget - 1);
          }
          if (mode === 'prose') {
            for (let i = 0; i < 2; i++) {
              handlers.get('turn_start')({ turnIndex: turn });
              await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
            }
          } else {
            await call('request_large_mutation_budget', { reason: 'Complete source payload exceeds default ceiling' });
            assert.equal(caps.at(-1), 16384);
            assert.ok(active.includes('write'));
            assert.ok(!active.includes('read'));
            await call('write', { path: 'example.py', content: 'print("example")\\n' });
            assert.equal(caps.at(-1), 2048);
            assert.ok(active.includes('run_check'));
            await call('run_check', { kind: 'python_compile', scope: ['example.py'] });
            await call('submit_result');
            // Past the startup deadline, a concrete missing fact still opens read/search.
            turn = 10;
            await call('need_more_evidence', { missing: 'Exact edit anchor', reason: 'Resolve target before editing' });
            assert.ok(active.includes('read'));
            await call('read', { path: 'example.py' });
            assert.ok(active.includes('edit'));
            assert.ok(messages.every(text => !text.includes('CLASSIFICATION REQUIRED')));
          }
        } else {
          if (mode === 'layout-aware') {
            assert.deepEqual(prepared.details.plan, ['Read the nearest smoke convention once, then add the module and focused tests']);
            assert.equal(prepared.details.evidenceBudget, 1);
            assert.equal(prepared.details.largeMutation, true);
            assert.deepEqual(prepared.details.layoutHint, {
              dottedTarget: 'demo_pkg.diagnostics.smoke_widget.parse_widget',
              sourceRoot: 'src',
              sourceDirectory: 'src/demo_pkg/diagnostics',
              sourceTarget: 'src/demo_pkg/diagnostics/smoke_widget.py',
              sourceConvention: 'src/demo_pkg/diagnostics/smoke_chunks.py',
              testDirectory: 'tests/diagnostics',
              testTarget: 'tests/diagnostics/test_smoke_widget.py',
              testConvention: 'tests/diagnostics/test_smoke_chunks.py',
            });
            assert.match(prepared.text, /Repository layout hint: source root src/);
            assert.match(prepared.text, /Prefer one targeted convention read if needed/);
            assert.match(prepared.text, /do not broad-search or re-prove the fresh-worktree provenance/);
            assert.match(prepared.text, /Fresh worktree base: latest fetched/);
            assert.match(prepared.text, /Large mutation: auto-arm one-shot/);
            assert.ok(active.includes('read'));
            await call('read', { path: 'src/demo_pkg/diagnostics/smoke_chunks.py' });
            assert.equal(caps.at(-1), 16384, 'new module plus tests is elevated after its evidence read');
            assert.ok(active.includes('write'));
            assert.ok(!active.includes('read'));
            await call('write', { path: 'example.py', content: 'print("large")\\n' });
            assert.equal(caps.at(-1), 2048, 'automatic grant collapses after one mutation response');
          } else if (mode === 'small-auto') {
            assert.deepEqual(prepared.details.plan, ['Change the one config label']);
            assert.equal(prepared.details.evidenceBudget, 0);
            assert.equal(prepared.details.largeMutation, false);
            assert.equal(prepared.details.complexity, 'trivial');
            assert.ok(!caps.includes(16384), 'small edit does not receive the elevated budget');
            await call('safe_edit', {
              path: 'config.py',
              operation: 'replace',
              start_line: 1,
              text: 'new',
              expected_marker: 'old',
            });
            assert.equal(caps.at(-1), 2048);
          } else if (mode === 'non-additive-target') {
            assert.equal(prepared.details.layoutHint, null);
            assert.doesNotMatch(prepared.text, /Repository layout hint:/);
            assert.equal(prepared.details.evidenceBudget, 2);
            assert.equal(prepared.details.largeMutation, false);
            assert.equal(prepared.details.complexity, 'nontrivial');
            assert.ok(active.includes('read'));
          } else {
            assert.deepEqual(prepared.details.plan, mode === 'overlong'
              ? ['x'.repeat(240), 'short step'] : ['Implement example.py']);
            assert.equal(prepared.details.evidenceBudget, 2);
            assert.equal(prepared.details.largeMutation, false);
            assert.equal(prepared.details.complexity, 'nontrivial');
            assert.ok(active.includes('read'));
          }
        }
      }
      assert.equal(aborts, mode === 'prose' ? 1 : 0);
    `;
    // run_check's executor is covered by the sandbox suite; this test verifies its gate/surface.
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_ISSUE_CONTEXT: context,
        PI_RESUME_ACTIVE: mode === 'restored' ? 'true' : 'false', PI_VALIDATION_REPAIR: 'false',
        PI_PREPARED_IMPLEMENTATION_FILE: path.join(dir, 'prepared-implementation.json'),
        PI_ACCEPTED_MUTATION_SCOPE_STATE: "{\"schema_version\":1,\"accepted\":[{\"path\":\"example.py\",\"rationale\":\"Runtime preparation fixture writes the simulated implementation target.\"},{\"path\":\"config.py\",\"rationale\":\"Small-edit preparation fixture mutates the known config target.\"}],\"temporary\":[],\"baseline\":[]}",
        PI_SUBAGENT_RESPONSE_MAX_TOKENS: '2048' },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout + result.stderr;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('layout discovery ignores dotted package members without an explicit module segment', () => {
  const logs = runtimeScenario('non-additive-target');
  assert.doesNotMatch(logs, /PI_PREPARATION_FALLBACK/);
});

test('invalid issue context still enters preparation fallback', () => {
  const logs = runtimeScenario('invalid-context');
  assert.match(logs, /PI_PREPARATION_FALLBACK/);
  assert.doesNotMatch(logs, /PI_PLAN |PI_COMPLEXITY /);
});

test('planner misses structured output twice, then runtime restores the complete execution path', () => {
  const logs = runtimeScenario('failure');
  assert.match(logs, /PI_SUBAGENT_FAILURE .*"attempt":1,"retriesExhausted":false/);
  assert.match(logs, /PI_SUBAGENT_RETRY .*"reason":"missing_structured_output","attempt":1/);
  assert.match(logs, /PI_SUBAGENT_FAILURE .*"attempt":2,"retriesExhausted":true/);
  assert.match(logs, /PI_PREPARATION_FALLBACK .*"recovery":"continue_without_planner_output"/);
  assert.doesNotMatch(logs, /PI_PLAN |PI_COMPLEXITY /);
});

for (const mode of ['success', 'layout-aware', 'non-additive-target', 'small-auto', 'missing-large-mutation', 'retry-success', 'abort', 'restored', 'overlong', 'extra-fields', 'envelope-retry']) {
  test('runtime preserves preparation behavior: ' + mode, () => {
    const logs = runtimeScenario(mode);
    assert.doesNotMatch(logs, /PI_PREPARATION_FALLBACK/);
  });
}

test('new module plus tests automatically receives one elevated mutation response', () => {
  const logs = runtimeScenario('layout-aware');
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"auto_armed"/);
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"auto_pending"/);
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"granted","maxTokens":16384/);
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"consumed","attemptedFinishTool":true/);
});

test('genuinely small edit stays on the normal mutation budget', () => {
  const logs = runtimeScenario('small-auto');
  assert.doesNotMatch(logs, /"phase":"auto_armed"/);
  assert.doesNotMatch(logs, /"phase":"auto_pending"/);
  assert.doesNotMatch(logs, /"phase":"granted","maxTokens":16384/);
});

test('missing large_mutation planner hint defaults safely to the normal budget', () => {
  const logs = runtimeScenario('missing-large-mutation');
  assert.doesNotMatch(logs, /PI_PREPARATION_FALLBACK/);
  assert.doesNotMatch(logs, /"phase":"auto_armed"/);
  assert.doesNotMatch(logs, /"phase":"auto_pending"/);
  assert.doesNotMatch(logs, /"phase":"granted","maxTokens":16384/);
});

test('fallback keeps the execution prose-only guard bounded', () => {
  assert.match(runtimeScenario('prose'), /PI_ACTION_REQUIRED_ABORT: second consecutive prose-only/);
});

test('envelope/schema failure is retried once with repair guidance, then falls back', () => {
  const logs = runtimeScenario('envelope-exhausted');
  assert.match(logs, /PI_SUBAGENT_RETRY .*"reason":"structured_output_schema_failure","attempt":1/);
  assert.match(logs, /PI_SUBAGENT_FAILURE .*"attempt":2,"retriesExhausted":true/);
  assert.match(logs, /PI_PREPARATION_FALLBACK/);
  assert.doesNotMatch(logs, /PI_PLAN |PI_COMPLEXITY /);
});

for (const [mode, pattern] of [
  ['invalid-complexity', /invalid complexity/],
  ['invalid-large-mutation', /invalid large_mutation/],
  ['missing-reason', /unexpected structured fields/],
]) {
  test('normalization fails closed without inventing fields: ' + mode, () => {
    const logs = runtimeScenario(mode);
    assert.match(logs, /PI_PREPARATION_FALLBACK .*/);
    assert.match(logs, pattern);
    assert.doesNotMatch(logs, /PI_PLAN |PI_COMPLEXITY /);
  });
}

// Real #314/#319/#320 smoke runs surfaced `implementation-planner failed: Subagent timed out after 120000ms.`
// after the subagent's in-loop schema retries; retrying would only repeat the 120 s cost.
for (const [mode, pattern] of [['timeout', /timed out after 120000ms/], ['bad-output-schema', /invalid outputSchema/]]) {
  test('unrelated planner failure is not retried: ' + mode, () => {
    const logs = runtimeScenario(mode);
    assert.doesNotMatch(logs, /PI_SUBAGENT_RETRY/);
    assert.match(logs, /PI_SUBAGENT_FAILURE .*"reason":"planner_infrastructure_failure","attempt":1/);
    assert.match(logs, pattern);
    assert.match(logs, /PI_PREPARATION_FALLBACK/);
  });
}

test('planner hard deadline falls back with a distinct, logged failure class', () => {
  const logs = runtimeScenario('deadline-timeout');
  assert.doesNotMatch(logs, /PI_SUBAGENT_RETRY/);
  assert.match(logs, /PI_PREPARATION_FALLBACK .*"failureClass":"planner_deadline_timeout"/);
  assert.doesNotMatch(logs, /PI_PLAN |PI_COMPLEXITY /);
});

test('bootstrap completes and the prepared state is applied before the main session runs', () => {
  const logs = runtimeScenario('success');
  const completed = logs.indexOf('"phase":"planner_completed"');
  const applied = logs.indexOf('"phase":"prepared_state_applied"');
  assert.ok(completed >= 0 && applied > completed, 'planner bootstrap completed BEFORE prepared state applied to the main session');
  assert.match(logs, /PI_PLAN .*"evidenceBudget":2/);
  assert.match(logs, /PI_COMPLEXITY .*"complexity":"nontrivial"/);
  assert.match(logs, /"beforeFirstProviderRequest":true/);
});
