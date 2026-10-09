import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PREPARATION_FALLBACK_EVIDENCE_BUDGET, ProgressController, actionRequiredToolNames } from '../scripts/pi-common/progress-controller.mjs';
import { capabilitySnapshotGuidance, classifyMissingExecutor, constrainTerminalRecoveryTools, implementerRequestPhaseSnapshot, mergeNewlyActiveTools, providerToolNames, withProviderCapabilityInstructions } from '../scripts/pi-common/session-state.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';
import { readScript } from './helpers/resolved-source.mjs';

const LSP = { server_id: 'python', workspace_root: '/work/tree' };

// Born prepared: bootstrap resolved preparation (here: planner fallback) before the session started.
function fallbackController() {
  const state = new ProgressController(stageConfig('implementer'), {});
  state.applyPreparedImplementation({ status: 'fallback', failureClass: 'preparation_infrastructure_failure', reason: 'planner down' });
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
  assert.deepEqual([...state.transitions.satisfiedToolNames()], ['subagents_enable']);
  assert.match(state.transitions.stateBlock(), /subagents: enabled/);
  state.onTurnStart(1);
  const blocked = state.checkToolCall('subagents_enable', {});
  assert.equal(blocked.alreadySatisfied, true);
  assert.match(blocked.reason, /current runtime tool surface/);
  assert.doesNotMatch(blocked.reason, /begin_coding_session|submit_result/);
  assert.equal(state.turnMadeProgress, false);
  assert.equal(state.turnUsedTool, false);
});

test('C: preparation is runtime bootstrap state, not a session transition or model-visible tool', () => {
  const fallback = fallbackController();
  assert.equal(fallback.transitions.stateBlock(), '', 'no completed transition exists for preparation');
  assert.equal(fallback.transitions.keyFor('prepare_implementation', {}), null);
  assert.equal(fallback.recordTransitionCompleted('prepare_implementation', {}, false), null);
  assert.equal(fallback.preparationState, 'PREPARATION_FALLBACK');

  const normal = new ProgressController(stageConfig('implementer'), {});
  normal.applyPreparedImplementation({ status: 'prepared', plan: ['p'], complexity: 'trivial', evidenceBudget: 1, largeMutation: false, reason: 'r' });
  assert.equal(normal.transitions.stateBlock(), '');
  assert.equal(normal.preparationState, 'PREPARED');
  assert.equal(normal.transitions.satisfiedToolNames().size, 0);
});

test('state block separates transition completion from issue completion', () => {
  const state = fallbackController();
  const record = complete(state, 'subagents_enable');
  const block = state.transitions.stateBlock();
  assert.match(block, /GitHub issue itself is NOT complete/);
  assert.doesNotMatch(block, /task complete/i);
  assert.match(state.transitions.transitionNotice(record), /STATE TRANSITION COMPLETE/);
});

test('D: runtime state == model-visible state == tool surface for each transition', () => {
  const state = fallbackController();
  complete(state, 'subagents_enable');
  complete(state, 'lsp_start_server', LSP);
  const all = ['read', 'subagents_enable', 'lsp_start_server', 'subagent', 'safe_edit', 'submit_result', 'begin_coding_session', 'need_more_evidence'];
  const cfg = stageConfig('implementer').productiveProgress;
  const visibleDuringEvidence = all.filter(name => !state.transitions.satisfiedToolNames().has(name));

  for (const tool of ['subagents_enable']) {
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
  const subagents = complete(state, 'subagents_enable');

  const beforeMutation = state.transitions.stateBlock(verification('not_yet_available'));
  assert.match(beforeMutation, /run_check is not yet available; it becomes available after a successful mutation/);
  assert.doesNotMatch(beforeMutation, /- run validation\b/);
  assert.doesNotMatch(beforeMutation, /run_check is exhausted/);

  const available = state.transitions.stateBlock(verification('available'));
  assert.match(available, /run validation with run_check \(available once for the current mutation state\)/);

  const exhausted = state.transitions.stateBlock(verification('exhausted'));
  assert.match(exhausted, /run_check is exhausted for the current mutation state/);
  assert.doesNotMatch(exhausted, /run_check is not yet available/);

  assert.match(
    state.transitions.transitionNotice(subagents, verification('not_yet_available')),
    /run_check is not yet available; it becomes available after a successful mutation/,
  );
  const surfaced = state.transitions.transitionNotice(subagents, {
    ...verification('not_yet_available'),
    activeToolNames: ['need_more_evidence', 'submit_result'],
  });
  assert.match(surfaced, /CURRENTLY EXPOSED TOOLS.*need_more_evidence, submit_result/);
  assert.match(surfaced, /call need_more_evidence first; the delegated-inspection tool will be exposed/);
  assert.doesNotMatch(surfaced, /subagent\(/);
  assert.match(
    state.transitions.alreadySatisfiedReason('subagents_enable', 'subagents_enable', {
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

test('classifyMissingExecutor separates contract failures, deferred tools and unavailable attempts', () => {
  const snapshot = { request: 3, executableTools: ['write', 'submit_result'], deferredTools: ['run_check'] };
  assert.equal(classifyMissingExecutor('write', snapshot), 'contract_failure');
  assert.equal(classifyMissingExecutor('run_check', snapshot), 'deferred');
  assert.equal(classifyMissingExecutor('bash', snapshot), 'unavailable');
  assert.equal(classifyMissingExecutor('bash', null), 'contract_failure', 'without a snapshot nothing proves the tool was not advertised');
});


const nestedTool = name => ({ type: 'function', function: {
  name, description: 'Registered schema for ' + name,
  parameters: { type: 'object', properties: {} },
} });
const flatTool = name => ({ type: 'function', name, description: 'Registered schema for ' + name });
const guidanceFor = (payload, snapshot) => withProviderCapabilityInstructions(payload, {
  mode: 'main',
  productiveState: 'action_required',
  ...snapshot,
  executableTools: providerToolNames(payload),
}, { trustedRuntimeEnvelope: true });

function outboundGuidance(payload) {
  const description = payload.tools?.at(-1)?.function?.description ?? payload.tools?.at(-1)?.description;
  return description ?? payload.messages?.at(-1)?.content ?? payload.input?.at(-1)?.content?.at(-1)?.text ?? '';
}

test('restored checkpoint remains terminal-only even if inspection and edit tools are serialized', () => {
  const payload = {
    messages: [{ role: 'system', content: 'unchanged' }, { role: 'user', content: 'checkpoint' }],
    tools: [nestedTool('read'), flatTool('write'), nestedTool('submit_result')],
    tool_choice: 'required',
  };
  const first = guidanceFor(payload, implementerRequestPhaseSnapshot({ resumed: true, preparationState: 'PREPARED' }));
  assert.match(outboundGuidance(first), /terminal-only state: call submit_result with no arguments immediately/);
  assert.doesNotMatch(outboundGuidance(first), /Mutation tools available|Direct inspection|Prepared fresh Main|begin_result_submission/);
  assert.equal(first.tool_choice, payload.tool_choice);
  assert.deepEqual(first.messages, payload.messages, 'no system or user messages injected');
  assert.deepEqual(providerToolNames(first), providerToolNames(payload));
  assert.strictEqual(guidanceFor(first, implementerRequestPhaseSnapshot({ resumed: true })), first, 'idempotent repeated hook');
});

test('restored integration failure routes exclusively through its exact recovery tool', () => {
  const tools = [nestedTool('read'), flatTool('safe_edit'), nestedTool('submit_result'), flatTool('recover_worktree')];
  const selected = constrainTerminalRecoveryTools(tools, 'recover_worktree');
  assert.deepEqual(providerToolNames({ tools: selected }), ['recover_worktree']);
  const payload = { messages: [{ role: 'user', content: 'restored' }], tools: selected, tool_choice: 'required' };
  const outgoing = guidanceFor(payload, implementerRequestPhaseSnapshot({
    resumed: true, terminalRecoveryRequiredTool: 'recover_worktree',
  }));
  assert.match(outboundGuidance(outgoing), /use recover_worktree only for the current exact obligation/);
  assert.doesNotMatch(outboundGuidance(outgoing), /call submit_result|Mutation tools available|Direct inspection|Use run_check/);
  assert.equal(outgoing.tool_choice, 'required');
  assert.strictEqual(guidanceFor(outgoing, implementerRequestPhaseSnapshot({
    resumed: true, terminalRecoveryRequiredTool: 'recover_worktree',
  })), outgoing);
});

test('deferred terminal recovery fails closed without alternative edit, inspection or terminal tools', () => {
  const available = [nestedTool('read'), flatTool('safe_edit'), nestedTool('submit_result')];
  const selected = constrainTerminalRecoveryTools(available, 'retry_last_failed_check');
  assert.deepEqual(selected, [], 'the wire request must hide other exposed tools');
  let missingCarrier = null;
  const payload = { messages: [{ role: 'user', content: 'recovery' }], tools: selected };
  const snapshot = {
    ...implementerRequestPhaseSnapshot({
      resumed: true, terminalRecoveryRequiredTool: 'retry_last_failed_check',
    }),
    explainDeferred: true, deferredTools: ['retry_last_failed_check'],
    executableTools: [],
  };
  const outgoing = withProviderCapabilityInstructions(payload, snapshot, {
    trustedRuntimeEnvelope: true, onMissingCarrier: reason => { missingCarrier = reason; },
  });
  assert.equal(missingCarrier, null);
  assert.deepEqual(providerToolNames(outgoing), []);
  assert.equal(outgoing.messages.length, 1);
  assert.match(outboundGuidance(outgoing), /exact tool is unavailable in this request/);
  assert.match(outboundGuidance(outgoing), /DEFERRED \/ NOT EXECUTABLE IN THIS REQUEST: retry_last_failed_check/);
  assert.doesNotMatch(outboundGuidance(outgoing), /use retry_last_failed_check only|call submit_result|Mutation tools available|Direct inspection/);
  assert.strictEqual(withProviderCapabilityInstructions(outgoing, snapshot, {
    trustedRuntimeEnvelope: true,
  }), outgoing, 'no duplicated fallback-carrier instruction');
});

test('validation-repair uses only serialized targeted edits, diagnostics and permitted checks', () => {
  const payload = {
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'validation diagnostics' }] }],
    tools: [flatTool('read'), nestedTool('safe_edit'), flatTool('retry_last_failed_check'), nestedTool('run_check'), flatTool('submit_result')],
    tool_choice: 'auto',
  };
  const snapshot = implementerRequestPhaseSnapshot({ validationRepair: true });
  const outgoing = guidanceFor(payload, snapshot);
  const contract = outboundGuidance(outgoing);
  assert.match(contract, /Trusted targeted repair/);
  assert.match(contract, /Targeted mutation tools available: safe_edit/);
  assert.match(contract, /retry_last_failed_check only for the exact recorded unresolved failure/);
  assert.match(contract, /run_check only for permitted focused verification/);
  assert.match(contract, /After completing the authorized targeted repair, call submit_result/);
  assert.doesNotMatch(contract, /bash for|repo_search for|begin_coding_session|begin_result_submission|Prepared fresh Main/);
  assert.deepEqual(outgoing.input, payload.input);
  assert.equal(outgoing.tool_choice, 'auto');
  assert.deepEqual(providerToolNames(outgoing), providerToolNames(payload));
  assert.strictEqual(guidanceFor(outgoing, snapshot), outgoing);
});

test('validation-repair without a serialized submit_result explains missing terminal action', () => {
  const payload = {
    messages: [{ role: 'user', content: 'targeted validation diagnostics' }],
    tools: [nestedTool('write'), flatTool('run_check')],
  };
  const outgoing = guidanceFor(payload, implementerRequestPhaseSnapshot({ validationRepair: true }));
  assert.match(outboundGuidance(outgoing), /Targeted mutation tools available: write/);
  assert.match(outboundGuidance(outgoing), /terminal action submit_result is unavailable in this request/);
  assert.doesNotMatch(outboundGuidance(outgoing), /call submit_result with no arguments|Call submit_result|begin_result_submission|repo_search/);
  assert.deepEqual(outgoing.messages, payload.messages);

  const terminalOnly = guidanceFor(payload, { validationRepair: true, repairAuthorized: false });
  assert.match(outboundGuidance(terminalOnly), /terminal-only state/);
  assert.doesNotMatch(outboundGuidance(terminalOnly), /Targeted mutation tools available/);
});

test('resumed missing submit_result preserves phase status with existing carrier only', () => {
  const payload = {
    messages: [{ role: 'user', content: 'restored work' }],
    tools: [flatTool('read')],
  };
  const outgoing = guidanceFor(payload, implementerRequestPhaseSnapshot({ resumed: true }));
  assert.equal(outgoing.messages, payload.messages);
  assert.match(outboundGuidance(outgoing), /terminal action submit_result is unavailable in this request/);
  assert.doesNotMatch(outboundGuidance(outgoing), /call submit_result with no arguments|Direct inspection/);
});

test('zero-tool text carrier is safe; zero-tool linked tail has no new carrier', () => {
  const snapshot = { ...implementerRequestPhaseSnapshot({ resumed: true }), executableTools: [] };
  const safe = { messages: [{ role: 'user', content: 'restored' }], tools: [] };
  const updated = withProviderCapabilityInstructions(safe, snapshot, { trustedRuntimeEnvelope: true });
  assert.equal(updated.messages.length, 1);
  assert.match(updated.messages[0].content, /terminal action submit_result is unavailable in this request/);
  assert.deepEqual(updated.tools, []);
  const linked = {
    messages: [{ role: 'user', content: 'restored' }, { role: 'tool', tool_call_id: 'tc1', content: 'result' }],
    tools: [],
  };
  const failures = [];
  const absent = withProviderCapabilityInstructions(linked, snapshot, {
    trustedRuntimeEnvelope: true, onMissingCarrier: reason => failures.push(reason),
  });
  assert.strictEqual(absent, linked, 'no safe suffix on tool output or new role');
  assert.deepEqual(failures, ['no_safe_text_or_tool_carrier']);
});

test('trusted runtime snapshot never promotes resumed or coding repair into Main repair authority', () => {
  const runtime = readScript('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(runtime, /\.\.\.implementerRequestPhaseSnapshot\(\{/);
  assert.match(runtime, /codingSession: Boolean\(codingSession\)/);
  assert.match(runtime, /resumed: resumedImplementer/);
  assert.match(runtime, /validationRepair,/);
  assert.match(runtime, /codingRepair: Boolean\(codingSession && codingRepairWindowActive\(\)\)/);
  assert.match(runtime, /terminalRecoveryRequiredTool,/);

  const restored = implementerRequestPhaseSnapshot({ resumed: true, codingRepair: true });
  assert.equal(restored.mode, 'main');
  assert.equal(restored.repairAuthorized, false);
  assert.equal(restored.codingRepair, false);
  const restoredWithValidation = implementerRequestPhaseSnapshot({ resumed: true, validationRepair: true });
  assert.equal(restoredWithValidation.repairAuthorized, false, 'restored checkpoint takes priority');

  const validation = implementerRequestPhaseSnapshot({ validationRepair: true });
  assert.equal(validation.repairAuthorized, true);
  assert.equal(validation.mode, 'main');

  const child = implementerRequestPhaseSnapshot({ codingSession: true, codingRepair: true });
  assert.equal(child.mode, 'coding');
  assert.equal(child.codingRepair, true);
  assert.equal(child.repairAuthorized, false, 'child repair may not become a Main permission');
  assert.equal(implementerRequestPhaseSnapshot({ codingSession: true, validationRepair: true }).repairAuthorized, false);
});

test('coding repair window keeps isolated-session boundary and never borrows Main repair hints', () => {
  const payload = {
    messages: [{ role: 'user', content: 'compact coding handoff' }],
    tools: [nestedTool('read'), flatTool('safe_edit'), nestedTool('submit_result')],
    tool_choice: 'required',
  };
  const phase = implementerRequestPhaseSnapshot({ codingSession: true, codingRepair: true });
  const result = guidanceFor(payload, phase);
  assert.match(outboundGuidance(result), /Isolated coding session: the parent tool inventory and navigation policy are not executable here/);
  assert.match(outboundGuidance(result), /Mutation tools available: safe_edit/);
  assert.doesNotMatch(outboundGuidance(result), /Trusted targeted repair|Prepared fresh Main|Terminal-only state: call/);
  assert.deepEqual(result.messages, payload.messages);
  assert.equal(result.tool_choice, 'required');
  assert.strictEqual(guidanceFor(result, phase), result);
});

test('validation-repair with submit_result alone submits immediately with no implied repair', () => {
  for (const tools of [[nestedTool('submit_result')], [flatTool('submit_result')]]) {
    const payload = { messages: [{ role: 'user', content: 'validation repair' }], tools, tool_choice: 'required' };
    const phase = implementerRequestPhaseSnapshot({ validationRepair: true });
    assert.equal(phase.repairAuthorized, true);
    const result = guidanceFor(payload, phase);
    assert.match(outboundGuidance(result), /terminal-only state: call submit_result with no arguments immediately/);
    assert.doesNotMatch(outboundGuidance(result), /Trusted targeted repair|After completing the authorized targeted repair|Targeted mutation tools available|begin_result_submission/);
    assert.deepEqual(result.messages, payload.messages);
    assert.deepEqual(providerToolNames(result), ['submit_result']);
    assert.equal(result.tool_choice, 'required');
    assert.strictEqual(guidanceFor(result, phase), result);
  }
});

test('resumed Main cannot get generic repair permission without an exact runtime obligation', () => {
  const payload = {
    messages: [{ role: 'user', content: 'restored work' }],
    tools: [nestedTool('read'), flatTool('write'), nestedTool('submit_result')],
  };
  const resumed = implementerRequestPhaseSnapshot({ resumed: true });
  const generic = guidanceFor(payload, resumed);
  assert.match(outboundGuidance(generic), /terminal-only state: call submit_result/);
  assert.doesNotMatch(outboundGuidance(generic), /Trusted targeted repair|Mutation tools available|Direct inspection/);
  // A concrete controller-selected recovery obligation is the sole exception.
  const exact = implementerRequestPhaseSnapshot({
    resumed: true, terminalRecoveryRequiredTool: 'recover_worktree',
  });
  assert.equal(exact.repairAuthorized, false);
  const selected = constrainTerminalRecoveryTools(
    [...payload.tools, flatTool('recover_worktree')], exact.terminalRecoveryRequiredTool,
  );
  assert.deepEqual(providerToolNames({ tools: selected }), ['recover_worktree']);
  const outgoing = guidanceFor({ ...payload, tools: selected }, exact);
  assert.match(outboundGuidance(outgoing), /use recover_worktree only for the current exact obligation/);
  assert.doesNotMatch(outboundGuidance(outgoing), /call submit_result|Targeted mutation tools available/);
});

test('Main static command boundary prohibits grep/find/ls bypass without prescribing invocations', () => {
  const policy = readFileSync(new URL('../agents/implementer/AGENTS.md', import.meta.url), 'utf8');
  assert.match(policy, /In \*\*Main\*\*, .grep., .find., and .ls. are runtime-blocked commands/);
  assert.match(policy, /Never route around those blocks using shell, another tool, or a child handoff/);
  assert.match(policy, /not a claim about Planner or an isolated coding child/);
  assert.doesNotMatch(policy, /Call .grep.|Call .find.|Call .ls./);
});
