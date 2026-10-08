import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

import {
  acceptedTerminalPlannerReceipt,
  patchPiSubagentsSource,
} from '../infra/github-runner-autoscaler/patch-pi-subagents-planner-terminal.mjs';

const receiptId = 'planner-run-617';
const toolCallId = 'submit-617';
function validState() {
  const planText = '1. Implement unique_terms\n2. Run focused pytest\n';
  return {
    phase: 'submitted', planText, submissionBudget: 4096,
    budgetHistory: [{ phase: 'researching', verified: true, effective: 2048 },
      { phase: 'submission_pending', verified: true, effective: 4096 }],
    submissionReceipt: {
      lifecycleId: receiptId, toolCallId, admitted: true, executed: true,
      providerComplete: true, stopReason: 'tooluse', providerBudgetVerified: true,
      submissionBudget: 4096, planTextBytes: Buffer.byteLength(planText, 'utf8'),
    },
  };
}
function validMessages() {
  return [
    { role: 'assistant', stopReason: 'toolUse', content: [
      { type: 'toolCall', id: toolCallId, name: 'submit_plan', arguments: { planText: '...' } },
    ] },
    { role: 'toolResult', toolCallId, toolName: 'submit_plan', isError: false,
      content: [{ type: 'text', text: 'Plan submission received' }] },
  ];
}

test('actual terminal toolUse with executed submit_plan and durable receipt can finish without prose', () => {
  assert.equal(acceptedTerminalPlannerReceipt(validMessages(), validState(), receiptId), true);
  const escalated = validState();
  escalated.submissionBudget = 8192;
  escalated.submissionReceipt.submissionBudget = 8192;
  escalated.budgetHistory.at(-1).effective = 8192;
  assert.equal(acceptedTerminalPlannerReceipt(validMessages(), escalated, receiptId), true);
});

test('terminal plan exemption fails closed on invalid state, transport, tool and lifecycle', () => {
  const changes = [
    { name: 'missing state', edit: () => [null, validMessages(), receiptId] },
    { name: 'research-only', edit: (s,m) => [Object.assign(s,{phase:'researching'}),m,receiptId] },
    { name: 'previous lifecycle', edit: (s,m) => [s,m,'other'] },
    { name: 'empty plan', edit: (s,m) => [Object.assign(s,{planText:''}),m,receiptId] },
    { name: 'corrupt plan bytes', edit: (s,m) => [(s.submissionReceipt.planTextBytes -= 1,s),m,receiptId] },
    { name: 'failed classification', edit: (s,m) => [Object.assign(s,{failureKind:'planner_submission_invalid'}),m,receiptId] },
    { name: 'missing receipt', edit: (s,m) => [(delete s.submissionReceipt,s),m,receiptId] },
    { name: 'attempted only', edit: (s,m) => [(s.submissionReceipt.executed = false,s),m,receiptId] },
    { name: 'rejected admission', edit: (s,m) => [(s.submissionReceipt.admitted = false,s),m,receiptId] },
    { name: 'incomplete provider', edit: (s,m) => [(s.submissionReceipt.providerComplete = false,s),m,receiptId] },
    { name: 'unverified budget', edit: (s,m) => [(s.submissionReceipt.providerBudgetVerified = false,s),m,receiptId] },
    { name: 'unverified budget history', edit: (s,m) => [(s.budgetHistory.at(-1).verified = false,s),m,receiptId] },
    { name: 'wrong phase budget', edit: (s,m) => [(s.submissionBudget = 2048,s),m,receiptId] },
    { name: 'truncated provider', edit: (s,m) => [(m[0].stopReason = 'length',s),m,receiptId] },
    { name: 'assistant error', edit: (s,m) => [(m[0].errorMessage = 'provider error',s),m,receiptId] },
    { name: 'another tool', edit: (s,m) => [(m[0].content[0].name='read',s),m,receiptId] },
    { name: 'different call id', edit: (s,m) => [(m[0].content[0].id='wrong',s),m,receiptId] },
    { name: 'duplicate submit', edit: (s,m) => [(m[0].content.push({...m[0].content[0]}),s),m,receiptId] },
    { name: 'failed tool', edit: (s,m) => [(m[1].isError = true,s),m,receiptId] },
    { name: 'missing result', edit: (s,m) => [s,m.slice(0,1),receiptId] },
    { name: 'duplicated result', edit: (s,m) => [s,[...m,m[1]],receiptId] },
  ];
  for (const {name, edit} of changes) {
    const [state,messages,id] = edit(validState(),validMessages());
    assert.equal(acceptedTerminalPlannerReceipt(messages,state,id),false,name);
  }
});

// This mirrors the actual pi-subagents@0.76.1 foreground final-text and
// hidden-error branches (rather than a fake source containing only branch 1).
function upstreamDecisionFixture() {
  return [
    'import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";',
    'const artifactOutputByResult = new WeakMap();',
    'function runSingleAttempt(agent, messages, errInfo) {',
    '  const result = { exitCode: 0, error: undefined };',
    '  const finalText = "";',
    '  const validatedStructuredOutput = false;',
    '  const terminalEmptyAfterUsefulWork = false;',
    '  const missingOutput = !finalText?.trim() && !validatedStructuredOutput;',
    '  if ((missingOutput || terminalEmptyAfterUsefulWork) && (!errInfo.hasError || hasEmptyTerminalAssistantResponse(messages))) {',
    '    result.exitCode = 1;',
    '    result.error = formatEmptyTerminalAssistantResponseError(messages);',
    '  } else if (errInfo.hasError) {',
    '    result.exitCode = errInfo.exitCode ?? 1;',
    '    result.error = errInfo.details',
    '      ? errInfo.errorType + " failed (exit " + errInfo.exitCode + "): " + errInfo.details',
    '      : errInfo.errorType + " failed with exit code " + errInfo.exitCode;',
    '  }',
    '  return result;',
    '}',
  ].join('\n');
}

function runPatchedDecision({ agentName = 'implementation-planner', messages = validMessages(),
  state = validState(), errInfo = { hasError: true, exitCode: 4, errorType: 'read', details: 'ENOENT' },
  readError = null } = {}) {
  const patched = patchPiSubagentsSource(upstreamDecisionFixture());
  const executable = patched.replace(/^import \{[^\n]+\} from "node:fs";\n/, '');
  const warnings = [];
  const ctx = {
    Buffer,
    process: { env: { PI_PLANNER_EVIDENCE_STATE_FILE: '/private/planner-sidecar.json',
      PI_PLANNER_LIFECYCLE_ID: receiptId } },
    readFileSync: () => {
      if (readError) throw readError;
      return JSON.stringify(state);
    },
    hasEmptyTerminalAssistantResponse: () => false,
    formatEmptyTerminalAssistantResponseError: () => 'Missing final text',
    console: { warn: value => warnings.push(String(value)) },
  };
  const runSingleAttempt = vm.runInNewContext(executable + '\nrunSingleAttempt', ctx, { timeout: 1000 });
  return { result: runSingleAttempt({ name: agentName }, messages, errInfo), warnings };
}

test('previous read ENOENT does not fail an accepted terminal submit_plan', () => {
  const withEarlierReadError = [
    { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', isError: true,
      content: [{ type: 'text', text: 'ENOENT' }] },
    ...validMessages(),
  ];
  const { result, warnings } = runPatchedDecision({ messages: withEarlierReadError });
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, undefined);
  assert.deepEqual(warnings, []);
});

test('unverified or unrelated terminal submissions still fail upstream hidden-error check', () => {
  const broken = validState();
  broken.submissionReceipt.executed = false;
  const badTool = validMessages();
  badTool[1].isError = true;
  for (const [name, params] of [
    ['non-Planner', { agentName: 'other-agent' }],
    ['missing receipt', { state: null }],
    ['unexecuted receipt', { state: broken }],
    ['failed final tool', { messages: badTool }],
  ]) {
    const { result } = runPatchedDecision(params);
    assert.equal(result.exitCode, 4, name);
    assert.match(result.error, /read failed/, name);
  }
  const noHiddenError = runPatchedDecision({ state: null, errInfo: { hasError: false } });
  assert.equal(noHiddenError.result.exitCode, 1);
  assert.equal(noHiddenError.result.error, 'Missing final text');
});

test('embedded receipt predicate remains self-contained and diagnostics redact sidecar', () => {
  const isolated = vm.runInNewContext('(' + acceptedTerminalPlannerReceipt.toString() + ')', { Buffer }, { timeout: 1000 });
  assert.equal(isolated(validMessages(), validState(), receiptId), true);
  const failure = runPatchedDecision({ readError: new ReferenceError('secret-content-should-not-log') });
  assert.equal(failure.result.exitCode, 4);
  assert.equal(failure.warnings.length, 1);
  assert.match(failure.warnings[0], /PI_PLANNER_TERMINAL_RECEIPT_CHECK_FAILED.*injected_dependency_missing/);
  assert.doesNotMatch(failure.warnings[0], /secret-content-should-not-log/);
});

test('pinned pi-subagents source patch preserves both real control-flow failure branches', () => {
  const source = upstreamDecisionFixture();
  const patched = patchPiSubagentsSource(source);
  assert.match(patched, /trustedPlannerTerminalToolUse\(messages, agent\.name\)/);
  assert.match(patched, /!acceptedTerminalPlan && \(missingOutput/);
  assert.match(patched, /else if \(!acceptedTerminalPlan && errInfo\.hasError\)/);
  assert.match(patched, /PI_PLANNER_EVIDENCE_STATE_FILE/);
  assert.match(patched, /readFileSync/);
  assert.match(patched, /result\.exitCode = errInfo\.exitCode/);
  assert.throws(() => patchPiSubagentsSource(patched), /source drift/);
  assert.throws(() => patchPiSubagentsSource(source.replace('else if (errInfo.hasError)', 'else if (false)')), /source drift/);
});

test('runner build applies pinned patch before saving Pi package seed', () => {
  const dockerfile = fs.readFileSync('infra/github-runner-autoscaler/worker.Dockerfile','utf8');
  assert.match(dockerfile, /ARG PI_SUBAGENTS_VERSION=0\.76\.1/);
  const install = dockerfile.indexOf('pi install --no-approve "npm:pi-subagents@');
  const patch = dockerfile.indexOf('node \/home\/runner\/build-tools\/patch-pi-subagents-planner-terminal\.mjs');
  const seed = dockerfile.indexOf('cp -a \/home\/runner\/\.pi\/agent\/npm \/opt\/pi-package-seed/');
  assert.ok(install >= 0 && install < patch && patch < seed);
  assert.match(dockerfile, /node --check \/home\/runner\/\.pi\/agent\/npm\/node_modules\/pi-subagents\/src\/runs\/foreground\/execution\.js/);
});
