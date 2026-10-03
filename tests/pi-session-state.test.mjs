import test from 'node:test';
import assert from 'node:assert/strict';
import { PREPARATION_FALLBACK_EVIDENCE_BUDGET, ProgressController, actionRequiredToolNames } from '../scripts/pi-common/progress-controller.mjs';
import { capabilitySnapshotGuidance, mergeNewlyActiveTools, providerToolNames } from '../scripts/pi-common/session-state.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

const LSP = { server_id: 'python', workspace_root: '/work/tree' };

function fallbackController() {
  const state = new ProgressController(stageConfig('implementer'), {});
  assert.equal(state.checkToolCall('prepare_implementation', {}), undefined);
  state.enterPreparationFallback();
  state.onToolExecutionEnd('prepare_implementation', false);
  assert.ok(state.recordTransitionCompleted('prepare_implementation', {}, false));
  return state;
}

function complete(state, tool, input = {}) {
  assert.equal(state.checkToolCall(tool, input), undefined, tool);
  state.onToolExecutionEnd(tool, false);
  return state.recordTransitionCompleted(tool, input, false);
}

test('A: repeated lsp_start_server after fallback is already_satisfied and not progress', () => {
  const state = fallbackController();
  assert.ok(complete(state, 'lsp_start_server', LSP));
  assert.match(state.transitions.stateBlock(), /python LSP: running/);
  state.onTurnStart(1);
  const repeatsBefore = state.repeatCount;
  const blocked = state.checkToolCall('lsp_start_server', LSP);
  assert.equal(blocked.block, true);
  assert.equal(blocked.alreadySatisfied, true);
  assert.match(blocked.reason, /ALREADY_SATISFIED/);
  assert.equal(state.repeatCount, repeatsBefore, 'repeat does not touch the loop signature');
  assert.equal(state.turnMadeProgress, false);
  assert.equal(state.recordTransitionCompleted('lsp_start_server', LSP, false), null, 'no second completion');
  // a different workspace is a different transition
  assert.equal(state.checkToolCall('lsp_start_server', { ...LSP, workspace_root: '/other' }), undefined);
  // and the run can proceed to implementation
  assert.equal(state.checkToolCall('safe_edit', {}), undefined);
});

test('B: subagents_enable completes once, repeat steers without progress', () => {
  const state = fallbackController();
  assert.ok(complete(state, 'subagents_enable'));
  assert.deepEqual([...state.transitions.satisfiedToolNames()], ['subagents_enable', 'prepare_implementation']);
  assert.match(state.transitions.stateBlock(), /subagents: enabled/);
  state.onTurnStart(1);
  const blocked = state.checkToolCall('subagents_enable', {});
  assert.equal(blocked.alreadySatisfied, true);
  assert.match(blocked.reason, /current runtime tool surface/);
  assert.doesNotMatch(blocked.reason, /begin_coding_session|submit_result/);
  assert.equal(state.turnMadeProgress, false);
  assert.equal(state.turnUsedTool, false);
});

test('C: preparation success and fallback are materialized and prepare_implementation stays unavailable', () => {
  const fallback = fallbackController();
  assert.match(fallback.transitions.stateBlock(), /preparation: fallback-complete/);
  assert.equal(fallback.checkToolCall('prepare_implementation', {}).alreadySatisfied, true);

  const normal = new ProgressController(stageConfig('implementer'), {});
  assert.equal(normal.checkToolCall('prepare_implementation', {}), undefined);
  normal.setComplexity('trivial');
  normal.onToolExecutionEnd('prepare_implementation', false);
  assert.ok(normal.recordTransitionCompleted('prepare_implementation', {}, false));
  assert.match(normal.transitions.stateBlock(), /preparation: complete\b/);
  assert.equal(normal.checkToolCall('prepare_implementation', {}).alreadySatisfied, true);
  assert.ok(normal.transitions.satisfiedToolNames().has('prepare_implementation'));
});

test('failed transitions are not recorded and may be retried', () => {
  const state = new ProgressController(stageConfig('implementer'), {});
  state.checkToolCall('prepare_implementation', {});
  assert.equal(state.recordTransitionCompleted('prepare_implementation', {}, true), null);
  assert.equal(state.transitions.stateBlock(), '');
});

test('state block separates transition completion from issue completion', () => {
  const state = fallbackController();
  const block = state.transitions.stateBlock();
  assert.match(block, /GitHub issue itself is NOT complete/);
  assert.doesNotMatch(block, /task complete/i);
  assert.match(state.transitions.transitionNotice(state.transitions.completed.get('preparation')), /STATE TRANSITION COMPLETE/);
});

test('D: runtime state == model-visible state == tool surface for each transition', () => {
  const state = fallbackController();
  complete(state, 'subagents_enable');
  complete(state, 'lsp_start_server', LSP);
  const all = ['read', 'prepare_implementation', 'subagents_enable', 'lsp_start_server', 'subagent', 'safe_edit', 'submit_result', 'begin_coding_session', 'need_more_evidence'];
  const cfg = stageConfig('implementer').productiveProgress;
  const visibleDuringEvidence = all.filter(name => !state.transitions.satisfiedToolNames().has(name));

  for (const tool of ['prepare_implementation', 'subagents_enable']) {
    assert.ok(!visibleDuringEvidence.includes(tool), `${tool} removed from surface`);
    assert.equal(state.checkToolCall(tool, {}).alreadySatisfied, true, `${tool} deterministic no-op`);
  }
  assert.equal(state.productiveProgressState(), 'evidence_allowed');
  assert.ok(visibleDuringEvidence.includes('subagent'), 'subagent remains visible during fallback evidence window');

  for (let i = 0; i < PREPARATION_FALLBACK_EVIDENCE_BUDGET; i++) {
    assert.equal(state.checkToolCall('read', { path: 'fallback-evidence-' + i }), undefined);
  }
  assert.equal(state.productiveProgressState(), 'action_required');

  const actionSurface = actionRequiredToolNames(visibleDuringEvidence, {
    actionTools: cfg.actionTools,
    controlTools: cfg.controlTools,
    blockerTool: cfg.blockerTool,
  });
  assert.ok(!actionSurface.includes('subagent'), 'subagent hidden after fallback evidence is exhausted');
  assert.equal(state.checkToolCall('subagent', {}).block, true);
  assert.equal(state.checkToolCall('need_more_evidence', { missing: 'x', reason: 'y' }), undefined);
  assert.equal(state.productiveProgressState(), 'evidence_allowed');
  assert.equal(state.checkToolCall('subagent', {}), undefined, 'subagent executes once extra evidence is allowed');
  assert.match(state.transitions.stateBlock(), /subagents: enabled/);
  // LSP stays visible (keyed per workspace) but the identical call is satisfied.
  assert.ok(actionSurface.includes('lsp_start_server'));
  assert.equal(state.checkToolCall('lsp_start_server', LSP).alreadySatisfied, true);
});

test('session-state validation guidance follows the verification lifecycle', () => {
  const state = fallbackController();
  const verification = verificationState => ({ verificationTool: 'run_check', verificationState });

  const beforeMutation = state.transitions.stateBlock(verification('not_yet_available'));
  assert.match(beforeMutation, /run_check is not yet available; it becomes available after a successful mutation/);
  assert.doesNotMatch(beforeMutation, /- run validation\b/);
  assert.doesNotMatch(beforeMutation, /run_check is exhausted/);

  const available = state.transitions.stateBlock(verification('available'));
  assert.match(available, /run validation with run_check \(available once for the current mutation state\)/);

  const exhausted = state.transitions.stateBlock(verification('exhausted'));
  assert.match(exhausted, /run_check is exhausted for the current mutation state/);
  assert.doesNotMatch(exhausted, /run_check is not yet available/);

  const record = state.transitions.completed.get('preparation');
  assert.match(
    state.transitions.transitionNotice(record, verification('not_yet_available')),
    /run_check is not yet available; it becomes available after a successful mutation/,
  );
  const subagents = complete(state, 'subagents_enable');
  const surfaced = state.transitions.transitionNotice(subagents, {
    ...verification('not_yet_available'),
    activeToolNames: ['need_more_evidence', 'submit_result'],
  });
  assert.match(surfaced, /CURRENTLY EXPOSED TOOLS.*need_more_evidence, submit_result/);
  assert.match(surfaced, /call need_more_evidence first; the delegated-inspection tool will be exposed/);
  assert.doesNotMatch(surfaced, /subagent\(/);
  assert.match(
    state.transitions.alreadySatisfiedReason('prepare_implementation', 'preparation', {
      actionRequired: true,
      ...verification('exhausted'),
    }),
    /run_check is exhausted for the current mutation state/,
  );
});

test('provider capability snapshot is derived from executable request definitions', () => {
  const payload = {
    tools: [
      { type: 'function', function: { name: 'write' } },
      { name: 'submit_result' },
      { type: 'function', function: { name: 'write' } },
    ],
  };
  assert.deepEqual(providerToolNames(payload), ['write', 'submit_result']);
  const guidance = capabilitySnapshotGuidance(providerToolNames(payload));
  assert.match(guidance, /write, submit_result/);
  assert.match(guidance, /authoritative for this provider request/);
  assert.doesNotMatch(guidance, /need_more_evidence|\bread\b/);
});

test('mergeNewlyActiveTools keeps baseline order and adds newly enabled tools', () => {
  assert.deepEqual(mergeNewlyActiveTools(['a', 'b'], ['b', 'subagent']), ['a', 'b', 'subagent']);
});
