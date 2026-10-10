import test from 'node:test';
import assert from 'node:assert/strict';
import { profileHiddenToolAdvice, taskSpecificToolGuidance } from '../scripts/pi-common/runtime-tool-guidance.mjs';

test('#741 capability request and forbidden-name advice retains exact messages', () => {
  assert.equal(profileHiddenToolAdvice('request_capabilities', null, 0),
    'BLOCKED: the three successful Main capability grants have been used. No further capability expansion is available; keep the current safe tools or report a blocker.');
  assert.equal(profileHiddenToolAdvice('request_capabilities', null, 3),
    'BLOCKED: the Main capability-request no-op limit has been reached. No more capability requests; use a permitted safe tool or preserve the worktree and report a blocker.');
  for (const name of ['grep', 'find', 'ls']) {
    assert.equal(profileHiddenToolAdvice(name, null, 0),
      `BLOCKED: ${name} is permanently forbidden in Main; no capability grant can enable it. Use the permitted read or repository search tools.`);
  }
});

test('#741 optional hidden tool text reflects request-local capability authority', () => {
  assert.equal(profileHiddenToolAdvice('lsp_find_symbol', { executableTools: ['request_capabilities'] }, 0),
    'BLOCKED: lsp_find_symbol is intentionally hidden by the Main tool profile, not newly active. If this optional capability is genuinely required, call request_capabilities with group=lsp and a concrete reason; only a later provider request may expose lsp_find_symbol. Do not retry this tool now.');
  assert.equal(profileHiddenToolAdvice('searxng_web_search', { executableTools: [] }, 0),
    'BLOCKED: searxng_web_search is hidden by the Main tool profile, and request_capabilities is not executable in this request. Do not retry or assume it appears later; use an exposed safe action or preserve the worktree.');
  assert.equal(profileHiddenToolAdvice('subagent', null, 0),
    'BLOCKED: subagent is hidden by the Main tool profile, and request_capabilities is not executable in this request. Do not retry or assume it appears later; use an exposed safe action or preserve the worktree.');
});

test('#741 reviewer classification hints are stage- and tool-scoped', () => {
  assert.equal(taskSpecificToolGuidance([], { stage: 'reviewer', preComplexityRequired: true }), '');
  assert.equal(taskSpecificToolGuidance(['declare_task_complexity'], { stage: 'reviewer', preComplexityRequired: true }),
    'Call declare_task_complexity immediately with the classification already supported by the current evidence.');
  assert.equal(taskSpecificToolGuidance(['submit_result'], { stage: 'reviewer', postComplexityRequired: true }),
    'If the current issue, diff, and changed code are sufficient, call submit_result now with PASS or CHANGES_REQUESTED.');
  assert.equal(taskSpecificToolGuidance(['read'], { stage: 'reviewer', postComplexityRequired: true }),
    'Otherwise use exactly one currently exposed evidence tool for the unresolved review question, then decide.');
  assert.equal(taskSpecificToolGuidance(['submit_result', 'declare_task_complexity', 'set_response_budget'], {
    stage: 'reviewer', postComplexityRequired: true,
  }), 'If the current issue, diff, and changed code are sufficient, call submit_result now with PASS or CHANGES_REQUESTED.');
  assert.equal(taskSpecificToolGuidance(['read'], { stage: 'architect', postComplexityRequired: true }), '');
});

test('#741 Implementer combines action hints in stable order', () => {
  const options = {
    stage: 'implementer', ceilingHit: true, codingSessionTool: 'begin_coding_session',
    acceptMutationScopeTool: 'accept_mutation_scope', blockerTool: 'need_more_evidence',
    retryFailedCheckTool: 'retry_last_failed_check',
  };
  const expected = [
    'If the implementation is large, call begin_coding_session now; it keeps the current context and provides the large coding ceiling instead of drafting code here.',
    'Before mutating a new publishable path, call accept_mutation_scope with that path and a task-specific rationale. Register scratch/probe paths as temporary; temporary paths must be removed before submission.',
    'If explicit written requirements or constraints are mutually incompatible and no compliant mutation exists, call submit_result with blocked_reason now.',
    'Call need_more_evidence only when exactly one concrete missing fact prevents the next safe action.',
    'Use retry_last_failed_check to rerun the exact unresolved failed verification scope after fixing it.',
  ];
  const tools = ['begin_coding_session', 'accept_mutation_scope', 'submit_result', 'need_more_evidence', 'retry_last_failed_check'];
  assert.equal(taskSpecificToolGuidance(tools, options), expected.join(' '));
  assert.equal(taskSpecificToolGuidance(tools, { ...options, ceilingHit: false }), expected.slice(1).join(' '));
  assert.equal(taskSpecificToolGuidance([], options), '');
});

test('#741 child-specific read warning depends on both tool surface and child state', () => {
  const args = { stage: 'implementer', codingSession: { sessionId: 'child' }, blockerTool: 'need_more_evidence' };
  const warning = 'This coding session is action-required: read is not exposed now. Do not invent helper tools such as read_for_input; request the one missing fact through need_more_evidence, or continue with an exposed mutation/terminal tool.';
  const first = 'Call need_more_evidence only when exactly one concrete missing fact prevents the next safe action.';
  assert.equal(taskSpecificToolGuidance(['need_more_evidence'], args), first + ' ' + warning);
  assert.equal(taskSpecificToolGuidance(['need_more_evidence', 'read'], args), first);
  assert.equal(taskSpecificToolGuidance(['read'], args), '');
  assert.equal(taskSpecificToolGuidance(['need_more_evidence'], { ...args, codingSession: null }), first);
});
