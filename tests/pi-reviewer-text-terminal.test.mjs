import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-704-review-'));
const loader = path.join(temp, 'typebox-loader.mjs');
fs.writeFileSync(loader, [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === 'typebox') {",
  "    const source = 'export const Type = { String: (o = {}) => ({type:\"string\", ...o}), Literal: value => ({const:value}), Union: anyOf => ({anyOf}), Object: (properties, options = {}) => ({type:\"object\", properties, required:Object.keys(properties), ...options}) };';",
  "    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };",
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n'));
register(pathToFileURL(loader), import.meta.url);
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));

const {
  default: registerReviewTool, REVIEW_SUBMISSION_SCHEMA, REVIEW_SUBMISSION_TOKENS,
  REVIEW_SUBMISSION_RETRY_TOKENS, restrictReviewSubmissionPayload, reviewerProviderBudgetEvidence,
} = await import('../scripts/pi-reviewer-result-tool.mjs');
const {
  reviewAcceptanceCriteria, validateTextReview, parseReviewResult, assertReviewReceipt,
} = await import('../scripts/pi-review-result.mjs');

const issueBody = '## Acceptance\nZero external dependencies; only the scoped standalone files; deterministic passing tests.';
const criteria = reviewAcceptanceCriteria(issueBody);
const evidenceText = [
  '## Findings',
  'Reviewed actual source and isolated Node tests.',
  '',
  '## Acceptance evidence',
  '### Criterion 1: Zero external dependencies',
  'Status: ESTABLISHED',
  'Evidence: examples/workflow-smoke/csv/cli.mjs imports only built-in node modules; no package install is needed.',
  '### Criterion 2: Only the scoped standalone files',
  'Status: ESTABLISHED',
  'Evidence: git diff --name-only shows only examples/workflow-smoke/csv/cli.mjs and its test file.',
  '### Criterion 3: Deterministic passing tests',
  'Status: ESTABLISHED',
  'Evidence: node --test examples/workflow-smoke/csv/cli.test.mjs checks stable fixtures and completes without failures.',
].join('\n');
const blockingText = [
  '## Blocking findings',
  '- examples/workflow-smoke/csv/cli.mjs:20 fails when input is empty because undefined fields are read before validation.',
].join('\n');

const tool = () => ({
  type: 'function',
  function: { name: 'submit_result', parameters: { type: 'object', properties: {
    reviewText: {}, verdict: {}, criteria_evidence: {},
  } } },
});
const payload = (max_completion_tokens = 4096) => ({
  max_completion_tokens,
  stream: true,
  tools: [tool()],
  tool_choice: { type: 'function', function: { name: 'submit_result' } },
});
function envSetup() {
  process.env.PI_STAGE = 'reviewer';
  process.env.PR = '699';
  process.env.ISSUE = '695';
  process.env.HEAD_SHA = 'head-704';
  process.env.GITHUB_RUN_ID = '987654';
  process.env.REVIEW_RUN_ATTEMPT = '1';
  process.env.GITHUB_ACTIONS = 'false';
  process.env.REVIEW_CONTEXT = path.join(temp, 'context-704.json');
  process.env.PI_TERMINAL_RESULT_FILE = path.join(temp, 'receipt-704.json');
  fs.writeFileSync(process.env.REVIEW_CONTEXT, JSON.stringify({
    pr: 699, issue: 695, head: 'head-704',
    review: { issue: { number: 695, body: issueBody } },
  }));
  fs.rmSync(process.env.PI_TERMINAL_RESULT_FILE, { force: true });
}
function fakePi() {
  envSetup();
  const callbacks = new Map();
  const registered = new Map();
  const entries = [];
  const active = [];
  const budgets = [];
  const steers = [];
  const ctx = { model: { maxTokens: 1024, contextWindow: 32768 },
    sessionManager: { getSessionId: () => 'session-704' },
    abort() { this.aborted = true; } };
  const pi = {
    registerTool(t) { registered.set(t.name, t); },
    on(name, cb) { callbacks.set(name, [...(callbacks.get(name) ?? []), cb]); },
    setModel: async model => { budgets.push(model.maxTokens); ctx.model = model; return true; },
    setActiveTools(names) { active.push(names); },
    sendUserMessage: async (message, options) => { steers.push({ message, options }); },
    appendEntry(type, data) { entries.push({ type, data }); },
  };
  const emit = async (name, event = {}) => {
    let value;
    for (const cb of callbacks.get(name) ?? []) {
      const next = await cb(event, ctx);
      if (next !== undefined) value = next;
    }
    return value;
  };
  registerReviewTool(pi);
  return { pi, ctx, emit, registered, entries, active, budgets, steers };
}
const assistant = (reason, calls = []) => ({
  role: 'assistant', stopReason: reason, usage: { inputTokens: 500 },
  content: calls.map(([name, id]) => ({ type: 'toolCall', name, id })),
});
async function begin(h, verdict = 'PASS') {
  const event = { toolName: 'begin_review_submission', toolCallId: 'begin-704', input: { verdict } };
  assert.equal(await h.emit('tool_call', event), undefined);
  await h.registered.get('begin_review_submission').execute('begin-704', { verdict }, null, null, h.ctx);
  await h.emit('message_end', { message: assistant('toolUse', [['begin_review_submission', 'begin-704']]) });
  await h.emit('tool_execution_end', { ...event, isError: false });
  await h.emit('turn_end');
  assert.deepEqual(h.active.at(-1), ['submit_result']);
  assert.equal(h.budgets.at(-1), 4096);
  assert.equal(h.steers.length, 1);
  return h.emit('before_provider_request', { payload: payload() });
}
async function submit(h, reviewText = evidenceText, { verdict = 'PASS', id = 'submit-704' } = {}) {
  const event = { toolName: 'submit_result', toolCallId: id, input: { reviewText } };
  assert.equal(await h.emit('tool_call', event), undefined);
  await h.emit('message_end', { message: assistant('toolUse', [['submit_result', id]]) });
  const returned = await h.registered.get('submit_result').execute(id, { reviewText }, null, null, h.ctx);
  await h.emit('tool_execution_end', { ...event, isError: false });
  assert.equal(returned.terminate, true);
  assert.equal(h.entries.at(-1).data.verdict, verdict);
  return h.entries.at(-1).data;
}

test('#704 actual provider wire has one text-only executable tool and auto choice', () => {
  for (const t of [
    tool(),
    { type: 'function', name: 'submit_result', parameters: {} },
    { function: { name: 'submit_result', parameters: {} } },
  ]) {
    const next = restrictReviewSubmissionPayload({ ...payload(), tools: [t] });
    assert.equal(next.tool_choice, 'auto');
    assert.equal(next.tools.length, 1);
    assert.deepEqual(next.tools[0].function?.parameters ?? next.tools[0].parameters, REVIEW_SUBMISSION_SCHEMA);
    assert.deepEqual(REVIEW_SUBMISSION_SCHEMA.required, ['reviewText']);
    assert.deepEqual(Object.keys(REVIEW_SUBMISSION_SCHEMA.properties), ['reviewText']);
    assert.equal(next.tools[0].function?.parameters?.properties?.criteria_evidence, undefined);
    assert.equal(reviewerProviderBudgetEvidence(next, REVIEW_SUBMISSION_TOKENS).verified, true);
  }
});

test('#704 provider fails closed for leaked tools/forcing/mismatched budgets', () => {
  for (const x of [
    { ...payload(), tools: [] },
    { ...payload(), tools: [null] },
    { ...payload(), tools: [tool(), { type: 'function', function: { name: 'read' } }] },
    { ...payload(), tools: [{ type: 'function', function: { name: 'read' } }] },
    { ...payload(), tool_choice: { type: 'function', function: { name: 'read' } } },
    { ...payload(), tool_choice: 'invalid' },
    { ...payload(), toolChoice: 'auto' },
  ]) {
    const next = restrictReviewSubmissionPayload(x);
    assert.equal(next.tool_choice, 'none');
    assert.deepEqual(next.tools, []);
  }
  assert.equal(reviewerProviderBudgetEvidence({ max_completion_tokens: 2048 }, 4096).verified, false);
  assert.equal(reviewerProviderBudgetEvidence({
    max_completion_tokens: 4096, max_output_tokens: 8192,
  }, 4096).reason, 'conflicting_budgets');
});

test('#704 PASS needs complete issue-derived evidence; probe-only PASS is rejected', () => {
  assert.equal(criteria.length, 3);
  const value = validateTextReview({ verdict: 'PASS', reviewText: evidenceText, acceptanceCriteria: criteria });
  assert.equal(value.criteria_evidence.length, 3);
  for (const bad of [
    'Transmission probe for criteria_evidence channel.',
    '## Acceptance evidence\n### Criterion 1: Only the scoped standalone files\nStatus: ESTABLISHED\nEvidence: git diff --name-only verifies files.',
    evidenceText.replace('### Criterion 3:', '### Criterion 2:'),
    evidenceText.replace('node --test examples/workflow-smoke/csv/cli.test.mjs checks stable fixtures and completes without failures.', 'Tests pass.'),
  ]) assert.throws(() => validateTextReview({ verdict: 'PASS', reviewText: bad, acceptanceCriteria: criteria }),
    /review_(?:criterion|probe)/);
});

test('#704 CHANGES_REQUESTED requires actionable blocking findings', () => {
  assert.equal(validateTextReview({
    verdict: 'CHANGES_REQUESTED', reviewText: blockingText, acceptanceCriteria: criteria,
  }).verdict, 'CHANGES_REQUESTED');
  assert.throws(() => validateTextReview({
    verdict: 'CHANGES_REQUESTED', reviewText: 'Looks problematic.',
  }), /review_blocker_not_actionable/);
});

test('#704 phase handoff, executed toolUse and run-bound receipt publish authoritative PASS', async () => {
  const h = fakePi();
  const wire = await begin(h);
  assert.equal(wire.tool_choice, 'auto');
  assert.equal(wire.tools.length, 1);
  assert.equal(wire.max_completion_tokens, 4096);
  assert.deepEqual(wire.tools[0].function.parameters.required, ['reviewText']);
  const result = await submit(h);
  const jsonl = JSON.stringify({ type: 'entry_appended', entry: {
    type: 'custom', customType: 'review-result', data: result,
  } });
  assert.match(parseReviewResult(jsonl, process.env).text, /REVIEW_RESULT: PASS/);
  assert.equal(h.ctx.aborted, undefined);
  assert.equal(h.budgets.at(-1), 1024);
  assertReviewReceipt(result, process.env);
  assert.throws(() => assertReviewReceipt({ ...result, text: 'modified' }, process.env),
    /receipt_invalid/);
});

test('#704 missing receipt is not a PASS even with a complete review-result entry', () => {
  envSetup();
  const result = validateTextReview({
    verdict: 'PASS', reviewText: evidenceText, acceptanceCriteria: criteria,
  });
  const events = JSON.stringify({ type: 'entry_appended', entry: {
    type: 'custom', customType: 'review-result', data: result,
  } });
  // Direct consumer must enforce the trusted terminal receipt.
  assert.throws(() => parseReviewResult(events, process.env), /review_terminal_receipt_missing/);
  // Production CLI must NOT silently drop receipt validation when PI_STAGE is
  // absent in its environment (e.g. invoking after a previous shell step).
  const raw = path.join(temp, 'missing-receipt-704.jsonl');
  fs.writeFileSync(raw, events + '\n');
  const { PI_STAGE: _stage, ...envWithoutStage } = process.env;
  const executed = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts/pi-review-result.mjs'), raw,
  ], { encoding: 'utf8', env: envWithoutStage });
  assert.equal(executed.status, 4);
  assert.match(executed.stderr, /review_terminal_receipt_missing/);
  assert.equal(executed.stdout, '');
});

test('#704 bound verdict cannot be changed by submit_result argument', async () => {
  const h = fakePi();
  await begin(h, 'CHANGES_REQUESTED');
  await submit(h, blockingText, { verdict: 'CHANGES_REQUESTED' });
  assert.equal(h.entries.at(-1).data.verdict, 'CHANGES_REQUESTED');
  const h2 = fakePi();
  await begin(h2);
  const event = { toolName: 'submit_result', toolCallId: 'wrong', input: { reviewText: evidenceText, verdict: 'CHANGES_REQUESTED' } };
  assert.match((await h2.emit('tool_call', event)).reason, /only one nonempty reviewText/);
});

test('#704 stale run or HEAD prevents terminal execution and publication', async () => {
  const h = fakePi();
  await begin(h);
  process.env.HEAD_SHA = 'new-head';
  const e = { toolName: 'submit_result', toolCallId: 'stale-704', input: { reviewText: evidenceText } };
  await h.emit('tool_call', e);
  await h.emit('message_end', { message: assistant('toolUse', [['submit_result', 'stale-704']]) });
  await assert.rejects(() => h.registered.get('submit_result').execute('stale-704', { reviewText: evidenceText }, null, null, h.ctx),
    /review_submission_identity_invalid/);
  assert.equal(h.entries.length, 0);
  assert.equal(fs.existsSync(process.env.PI_TERMINAL_RESULT_FILE), false);
});

test('#704 prose-only, wrong/duplicate calls, and format correction are bounded', async () => {
  const h = fakePi();
  await begin(h);
  await h.emit('message_end', { message: assistant('stop') });
  await h.emit('turn_end');
  assert.equal(h.steers.length, 2);
  assert.equal(h.budgets.at(-1), 4096);
  await h.emit('before_provider_request', { payload: payload() });
  await h.emit('message_end', { message: assistant('toolUse', [['read', 'read-x'], ['submit_result', 'extra']]) });
  await h.emit('turn_end');
  assert.equal(h.ctx.aborted, true);
  assert.equal(fs.existsSync(process.env.PI_TERMINAL_RESULT_FILE), false);
});

test('#704 truncation gets exactly one 8192-token request and no loops', async () => {
  const h = fakePi();
  await begin(h);
  await h.emit('message_end', { message: assistant('length') });
  await h.emit('turn_end');
  assert.equal(h.budgets.at(-1), REVIEW_SUBMISSION_RETRY_TOKENS);
  const next = await h.emit('before_provider_request', { payload: payload(8192) });
  assert.equal(reviewerProviderBudgetEvidence(next, 8192).verified, true);
  await h.emit('message_end', { message: assistant('length') });
  await h.emit('turn_end');
  assert.equal(h.ctx.aborted, true);
});

test('#704 runtime rejects direct pre-transition submit and preserves failure state', async () => {
  const h = fakePi();
  assert.match((await h.emit('tool_call', {
    toolName: 'submit_result', toolCallId: 'premature', input: { reviewText: evidenceText },
  })).reason, /First call begin_review_submission/);
  assert.equal(h.entries.length, 0);
});
