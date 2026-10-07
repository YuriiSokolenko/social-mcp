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
  assert.equal(config.implementationPlannerTimeoutMs, undefined);
  assert.equal(config.implementationPlannerEvidenceBudget, undefined);
  assert.equal(config.implementationPlannerStructuredRetry, undefined);
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
  assert.equal(state.checkToolCall('read', { path: 'src/example.py' }), undefined, 'fresh prepared Main keeps direct read available in action_required');
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
  assert.equal(state.checkToolCall('read', { path: 'c' }), undefined, 'legacy evidence window closes into fresh Main direct access');
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

// Exercise the real bootstrap/runtime boundary with opaque Planner text.
// Only typebox's schema builders are stubbed; no Planner/state-machine logic is replaced.
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
      : { title: 'Example task', body: 'Implement example.py' };
    fs.writeFileSync(context, mode === 'invalid-context' ? '{' : JSON.stringify(issue));
    if (mode === 'layout-aware') {
      fs.mkdirSync(path.join(dir, 'src', 'demo_pkg', 'diagnostics'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'tests', 'diagnostics'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'demo_pkg', '__init__.py'), '');
      fs.writeFileSync(path.join(dir, 'src', 'demo_pkg', 'diagnostics', '__init__.py'), '');
      fs.writeFileSync(path.join(dir, 'src', 'demo_pkg', 'diagnostics', 'smoke_chunks.py'), 'def chunks(): return []\n');
      fs.writeFileSync(path.join(dir, 'tests', 'diagnostics', 'test_smoke_chunks.py'), 'def test_chunks(): pass\n');
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
      const bus = new EventEmitter();
      const tools = new Map();
      const handlers = new Map();
      const messages = [];
      let active = ['read', 'repo_search', 'indexed_repo_search', 'bash', 'write', 'edit', 'safe_edit', 'accept_mutation_scope', 'run_check', 'submit_result', 'need_more_evidence', 'request_large_mutation_budget'];
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
        getActiveTools: () => [...active],
        setActiveTools: names => { active = names; },
        setModel: async () => true,
        sendUserMessage: async text => { messages.push(text); },
      };

      const finalText = mode === 'layout-aware'
        ? 'Create src/demo_pkg/diagnostics/smoke_widget.py and focused tests. Follow tests/diagnostics/test_smoke_chunks.py. Literal type: social_mcp.diagnostics.<module>.'
        : '## Plan\\nImplement example.py. Preserve "quoted" values and \`social_mcp.diagnostics.<module>\`.';

      bus.on('prompt-template:subagent:request', request => {
        attempts++;
        assert.equal(request.agent, 'implementation-planner');
        assert.equal(request.ownerRunId, 'bootstrap-session');
        assert.equal('timeoutMs' in request, false);
        assert.equal('toolBudget' in request, false);
        assert.equal(request.result.kind, 'text');
        assert.equal('schema' in request.result, false);
        assert.equal(process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, '2048');
        assert.match(request.task, /plain-text or Markdown assistant response/i);
        assert.doesNotMatch(request.task, /<plan|XML REPAIR|canonical valid XML/i);
        if (mode === 'layout-aware') {
          assert.match(request.task, /Add smoke widget parser/);
          assert.ok(request.task.includes('src/demo_pkg/diagnostics/smoke_widget.py'));
          assert.ok(request.task.includes('tests/diagnostics/test_smoke_chunks.py'));
        }
        if (mode === 'abort') {
          signal.abort();
          return;
        }

        let reply;
        if (mode === 'provider-error') {
          reply = { status: 'failed', error: 'provider rejected delegated planner request' };
        } else if (mode === 'transport-timeout') {
          reply = { status: 'timed_out', error: 'delegated planner transport timed out' };
        } else if (mode === 'empty') {
          reply = { status: 'completed', finishReason: 'stop', usage: { turns: 1, output: 1 }, result: { kind: 'text', text: '   ' } };
        } else if (mode === 'truncated') {
          reply = { status: 'completed', finishReason: 'length', usage: { turns: 1, output: 2048 }, result: { kind: 'text', text: 'partial plan' } };
        } else {
          reply = { status: 'completed', finishReason: 'stop', usage: { turns: 1, input: 20, output: 40 }, result: { kind: 'text', text: finalText } };
        }
        bus.emit('prompt-template:subagent:response', {
          requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, ...reply,
        });
      });

      if (mode === 'abort') {
        await assert.rejects(
          planner.prepareImplementation(pi, bootstrapCtx, stageConfig('implementer'), signal.signal),
          /aborted/,
        );
        assert.equal(attempts, 1);
        process.exit(0);
      }

      const bootstrapHandlers = new Map();
      process.env.PI_IMPLEMENTER_BOOTSTRAP = 'true';
      bootstrap({ ...pi, on: (name, fn) => bootstrapHandlers.set(name, fn) });
      await bootstrapHandlers.get('resources_discover')({}, bootstrapCtx);
      delete process.env.PI_IMPLEMENTER_BOOTSTRAP;
      assert.equal(shutdowns, 1);
      const artifact = planner.readPreparedImplementation(artifactFile);
      assert.ok(artifact);

      if (mode === 'invalid-context') {
        assert.equal(attempts, 0);
        assert.equal(artifact.status, 'fallback');
      } else if (mode === 'empty') {
        assert.equal(attempts, 1);
        assert.equal(artifact.status, 'fallback');
        assert.equal(artifact.failureClass, 'planner_empty_final');
      } else if (mode === 'truncated') {
        assert.equal(attempts, 1);
        assert.equal(artifact.status, 'fallback');
        assert.equal(artifact.failureClass, 'planner_truncated_final');
      } else if (mode === 'transport-timeout') {
        assert.equal(attempts, 1);
        assert.equal(artifact.status, 'fallback');
        assert.equal(artifact.failureClass, 'planner_transport_timeout');
      } else if (mode === 'provider-error') {
        assert.equal(attempts, 1);
        assert.equal(artifact.status, 'fallback');
        assert.equal(artifact.failureClass, 'preparation_infrastructure_failure');
      } else {
        assert.equal(attempts, 1);
        assert.equal(artifact.status, 'prepared');
        assert.equal(artifact.planText, finalText);
        assert.equal(artifact.complexity, 'nontrivial');
        assert.deepEqual(artifact.requiredMutationAnchors, []);
        assert.equal(artifact.largeMutation, false);
        const block = planner.preparedImplementationBlock(artifact);
        assert.match(block, /untrusted task data/i);
        assert.ok(block.includes('social_mcp.diagnostics.'));
        assert.equal(block.includes('social_mcp.diagnostics.<module>'), false, 'tag-like Planner text stays encoded inside the trusted envelope');
        assert.doesNotMatch(block, /Repository layout hint/);
      }

      const attemptsBeforeMain = attempts;
      runtime(pi);
      assert.equal(attempts, attemptsBeforeMain, 'main runtime never invokes Planner');
      handlers.get('turn_start')({ turnIndex: 0 });

      if (artifact.status === 'prepared') {
        assert.ok(active.includes('read'));
        assert.ok(active.includes('repo_search'));
        assert.ok(active.includes('write'));
        assert.ok(!messages.some(text => /CLASSIFICATION REQUIRED/.test(text)));
      } else {
        assert.ok(active.includes('read'), 'fallback evidence window remains available');
      }
      assert.equal(aborts, 0);
    `;

    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PI_STAGE: 'implementer',
        PI_ISSUE_CONTEXT: context,
        PI_RESUME_ACTIVE: 'false',
        PI_VALIDATION_REPAIR: 'false',
        PI_PREPARED_IMPLEMENTATION_FILE: path.join(dir, 'prepared-implementation.json'),
        PI_ACCEPTED_MUTATION_SCOPE_STATE: '{"schema_version":1,"accepted":[],"temporary":[],"baseline":[]}',
        PI_SUBAGENT_RESPONSE_MAX_TOKENS: '2048',
      },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout + result.stderr;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const mode of ['success', 'layout-aware', 'abort']) {
  test('runtime accepts plain-text Planner lifecycle: ' + mode, () => {
    const logs = runtimeScenario(mode);
    assert.doesNotMatch(logs, /PI_PREPARATION_FALLBACK/);
    assert.doesNotMatch(logs, /PI_PLANNER_XML_|XML REPAIR/);
  });
}

test('successful Planner state is applied before the main session and uses harness-owned defaults', () => {
  const logs = runtimeScenario('success');
  const completed = logs.indexOf('"phase":"planner_completed"');
  const applied = logs.indexOf('"phase":"prepared_state_applied"');
  assert.ok(completed >= 0 && applied > completed);
  assert.match(logs, /PI_PLAN .*"planTextBytes":/);
  assert.match(logs, /PI_COMPLEXITY .*"complexity":"nontrivial"/);
  assert.match(logs, /PI_COMPLEXITY .*"source":"implementation-planner-harness-default"/);
  assert.doesNotMatch(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"auto_armed"/);
  assert.match(logs, /"beforeFirstProviderRequest":true/);
});

test('invalid issue context enters preparation fallback without invoking Planner', () => {
  const logs = runtimeScenario('invalid-context');
  assert.match(logs, /PI_PREPARATION_FALLBACK/);
  assert.doesNotMatch(logs, /PI_PLAN |PI_COMPLEXITY /);
});

test('empty Planner final text falls back after one request with no format repair', () => {
  const logs = runtimeScenario('empty');
  assert.match(logs, /PI_PREPARATION_FALLBACK .*"failureClass":"planner_empty_final"/);
  assert.doesNotMatch(logs, /PI_PLANNER_XML_|XML REPAIR|PI_SUBAGENT_RETRY/);
});

test('truncated Planner final text falls back after one request with no format repair', () => {
  const logs = runtimeScenario('truncated');
  assert.match(logs, /PI_PREPARATION_FALLBACK .*"failureClass":"planner_truncated_final"/);
  assert.doesNotMatch(logs, /PI_PLANNER_XML_|XML REPAIR|PI_SUBAGENT_RETRY/);
});

test('provider infrastructure failure is not parent-retried', () => {
  const logs = runtimeScenario('provider-error');
  assert.match(logs, /PI_PREPARATION_FALLBACK .*"failureClass":"preparation_infrastructure_failure"/);
  assert.match(logs, /provider rejected delegated planner request/);
  assert.doesNotMatch(logs, /PI_SUBAGENT_RETRY/);
});

test('delegated transport timeout remains a distinct safe fallback', () => {
  const logs = runtimeScenario('transport-timeout');
  assert.match(logs, /PI_PREPARATION_FALLBACK .*"failureClass":"planner_transport_timeout"/);
  assert.doesNotMatch(logs, /planner_deadline_timeout|PI_SUBAGENT_RETRY/);
});
