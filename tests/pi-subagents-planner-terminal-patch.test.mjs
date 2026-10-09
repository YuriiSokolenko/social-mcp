import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  acceptedTerminalPlannerReceipt,
  acceptedTerminalImplementerReceipt,
  patchPiSubagentsSource,
} from '../infra/github-runner-autoscaler/patch-pi-subagents-planner-terminal.mjs';
import { acquireImplementerTerminalSession } from '../scripts/pi-common/terminal-session-binding.mjs';

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
  readError = null, receipt = null, metadata = null, sessionId = 'coding-632' } = {}) {
  const patched = patchPiSubagentsSource(upstreamDecisionFixture());
  const executable = patched.replace(/^import \{[^\n]+\} from "node:fs";\nimport \{ createHash \} from "node:crypto";\n/, '');
  const warnings = [];
  const ctx = {
    Buffer, createHash,
    process: { env: {
      PI_PLANNER_EVIDENCE_STATE_FILE: '/private/planner-sidecar.json',
      PI_PLANNER_LIFECYCLE_ID: receiptId,
      PI_IMPLEMENTER_SUBAGENT_TERMINAL_SESSION_ID: sessionId,
      PI_TERMINAL_RESULT_FILE: '/private/terminal-receipt.json',
      PI_IMPLEMENTER_RESULT_FILE: '/private/implementer-result.json',
      PI_VALIDATION_RUN_ID: 'run-632', PI_ISSUE: '632',
    } },
    readFileSync: (name) => {
      if (readError) throw readError;
      if (name === '/private/terminal-receipt.json') return JSON.stringify(receipt);
      if (name === '/private/implementer-result.json') return Buffer.from(JSON.stringify(metadata));
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
  assert.match(patched, /!acceptedTerminalToolUse && \(missingOutput/);
  assert.match(patched, /else if \(!acceptedTerminalToolUse && errInfo\.hasError\)/);
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

function validImplementerEnvelope() {
  const resultText = 'Implemented feature and focused checks.';
  const metadata = {
    outcome: 'changed', result_text: resultText, summary: resultText,
    files: ['src/a.py'], accepted_scope: { accepted: [{ path: 'src/a.py' }] },
  };
  const bytes = Buffer.from(JSON.stringify(metadata));
  const receipt = {
    kind: 'pi_terminal_receipt', schema_version: 2, status: 'success',
    outcome: 'changed', run_id: 'run-632', issue: '632', attempt_id: 'primary',
    session_id: 'coding-632', candidate_revision: {
      base_commit: 'a'.repeat(40), digest: 'b'.repeat(64),
    },
    result_metadata_sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const messages = [
    { role: 'assistant', stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'done-632', name: 'submit_result', arguments: { resultText } },
    ] },
    { role: 'toolResult', toolCallId: 'done-632', toolName: 'submit_result',
      isError: false, content: [{ type: 'text', text: 'Result recorded' }] },
  ];
  const env = {
    PI_VALIDATION_RUN_ID: 'run-632', PI_ISSUE: '632',
  };
  return { messages, metadata, receipt, env };
}

test('#632 completed coding child terminal toolUse needs no final assistant prose or provider retry', () => {
  const { messages, metadata, receipt, env } = validImplementerEnvelope();
  const earlierFailure = { role: 'toolResult', toolCallId: 'read-1', toolName: 'read',
    isError: true, content: [{ type: 'text', text: 'ENOENT' }] };
  assert.equal(acceptedTerminalImplementerReceipt(
    [earlierFailure, ...messages], receipt, Buffer.from(JSON.stringify(metadata)),
    env, 'coding-632', { hasError: true, errorType: 'read' }), true);
  const { result, warnings } = runPatchedDecision({
    agentName: 'implementer-coding-session', messages: [earlierFailure, ...messages],
    receipt, metadata,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, undefined);
  assert.deepEqual(warnings, []);
});

test('#632 adapter rejects stale/foreign/tampered receipt and incomplete terminal transport', () => {
  const cases = [
    ['foreign run', ({receipt}) => { receipt.run_id = 'other'; }],
    ['foreign issue', ({receipt}) => { receipt.issue = '633'; }],
    ['foreign session', ({receipt}) => { receipt.session_id = 'old'; }],
    ['foreign attempt', ({receipt}) => { receipt.attempt_id = 'validation-repair:1'; }],
    ['candidate digest absent', ({receipt}) => { receipt.candidate_revision.digest = ''; }],
    ['metadata tampered', ({metadata}) => { metadata.result_text = 'changed after receipt'; }],
    ['wrong model text', ({messages}) => { messages[0].content[0].arguments.resultText = 'untrusted mismatch'; }],
    ['duplicate tool', ({messages}) => { messages[0].content.push({...messages[0].content[0]}); }],
    ['wrong call', ({messages}) => { messages[1].toolCallId = 'unknown'; }],
    ['failed tool', ({messages}) => { messages[1].isError = true; }],
    ['missing tool result', ({messages}) => { messages.pop(); }],
    ['truncated tool transport', ({messages}) => { messages[0].stopReason = 'length'; }],
    ['provider error', ({messages}) => { messages[0].errorMessage = 'provider failed'; }],
    ['unauthorized file', ({metadata}) => { metadata.files = ['src/evil.py']; }],
  ];
  for (const [name, edit] of cases) {
    const sample = validImplementerEnvelope();
    edit(sample);
    const result = runPatchedDecision({
      agentName: 'implementer-coding-session',
      messages: sample.messages, metadata: sample.metadata, receipt: sample.receipt,
      errInfo: { hasError: false },
    }).result;
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.error, 'Missing final text', name);
  }
  const sample = validImplementerEnvelope();
  const notCoding = runPatchedDecision({
    agentName: 'other-agent', ...sample, errInfo: { hasError: false },
  });
  assert.equal(notCoding.result.exitCode, 1);
});

test('#632 fatal provider/abort errors never become accepted terminal toolUse', () => {
  const sample = validImplementerEnvelope();
  const earlierFailure = { role: 'toolResult', toolCallId: 'read-1',
    toolName: 'read', isError: true };
  for (const errorType of ['provider', 'timeout', 'cancelled', 'transport']) {
    const result = runPatchedDecision({
      agentName: 'implementer-coding-session', ...sample,
      messages: [earlierFailure, ...sample.messages],
      errInfo: { hasError: true, errorType, exitCode: 4, details: 'failed' },
    }).result;
    assert.equal(result.exitCode, 4, errorType);
  }
});

test('#632 restored/validation-repair uses empty terminal arguments and current attempt', () => {
  const { messages, metadata, receipt, env } = validImplementerEnvelope();
  delete metadata.result_text;
  delete metadata.summary;
  messages[0].content[0].arguments = {};
  env.PI_VALIDATION_REPAIR = 'true';
  receipt.attempt_id = 'validation-repair:1';
  receipt.result_metadata_sha256 = createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
  const result = runPatchedDecision({
    agentName: 'implementer-coding-session', messages, receipt, metadata,
    errInfo: { hasError: false },
  });
  // The harness fixture supplies a primary-run env; unlike a self-attestation,
  // a matching sidecar from a different repair attempt must remain rejected.
  assert.equal(result.result.exitCode, 1);

  const accepted = acceptedTerminalImplementerReceipt(
    messages, receipt, Buffer.from(JSON.stringify(metadata)), env, 'coding-632');
  assert.equal(accepted, true);
  const wrongAttempt = { ...env, PI_VALIDATION_REPAIR_ATTEMPT: '2' };
  assert.equal(acceptedTerminalImplementerReceipt(
    messages, receipt, Buffer.from(JSON.stringify(metadata)), wrongAttempt, 'coding-632'), false);
  messages[0].content[0].arguments = { resultText: 'model-generated file names' };
  assert.equal(acceptedTerminalImplementerReceipt(
    messages, receipt, Buffer.from(JSON.stringify(metadata)), env, 'coding-632'), false);
});

test('#632 blocked outcome needs exact runtime-bound reason, not generic success', () => {
  const { messages, metadata, receipt, env } = validImplementerEnvelope();
  metadata.outcome = 'blocked';
  metadata.files = [];
  metadata.blocked_reason = 'Task requirements contradict each other';
  delete metadata.result_text;
  receipt.outcome = 'blocked';
  receipt.result_metadata_sha256 = createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
  messages[0].content[0].arguments = { blocked_reason: metadata.blocked_reason };
  assert.equal(acceptedTerminalImplementerReceipt(
    messages, receipt, Buffer.from(JSON.stringify(metadata)), env, 'coding-632'), true);
  messages[0].content[0].arguments.blocked_reason = 'unrelated human claim';
  assert.equal(acceptedTerminalImplementerReceipt(
    messages, receipt, Buffer.from(JSON.stringify(metadata)), env, 'coding-632'), false);
});

function deferredTerminalBarrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('#645 overlapping asynchronous coding delegations reject before clobbering the active terminal session', async () => {
  const key = 'PI_IMPLEMENTER_SUBAGENT_TERMINAL_SESSION_ID';
  const changes = [];
  const backing = { [key]: 'pre-existing-session' };
  const env = new Proxy(backing, {
    set(target, field, value) {
      if (field === key) changes.push(value);
      return Reflect.set(target, field, value);
    },
  });
  const entered = deferredTerminalBarrier();
  const finish = deferredTerminalBarrier();
  async function delegate(sessionId, work) {
    const release = acquireImplementerTerminalSession(sessionId, env);
    try { return await work(); }
    finally {
      release();
      release(); // Accidental double cleanup must not restore a second time.
    }
  }

  const first = delegate('coding-A', async () => {
    assert.equal(env[key], 'coding-A');
    entered.resolve();
    await finish.promise;
    const sample = validImplementerEnvelope();
    sample.receipt.session_id = 'coding-A';
    const accepted = runPatchedDecision({
      agentName: 'implementer-coding-session',
      ...sample, sessionId: env[key], errInfo: { hasError: false },
    }).result;
    assert.equal(accepted.exitCode, 0, 'first receipt belongs to its active session');
    sample.receipt.session_id = 'coding-B';
    const foreign = runPatchedDecision({
      agentName: 'implementer-coding-session',
      ...sample, sessionId: env[key], errInfo: { hasError: false },
    }).result;
    assert.equal(foreign.exitCode, 1, 'cross-session receipt is rejected');
  });
  await entered.promise;
  try {
    await assert.rejects(delegate('coding-B', async () => {
      throw new Error('overlap must not launch the second fork');
    }), error => error.code === 'PI_IMPLEMENTER_TERMINAL_SESSION_OVERLAP');
    assert.equal(env[key], 'coding-A', 'rejected fork leaves active ID intact');
    assert.deepEqual(changes, ['coding-A'], 'overlap did not write the process environment');
  } finally {
    finish.resolve();
  }
  await first;
  assert.equal(env[key], 'pre-existing-session');
  assert.deepEqual(changes, ['coding-A', 'pre-existing-session'], 'first ID restored exactly once');

  await delegate('coding-B', async () => {
    assert.equal(env[key], 'coding-B');
    const sample = validImplementerEnvelope();
    sample.receipt.session_id = 'coding-B';
    assert.equal(runPatchedDecision({
      agentName: 'implementer-coding-session',
      ...sample, sessionId: env[key], errInfo: { hasError: false },
    }).result.exitCode, 0, 'next delegation can accept its own receipt');
    sample.receipt.session_id = 'coding-A';
    assert.equal(runPatchedDecision({
      agentName: 'implementer-coding-session',
      ...sample, sessionId: env[key], errInfo: { hasError: false },
    }).result.exitCode, 1, 'prior session receipt must not be reused');
  });
  assert.deepEqual(changes, ['coding-A', 'pre-existing-session', 'coding-B', 'pre-existing-session']);
});

test('#645 terminal session lease cleans up on throw, abort and timeout, including absent prior env', async () => {
  const key = 'PI_IMPLEMENTER_SUBAGENT_TERMINAL_SESSION_ID';
  const env = {};
  async function delegate(sessionId, work) {
    const release = acquireImplementerTerminalSession(sessionId, env);
    try { return await work(); }
    finally { release(); }
  }
  for (const kind of ['error', 'abort', 'timeout']) {
    await assert.rejects(delegate('coding-' + kind, async () => {
      assert.equal(env[key], 'coding-' + kind);
      if (kind === 'abort') {
        const signal = new AbortController();
        signal.abort();
        assert.equal(signal.signal.aborted, true);
      }
      throw new Error(kind);
    }), new RegExp(kind));
    assert.equal(Object.hasOwn(env, key), false, kind + ' removed absent prior ID');
  }
  await delegate('coding-after-failures', async () => assert.equal(env[key], 'coding-after-failures'));
  assert.equal(Object.hasOwn(env, key), false);
  assert.throws(() => acquireImplementerTerminalSession('', env), /non-empty coding terminal session ID/);
  assert.equal(Object.hasOwn(env, key), false);
});
