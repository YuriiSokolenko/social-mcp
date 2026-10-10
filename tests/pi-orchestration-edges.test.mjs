import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createReviewReceipt, reviewAcceptanceCriteria, validateTextReview } from '../scripts/pi-review-result.mjs';
import { LONG_AGO, ciRun, fakeGithub, issue, pullRequest, stageRun, submitResult, taskBody } from './helpers/fake-github.mjs';
import {
  SCRIPT, dispatcherApply, failed, ok, reconcile, reviewerStarted, reviewerVerdict, transition, triage,
} from './helpers/orchestration-scenarios.mjs';

// Stage-boundary edges (#727): each production entrypoint is driven into its
// no-op, already-satisfied, rejection and duplicate-delivery branches against
// the fake GitHub, asserting the observable outcome and that nothing else
// changed. Cross-stage flows live in pi-orchestration-flow.test.mjs.

const lastJson = result => JSON.parse(result.stdout.trim().split('\n').at(-1));

test('Implementer terminal transitions: already-satisfied completes, stopped releases, closed is a terminal no-op', t => {
  const gh = fakeGithub(t, {
    issues: [
      issue(1, { labels: ['pi:running'] }),
      issue(2, { labels: ['architect:ready'] }),
      issue(3, { labels: [], state: 'closed', state_reason: 'completed' }),
      issue(4, { labels: ['pi:needs-human'] }),
      issue(5, { labels: ['dispatcher:ready'] }),
    ],
  });
  ok(transition(gh, 1, 'satisfied', 'Latest dev already contains the requested end state.'), 'satisfied');
  assert.equal(gh.read().issues[1].state, 'closed');
  assert.equal(gh.read().issues[1].state_reason, 'completed');
  assert.match(gh.read().comments.at(-1).body, /already contains/);

  ok(transition(gh, 2, 'stopped', 'Architect stopped.'), 'stopped');
  assert.deepEqual(gh.labelsOf(2), []);
  assert.equal(gh.read().issues[2].state, 'open');

  const before = gh.mark();
  const output = join(gh.dir, 'output');
  const noop = ok(transition(gh, 3, 'running', '', { GITHUB_OUTPUT: output }), 'closed no-op');
  assert.match(noop.stdout, /no-op because the issue is already closed/);
  assert.match(readFileSync(output, 'utf8'), /terminal=true/);
  assert.deepEqual(gh.mutationsSince(before), []);

  failed(transition(gh, 4, 'running'), /requires an explicit retry/);
  failed(transition(gh, 5, 'satisfied'), /satisfied requires pi:running/);
  failed(transition(gh, 5, 'teleport'), /unknown issue transition/);
  failed(gh.run(SCRIPT.transition, ['issue', 'running']), /usage: pi-transition\.mjs/);
  assert.deepEqual(gh.mutationsSince(before), [], 'rejected transitions change nothing');
});

test('Triage re-validates at apply time: changed candidates, missing criteria and newly owned issues', t => {
  const gh = fakeGithub(t, {
    issues: [
      issue(10, { labels: ['triage:ready'] }),
      issue(11, { labels: ['triage:ready'], body: taskBody({ criteria: false }) }),
    ],
  });
  const before = gh.mark();
  failed(triage(gh, { ready: [10] }).apply, /classify every current candidate exactly once/);
  failed(triage(gh, { ready: [10, 11] }).apply, /#11 cannot be ready/);
  assert.deepEqual(gh.mutationsSince(before).filter(request => request.path !== '/labels'), [
    { method: 'PATCH', path: '/issues/10', status: 200 },
  ], 'only the valid issue before the invalid one was queued');

  // An issue another stage claimed between prepare and apply is skipped, not re-owned.
  gh.update(state => { state.issues[11].labels = [{ name: 'triage:ready' }]; state.issues[11].body = taskBody(); });
  gh.update(state => {
    state.interleave.push({ method: 'GET', path: '^/issues/11$', patch: { issues: { 11: { labels: [{ name: 'pi:running' }] } } } });
  });
  const raced = ok(triage(gh, { ready: [11] }).apply, 'Triage race');
  assert.match(raced.stdout, /Skipped #11: no longer an eligible candidate/);
  assert.deepEqual(gh.labelsOf(11), ['pi:running']);
  assert.match(ok(triage(gh).apply, 'empty Triage').stdout, /Triage found no candidate issues/);
  failed(gh.run(SCRIPT.triage, ['prepare', gh.file('c.json', '')], { env: { PI_TRIAGE_BATCH_SIZE: '0' } }), /PI_TRIAGE_BATCH_SIZE/);
  failed(gh.run(SCRIPT.triage, ['classify']), /usage: pi-triage\.mjs/);
});

test('Dispatcher skips an issue another serialized Dispatcher assigned mid-apply and invalid task metadata', t => {
  const gh = fakeGithub(t, {
    issues: [
      issue(20, { labels: ['dispatcher:ready'], body: taskBody({ priority: 'P0' }) }),
      issue(21, { labels: ['dispatcher:ready'] }),
      issue(22, { labels: ['dispatcher:ready'], body: 'No task metadata at all.' }),
    ],
    // The loop's first per-issue snapshot already shows #20 owned by an earlier run.
    interleave: [{ method: 'GET', path: '^/issues$', skip: 1, patch: { issues: { 20: { labels: [{ name: 'pi:ready' }] } } } }],
  });
  const result = ok(dispatcherApply(gh, [{ issue: 20, decision: 'IMPLEMENT' }, { issue: 21, decision: 'IMPLEMENT' }]), 'Dispatcher');
  assert.match(result.stdout, /Skipped #20: already assigned by an earlier dispatcher/);
  assert.deepEqual(gh.read().dispatches.map(item => item.inputs.issue_number), ['21']);
  const context = join(gh.dir, 'context.json');
  ok(gh.run(SCRIPT.dispatcher, ['prepare', context]), 'prepare');
  const skipped = JSON.parse(readFileSync(context, 'utf8')).skipped;
  assert.ok(skipped.some(item => item.issue === 22), 'an issue without task metadata is never dispatched');
  failed(gh.run(SCRIPT.dispatcher, ['plan']), /usage: pi-dispatcher\.mjs/);
});

test('Architect: manual claim, revise, interrupted split re-run without duplicates, and changed-source rejection', t => {
  const stepBody = goal => `${goal}\n\n## Acceptance criteria\n- The ${goal.toLowerCase()} is merged behind tests.\n- The change stays independently reviewable.\n- Focused validation covers the new behavior.`;
  const gh = fakeGithub(t, {
    issues: [
      issue(30, { labels: ['dispatcher:ready'], title: 'Revise me please' }),
      issue(31, { labels: ['architect:ready'], title: 'Split me safely' }),
      issue(32, { labels: [], title: 'Not queued' }),
      issue(33, { labels: ['architect:ready'], title: 'Changes under the planner' }),
    ],
    faults: [{ method: 'POST', path: '^/issues$', skip: 1, kind: 'network' }],
  });
  const prepare = (number, env = {}) => {
    const context = gh.file(`architect-${number}.json`, '');
    return { context, result: gh.run(SCRIPT.architect, ['prepare', String(number), context], { env }) };
  };

  // Manual workflow_dispatch claims a queued issue, and refuses one that is not queued.
  const manual = prepare(30, { GITHUB_EVENT_NAME: 'workflow_dispatch' });
  ok(manual.result, 'manual prepare');
  assert.deepEqual(gh.labelsOf(30), ['architect:ready']);
  failed(prepare(32, { GITHUB_EVENT_NAME: 'workflow_dispatch' }).result, /requires dispatcher:ready/);
  const revised = `${stepBody('Revised greeting scope')}`;
  ok(gh.run(SCRIPT.architect, ['publish', '30', gh.file('revise.jsonl', submitResult('architect-result', {
    parent_issue: 30, action: 'revise', reason: 'The original scope mixed two independent changes.',
    title: 'Revised greeting scope task', body: revised, priority: 'P2', depends_on: [],
  })), manual.context]), 'revise');
  assert.deepEqual(gh.labelsOf(30), ['dispatcher:ready']);
  assert.equal(gh.read().issues[30].title, 'Revised greeting scope task');
  assert.match(gh.read().issues[30].body, /Priority: P2/);

  // A transport failure after the first child: the re-run reuses it instead of duplicating.
  const split = prepare(31);
  ok(split.result, 'split prepare');
  const plan = gh.file('split.jsonl', submitResult('architect-result', {
    parent_issue: 31,
    steps: [
      { key: 'contract', kind: 'contract', priority: 'P1', title: 'Greeting contract first', body: stepBody('Contract for greetings'), depends_on: [] },
      { key: 'impl', kind: 'implementation', priority: 'P1', title: 'Greeting implementation', body: stepBody('Implementation for greetings'), depends_on: ['contract'] },
    ],
  }));
  failed(gh.run(SCRIPT.architect, ['publish', '31', plan, split.context]), /fetch failed/);
  assert.equal(Object.values(gh.read().issues).filter(item => /architect-parent:31;/.test(item.body)).length, 1);
  ok(gh.run(SCRIPT.architect, ['publish', '31', plan, split.context]), 'split re-run');
  const children = Object.values(gh.read().issues).filter(item => /architect-parent:31;/.test(item.body));
  assert.equal(children.length, 2, 'no duplicate child after re-entry');
  assert.deepEqual(gh.labelsOf(31), ['architect:epic']);

  // The source issue changed while the Architect was planning.
  const stale = prepare(33);
  ok(stale.result, 'prepare');
  gh.update(state => { state.issues[33].body = taskBody({ priority: 'P0' }); });
  const before = gh.mark();
  failed(gh.run(SCRIPT.architect, ['publish', '33', plan, stale.context]), /Source issue changed while Architect was planning/);
  gh.update(state => { state.issues[33].labels = [{ name: 'pi:running' }, { name: 'architect:ready' }]; });
  failed(gh.run(SCRIPT.architect, ['publish', '33', plan, stale.context]), /Parent changed while Architect was planning/);
  assert.deepEqual(gh.mutationsSince(before), []);
  failed(gh.run(SCRIPT.architect, ['publish', '33', plan]), /usage: pi-architect\.mjs/);
});

test('PR guard: closed and merged PRs skip normally; foreign or wrong-base PRs are refused; control-plane changes go to a human', t => {
  const gh = fakeGithub(t, {
    issues: [issue(40, { labels: ['pi:mr-created'] })],
    pulls: [
      pullRequest(41, 40, { state: 'closed' }),
      pullRequest(42, 40, { state: 'closed', merged: true }),
      { ...pullRequest(43, 40), head: { ref: 'feature/x', sha: 'h43', repo: { full_name: 'test/repo' } } },
      { ...pullRequest(44, 40), base: { ref: 'main', repo: { full_name: 'test/repo' } } },
      pullRequest(45, 40, { labels: ['review:passed'], files: [{ filename: 'scripts/pi-dispatcher.mjs', status: 'modified' }] }),
    ],
  });
  const guard = number => {
    const out = gh.file(`guard-${number}.json`, '');
    const result = gh.run(SCRIPT.guard, [String(number), out]);
    return { result, value: result.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null };
  };
  assert.equal(guard(41).value.reason, 'closed');
  assert.equal(guard(42).value.reason, 'merged');
  failed(guard(43).result, /is not a same-repository pi\/issue-N PR/);
  failed(guard(44).result, /targeting dev/);
  const gated = guard(45).value;
  assert.equal(gated.reason, 'control-plane');
  assert.deepEqual(gated.forbidden, ['scripts/pi-dispatcher.mjs']);
  assert.deepEqual(gh.labelsOf(45), ['pi:needs-human'], 'stale PASS removed, human owns it');
  failed(gh.run(SCRIPT.guard, ['0', gh.file('x.json', '')]), /positive integer/);
  failed(gh.run(SCRIPT.guard, ['45']), /usage: pr-guard\.mjs/);
});

test('Reviewer state: duplicate run records, delayed invalidators, human takeover and superseded verdicts are idempotent', t => {
  const gh = fakeGithub(t, {
    issues: [issue(50, { labels: ['pi:mr-created'] })],
    pulls: [pullRequest(51, 50, { sha: 'h51' })],
  });
  const env = { REVIEW_RUN_ID: '8001', REVIEW_RUN_ATTEMPT: '1', REVIEW_MODEL: 'qwen', HEAD_SHA: 'h51' };
  const review = (...args) => lastJson(ok(gh.run(SCRIPT.review, args, { env }), args[0]));
  reviewerStarted(gh, 51, 'h51', 8001);
  assert.equal(review('record-run', '51', 'h51', '8001').status, 'already-recorded');
  assert.deepEqual(review('start-run', '51', 'h51', '8001'), { status: 'already-started' });
  assert.deepEqual(review('record-run', '51', 'h-old', '8001'), { status: 'stale' });
  assert.deepEqual(review('start-run', '51', 'h-old', '8001'), { status: 'stale' });

  const before = gh.mark();
  ok(gh.run(SCRIPT.review, ['invalidate', '51', 'h51']), 'invalidate without verdict');
  ok(gh.run(SCRIPT.review, ['invalidate', '51', 'h-older']), 'invalidate from an older push');
  assert.deepEqual(gh.mutationsSince(before), []);

  reviewerVerdict(gh, 51, 'h51', 'PASS', 8001);
  ok(gh.run(SCRIPT.review, ['invalidate', '51', 'h51']), 'delayed invalidator');
  assert.deepEqual(gh.labelsOf(51), ['review:passed'], 'the verdict for the pushed HEAD survives');

  // A newer CHANGES_REQUESTED supersedes the PASS a late recovery would dispatch.
  gh.update(state => { state.pulls[51].labels = [{ name: 'review:changes-requested' }]; });
  assert.deepEqual(lastJson(ok(gh.run(SCRIPT.review, ['dispatch', '51', 'PASS'], {
    env: { ...env, REVIEW_RUN_ID: '8002', REVIEW_REQUIRE_CURRENT_VERDICT: 'true' },
  }))), { status: 'superseded-verdict', verdict: 'PASS' });

  gh.update(state => { state.pulls[51].labels.push({ name: 'pi:needs-human' }); });
  const text = gh.file('review.md', 'REVIEW_RESULT: PASS');
  assert.deepEqual(review('apply', '51', 'h51', 'PASS', text), { status: 'human' });
  assert.deepEqual(review('dispatch', '51', 'PASS'), { status: 'human' });
  assert.equal(gh.read().dispatches.length, 1, 'only the original PASS follow-up was dispatched');

  const recover = (title, outcome) => lastJson(ok(gh.run(SCRIPT.review, ['recover-workflow-run'], {
    env: { REVIEW_RUN_TITLE: title, REVIEW_RUN_ID: '8009', REVIEW_RUN_ATTEMPT: '1', REVIEW_OUTCOME: outcome },
  })));
  assert.deepEqual(recover('🤖 Implement #50', 'failure'), { status: 'ignored', reason: 'not-review-run' });
  assert.deepEqual(recover('🔬 Review PR #51', 'success'), { status: 'ignored', reason: 'non-infrastructure-outcome' });
  assert.deepEqual(recover('🔬 Review PR #51', 'failure'), { status: 'ignored', reason: 'review-not-started-without-run-marker' });
  failed(gh.run(SCRIPT.review, ['teleport', '51']), /usage: review-state\.mjs/);
});

test('Reviewer publication boundary accepts only a receipt-bound, evidence-complete PASS for the current HEAD', t => {
  const gh = fakeGithub(t);
  const criteria = reviewAcceptanceCriteria(taskBody());
  const evidence = [
    ['handler returns the configured greeting', 'ESTABLISHED', 'src/app.py:1 returns GREETING for every request path.'],
    ['handler rejects an empty greeting', 'ESTABLISHED', 'src/app.py:4 raises ValueError when the greeting is empty.'],
    ['unit tests cover greeting and validation error', 'ASSUMPTION', 'tests/test_app.py:10 exercises both paths under pytest.', 'CI runs pytest on the PR head.'],
  ];
  const text = ['The change is complete.', '', '## Acceptance evidence', '', ...evidence.flatMap(([title, status, proof, assumption], index) => [
    `### Criterion ${index + 1}: ${title}`, `Status: ${status}`, `Evidence: ${proof}`, ...(assumption ? [`Assumption: ${assumption}`] : []), '',
  ])].join('\n');
  const data = validateTextReview({ verdict: 'PASS', reviewText: text, acceptanceCriteria: criteria });
  const transcript = gh.file('review.jsonl', submitResult('review-result', data));
  const context = head => gh.file('context.json', JSON.stringify({ pr: 61, issue: 60, head, review: { issue: { body: taskBody() } } }));
  const identity = { session: 's', head: 'h61', run: '9', attempt: '1', issue: '60', pr: '61' };
  const receipt = (payload = data) => gh.file('receipt.json', JSON.stringify(createReviewReceipt(payload, identity)));
  const env = (extra = {}) => ({ GITHUB_RUN_ID: '9', REVIEW_RUN_ATTEMPT: '1', ISSUE: '60', PR: '61', HEAD_SHA: 'h61', REVIEW_CONTEXT: context('h61'), ...extra });

  const accepted = JSON.parse(ok(gh.run(SCRIPT.reviewResult, [transcript], { env: env({ PI_TERMINAL_RESULT_FILE: receipt() }) })).stdout);
  assert.equal(accepted.verdict, 'PASS');
  assert.equal(accepted.criteria_evidence.length, 3);

  const cases = [
    [{ PI_TERMINAL_RESULT_FILE: gh.file('bad.json', '{"kind":') }, /review_terminal_receipt_invalid/],
    [{ PI_TERMINAL_RESULT_FILE: receipt({ ...data, text: `${data.text} ` }) }, /review_terminal_receipt_invalid/],
    [{ PI_TERMINAL_RESULT_FILE: receipt(), REVIEW_CONTEXT: context('h61-old') }, /review_terminal_receipt_stale_head/],
    [{ PI_TERMINAL_RESULT_FILE: receipt(), REVIEW_CONTEXT: gh.file('missing-context', '{') }, /review_context_invalid/],
  ];
  for (const [extra, pattern] of cases) {
    const result = gh.run(SCRIPT.reviewResult, [transcript], { env: env(extra) });
    assert.equal(result.status, 4, result.output);
    assert.match(result.stderr, pattern);
  }
  const noResult = gh.run(SCRIPT.reviewResult, [gh.file('empty.jsonl', '')], { env: env() });
  assert.equal(noResult.status, 3);
  assert.equal(gh.run(SCRIPT.reviewResult, [], { env: env() }).status, 2);
});

test('Merge Gate skips unready or human-owned PRs, stops on red dev CI and refuses an unconfirmed merge', t => {
  const gh = fakeGithub(t, {
    issues: [
      issue(70, { labels: ['pi:running'] }),
      issue(72, { labels: ['pi:mr-created'] }),
      issue(74, { labels: ['pi:mr-created'] }),
    ],
    pulls: [
      pullRequest(71, 70, { sha: 'h71', labels: ['review:passed'] }),
      pullRequest(73, 72, { sha: 'h73', labels: ['review:passed', 'pi:needs-human'] }),
      pullRequest(75, 74, { sha: 'h75', labels: ['review:passed'] }),
    ],
    runs: [ciRun('dev-0', { event: 'push', conclusion: 'failure' }), ciRun('h71'), ciRun('h73'), ciRun('h75')],
  });
  const blocked = ok(gh.run(SCRIPT.mergeGate), 'Merge Gate');
  assert.match(blocked.output, /#71: issue #70 is not ready for merge/);
  assert.match(blocked.output, /#73: PR requires human attention/);
  assert.match(blocked.output, /#75: waiting for green dev CI for dev-0; current state=failed/);
  assert.deepEqual(gh.mutations(), []);

  gh.update(state => {
    state.runs[0].conclusion = 'success';
    state.faults.push({ method: 'PUT', path: '^/pulls/75/merge$', status: 200, body: '{"merged":false}' });
  });
  failed(gh.run(SCRIPT.mergeGate), /#75: merge API did not confirm merge/);
  assert.deepEqual(gh.read().merges, []);
  assert.deepEqual(gh.read().dispatches, []);
});

test('post-merge finalizes only a merged, linked Pi PR and is idempotent', t => {
  const gh = fakeGithub(t, {
    issues: [issue(80, { labels: ['pi:mr-created'] }), issue(82, { labels: ['pi:mr-created'] })],
    pulls: [
      pullRequest(81, 80, { state: 'closed', merged: true, merged_at: LONG_AGO, merge_commit_sha: 'm81', body: 'No closing keyword.' }),
      { ...pullRequest(83, 82, { state: 'closed', merged: true, merged_at: LONG_AGO, merge_commit_sha: 'm83' }),
        head: { ref: 'feature/x', sha: 'h83', repo: { full_name: 'test/repo' } } },
    ],
    refs: { 'heads/dev': 'm83', 'heads/pi/issue-80': 'h81' },
  });
  for (const [sha, pattern] of [['m-none', /nothing to finalize/], ['m81', /not a valid Pi issue PR/], ['m83', /not a valid Pi issue PR/]]) {
    assert.match(ok(gh.run(SCRIPT.postMerge, [sha]), sha).stdout, pattern);
  }
  assert.deepEqual(gh.mutations(), []);
  assert.equal(gh.read().issues[80].state, 'open');
  failed(gh.run(SCRIPT.postMerge), /usage: pi-post-merge\.mjs/);
});

test('Reconciler repairs closed-but-owned issues, garbage-collects completed checkpoints and reports to the step summary', t => {
  const gh = fakeGithub(t, {
    issues: [
      issue(90, { labels: ['pi:running'], state: 'closed', state_reason: 'completed' }),
      issue(91, { labels: ['pi:running'] }),
      issue(92, { labels: [], state: 'closed', state_reason: 'not_planned' }),
    ],
    runs: [stageRun('🤖 Implement #91 · qwen'), stageRun('🔬 Review PR #1', { status: 'completed' })],
    refs: { 'heads/dev': 'dev-0', 'heads/pi/issue-90-checkpoint': 'cp90', 'heads/pi/issue-92-checkpoint': 'cp92' },
  });
  const summary = join(gh.dir, 'summary.md');
  ok(gh.run(SCRIPT.reconcile, ['--apply'], { env: { PI_AUTOMATION_MODE: 'RUNNING', GITHUB_STEP_SUMMARY: summary } }), 'Reconciler');
  assert.deepEqual(gh.labelsOf(90), [], 'closed issue loses pipeline ownership');
  assert.deepEqual(gh.labelsOf(91), ['pi:running'], 'a live Implementer keeps ownership');
  assert.deepEqual(gh.read().deletedRefs, ['heads/pi/issue-90-checkpoint'], 'only a completed issue checkpoint is collected');
  assert.match(readFileSync(summary, 'utf8'), /## Pipeline reconciliation[\s\S]*closed-active/);
  assert.deepEqual(gh.read().dispatches, []);
});

test('control and dispatch adapters reject unknown modes and unconfigured workflows', t => {
  const gh = fakeGithub(t, { variables: { PI_AUTOMATION_MODE: 'RUNNING' } });
  failed(gh.run(SCRIPT.control, ['set', 'FAST']), /invalid automation mode: FAST/);
  failed(gh.run(SCRIPT.control, ['toggle']), /usage: automation-control\.mjs/);
  failed(gh.run('scripts/pi-common/workflow-dispatch.mjs', ['evil.yml']), /usage: workflow-dispatch\.mjs/);
  assert.deepEqual(gh.mutations(), []);
  ok(gh.run('scripts/pi-common/workflow-dispatch.mjs', ['pi-auto-merge.yml']), 'wake Merge Gate');
  assert.deepEqual(gh.read().dispatches, [{ workflow: 'pi-auto-merge.yml', ref: 'dev', inputs: null }]);
  failed(gh.run('scripts/pi-common/workflow-dispatch.mjs', ['pi-auto-merge.yml'], { env: { GITHUB_TOKEN: '' } }), /repository and token are required/);
  failed(gh.run('scripts/pi-common/workflow-dispatch.mjs', ['pi-auto-merge.yml'], { env: { PI_GITHUB_HTTP_TIMEOUT_MS: 'soon' } }), /PI_GITHUB_HTTP_TIMEOUT_MS/);
  gh.update(state => { state.faults.push({ method: 'POST', path: '^/labels$', status: 403, body: 'Resource not accessible' }); });
  failed(gh.run(SCRIPT.triage, ['prepare', gh.file('c.json', '')]), /Cannot ensure triage:ready label: 403/);
});
