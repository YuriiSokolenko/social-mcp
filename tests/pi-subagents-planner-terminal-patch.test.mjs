import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('pinned pi-subagents source patch is narrow, deterministic, and detects drift', () => {
  const source = [
    'import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";',
    'const artifactOutputByResult = new WeakMap();',
    '\t\tconst missingOutput = !finalText?.trim() && !validatedStructuredOutput;',
    '\t\tif ((missingOutput || terminalEmptyAfterUsefulWork) && (!errInfo.hasError || hasEmptyTerminalAssistantResponse(messages))) {',
    '\t\t\tresult.exitCode = 1;',
    '\t\t}',
  ].join('\n');
  const patched = patchPiSubagentsSource(source);
  assert.match(patched, /trustedPlannerTerminalToolUse\(messages, agent\.name\)/);
  assert.match(patched, /!acceptedTerminalPlan && \(missingOutput/);
  assert.match(patched, /PI_PLANNER_EVIDENCE_STATE_FILE/);
  assert.match(patched, /readFileSync/);
  assert.match(patched, /result\.exitCode = 1;/);
  assert.throws(() => patchPiSubagentsSource(patched), /source drift/);
  assert.throws(() => patchPiSubagentsSource(source.replace('terminalEmptyAfterUsefulWork', 'notExpected')), /source drift/);
});

test('runner build applies pinned patch before saving Pi package seed', () => {
  const dockerfile = fs.readFileSync('infra/github-runner-autoscaler/worker.Dockerfile','utf8');
  assert.match(dockerfile, /ARG PI_SUBAGENTS_VERSION=0\.76\.1/);
  const install = dockerfile.indexOf('pi install --no-approve "npm:pi-subagents@');
  const patch = dockerfile.indexOf('node \/home\/runner\/build-tools\/patch-pi-subagents-planner-terminal\.mjs');
  const seed = dockerfile.indexOf('cp -a \/home\/runner\/\.pi\/agent\/npm \/opt\/pi-package-seed/');
  assert.ok(install >= 0 && install < patch && patch < seed);
});
