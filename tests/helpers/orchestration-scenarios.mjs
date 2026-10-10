/**
 * Cross-stage orchestration scenarios for the Pi control plane (#727).
 *
 * Each scenario runs the production stage entrypoints as child processes
 * against one stateful fake GitHub (fake-github.mjs) and asserts observable
 * effects: labels, issue/PR state, durable comment markers, dispatched
 * workflows with their inputs, merges, ref cleanup, and the absence of
 * duplicate side effects. Model output is replaced by fixed submit_result
 * transcripts and fixed terminal receipts; no model or network is used.
 *
 * Every scenario takes `{ root }`, the checkout whose scripts run. The test
 * files use the repository; pi-orchestration-mutants.test.mjs replays the
 * same scenario against a copy with one broken production line and requires
 * the scenario to fail.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeImplementerResult } from '../../scripts/pi-common/implementer-result.mjs';
import { createSuccessfulTerminalReceipt, writeTerminalReceiptFile } from '../../scripts/pi-common/terminal-receipt.mjs';
import { appendCheckRecord, FINAL_PIPELINE_COMPLETE_SOURCE } from '../../scripts/pi-common/validation-ledger.mjs';
import { createReviewReceipt, validateReviewResult } from '../../scripts/pi-review-result.mjs';
import {
  LONG_AGO, ciRun, fakeGithub, issue, pullRequest, stageRun, submitResult, taskBody,
} from './fake-github.mjs';

export const SCRIPT = {
  triage: 'scripts/pi-triage.mjs',
  dispatcher: 'scripts/pi-dispatcher.mjs',
  architect: 'scripts/pi-architect.mjs',
  transition: 'scripts/pi-transition.mjs',
  publication: 'scripts/pi-common/issue-publication.mjs',
  guard: 'scripts/pi-common/pr-guard.mjs',
  repair: 'scripts/pi-common/repair-publication.mjs',
  review: 'scripts/pi-common/review-state.mjs',
  reviewResult: 'scripts/pi-review-result.mjs',
  mergeGate: 'scripts/pi-auto-merge.mjs',
  postMerge: 'scripts/pi-post-merge.mjs',
  reconcile: 'scripts/pi-reconcile.mjs',
  control: 'scripts/pi-common/automation-control.mjs',
};

export function ok(result, context = 'stage') {
  assert.equal(result.status, 0, `${context} failed:\n${result.output}`);
  return result;
}

export function failed(result, pattern, context = 'stage') {
  assert.notEqual(result.status, 0, `${context} unexpectedly succeeded:\n${result.output}`);
  if (pattern) assert.match(result.output, pattern);
  return result;
}

const lastJson = result => JSON.parse(result.stdout.trim().split('\n').at(-1));
const dispatchSummary = gh => gh.read().dispatches.map(({ workflow, inputs }) => ({ workflow, inputs }));

// ---------------------------------------------------------------- stage drivers

export function triage(gh, { ready = [], needsHuman = [], skipped = [] } = {}) {
  const context = gh.file('triage-context.json', '');
  ok(gh.run(SCRIPT.triage, ['prepare', context]), 'Triage prepare');
  const transcript = gh.file('triage.jsonl', submitResult('triage-result', {
    ready, needs_human: needsHuman, skipped,
  }));
  return { context: JSON.parse(readFileSync(context, 'utf8')), apply: gh.run(SCRIPT.triage, ['apply', transcript]) };
}

export function dispatcherPrepare(gh) {
  const context = gh.file('dispatcher-context.json', '');
  ok(gh.run(SCRIPT.dispatcher, ['prepare', context]), 'Dispatcher prepare');
  return JSON.parse(readFileSync(context, 'utf8'));
}

export function dispatcherApply(gh, classifications) {
  const transcript = gh.file('dispatcher.jsonl', submitResult('dispatcher-result', { classifications }));
  return gh.run(SCRIPT.dispatcher, ['apply', transcript]);
}

export const transition = (gh, number, action, comment = '', env = {}) =>
  gh.run(SCRIPT.transition, ['issue', action, ...(comment ? [comment] : [])], { env: { ISSUE: String(number), ...env } });

/**
 * The trusted outputs a real Implementer run leaves for publication: a local
 * candidate commit, the structured result, a terminal receipt bound to that
 * candidate and a validation ledger. The pushed issue branch is modelled by
 * pointing the fake ref at the candidate HEAD.
 */
export function implementerCandidate(gh, number, { verified = true, receipt = 'valid' } = {}) {
  const cwd = join(gh.dir, `work-${number}`);
  mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'dev');
  git('config', 'user.name', 'Pi Test');
  git('config', 'user.email', 'pi@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src/app.py'), 'GREETING = "hi"\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const start = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/dev', start);
  writeFileSync(join(cwd, 'src/app.py'), 'GREETING = "hello"\n');
  git('add', '-A');
  git('commit', '-qm', 'candidate');
  const head = git('rev-parse', 'HEAD');

  const resultFile = join(gh.dir, `result-${number}.json`);
  const ledgerFile = join(gh.dir, `ledger-${number}.jsonl`);
  const terminalFile = join(gh.dir, `terminal-${number}.json`);
  writeImplementerResult(resultFile, {
    title: `Implement #${number}`,
    summary: 'Update the configured greeting.',
    changes: ['Update the greeting constant'],
    files: ['src/app.py'],
    security_notes: 'No security impact.',
    limitations: 'None.',
    scope_enforcement: 'predeclared',
    accepted_scope: {
      schema_version: 1,
      accepted: [{ path: 'src/app.py', rationale: 'The issue requires the greeting change.' }],
      temporary: [],
      baseline: [],
    },
  });
  const env = {
    PI_STAGE: 'implementer',
    PI_ISSUE: String(number),
    PI_VALIDATION_RUN_ID: `validation-${number}`,
    PI_IMPLEMENTER_START_COMMIT: start,
    PI_TERMINAL_RESULT_FILE: terminalFile,
  };
  const terminal = createSuccessfulTerminalReceipt({ cwd, resultFile, env });
  writeTerminalReceiptFile(terminalFile, terminal);
  if (receipt === 'truncated') {
    const text = readFileSync(terminalFile, 'utf8');
    writeFileSync(terminalFile, text.slice(0, Math.floor(text.length / 2)));
  }
  writeFileSync(ledgerFile, '');
  if (verified) {
    appendCheckRecord(ledgerFile, {
      kind: 'pytest', scope: { whole_repo: true }, status: 'pass', exit_code: 0, source: 'checks_final',
      stage: 'implementer', backend: 'pi', run_id: env.PI_VALIDATION_RUN_ID,
    });
    appendCheckRecord(ledgerFile, {
      kind: 'checks_final', scope: { whole_repo: true }, status: 'pass', source: FINAL_PIPELINE_COMPLETE_SOURCE,
      stage: 'implementer', backend: 'pi', run_id: env.PI_VALIDATION_RUN_ID,
      candidate_revision: terminal.candidate_revision, summary: 'complete',
    });
  }
  gh.update(state => { state.refs[`heads/pi/issue-${number}`] = head; });
  const publish = () => gh.run(SCRIPT.publication,
    ['pr', String(number), resultFile, 'test', ledgerFile, 'pi', cwd, start], { env });
  return { cwd, head, start, publish };
}

/**
 * A PR Fix workspace: a local bare remote holding the PR branch, and a clone
 * with an uncommitted, validated repair. The fake PR HEAD tracks the remote.
 */
export function repairWorkspace(gh, issueNumber, prNumber) {
  const remote = join(gh.dir, `remote-${prNumber}.git`);
  const cwd = join(gh.dir, `repair-${prNumber}`);
  const headRef = `pi/issue-${issueNumber}`;
  execFileSync('git', ['init', '-q', '--bare', remote]);
  mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', headRef);
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', remote);
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src/app.py'), 'GREETING = "hello"\n');
  git('add', '-A');
  git('-c', 'user.name=Pi Test', '-c', 'user.email=pi@example.invalid', 'commit', '-qm', 'implementation');
  git('push', '-q', 'origin', headRef);
  const head = git('rev-parse', 'HEAD');
  gh.update(state => { state.pulls[prNumber].head.sha = head; });
  writeFileSync(join(cwd, 'src/app.py'), 'GREETING = "hello"\n\n\ndef greet(name):\n    return f"{GREETING}, {name}"\n');
  const remoteHead = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${headRef}`], { encoding: 'utf8' }).trim();
  const publish = expectedHead => gh.run(SCRIPT.repair,
    ['publish', String(prNumber), String(issueNumber), cwd, headRef, expectedHead ?? head]);
  return { cwd, head, headRef, publish, remoteHead };
}

const reviewEnv = (head, runId, attempt = '1') => ({
  REVIEW_RUN_ID: String(runId), REVIEW_RUN_ATTEMPT: String(attempt), REVIEW_MODEL: 'qwen', HEAD_SHA: head,
});

/** Durable run identity a Reviewer writes before any model work. */
export function reviewerStarted(gh, pr, head, runId, attempt = '1') {
  const env = reviewEnv(head, runId, attempt);
  const recorded = lastJson(ok(gh.run(SCRIPT.review, ['record-run', String(pr), head, String(runId)], { env }), 'record-run'));
  const started = lastJson(ok(gh.run(SCRIPT.review, ['start-run', String(pr), head, String(runId)], { env }), 'start-run'));
  return { recorded, started };
}

/** Reviewer publication: apply the verdict to the reviewed HEAD, then hand off. */
export function reviewerVerdict(gh, pr, head, verdict, runId, attempt = '1') {
  const env = reviewEnv(head, runId, attempt);
  const text = gh.file('review.md', `REVIEW_RESULT: ${verdict}\n\nFixture review for ${head}.`);
  const applied = lastJson(ok(gh.run(SCRIPT.review, ['apply', String(pr), head, verdict, text], { env }), 'review apply'));
  const followup = lastJson(ok(gh.run(SCRIPT.review, ['dispatch', String(pr), verdict], { env }), 'review dispatch'));
  return { applied, followup };
}

export const reconcile = (gh, mode, { apply = true } = {}) =>
  gh.run(SCRIPT.reconcile, apply ? ['--apply'] : [], { env: { PI_AUTOMATION_MODE: mode } });

export const recoverReviewRun = (gh, pr, runId, attempt, outcome) => lastJson(ok(gh.run(SCRIPT.review, ['recover-workflow-run'], {
  env: {
    REVIEW_RUN_TITLE: `🔬 Review PR #${pr} · fixture`, REVIEW_RUN_ID: String(runId),
    REVIEW_RUN_ATTEMPT: String(attempt), REVIEW_OUTCOME: outcome, REVIEW_RUN_URL: `https://github.invalid/run/${runId}`,
  },
}), 'recover-workflow-run'));

// ---------------------------------------------------------------- scenarios

/**
 * Triage → Dispatcher → Implementer → PR publication → Reviewer → Merge Gate
 * → post-merge, then a full second pass of every stage that must be a no-op.
 */
export async function happyPath(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(10, { labels: ['triage:ready'] })],
    runs: [ciRun('dev-0', { event: 'push' })],
  }, { root });

  const triaged = triage(gh, { ready: [10] });
  assert.deepEqual(triaged.context.candidates.map(item => item.issue), [10]);
  ok(triaged.apply, 'Triage apply');
  assert.deepEqual(gh.labelsOf(10), ['dispatcher:ready']);

  const context = dispatcherPrepare(gh);
  assert.deepEqual(context.candidates.map(item => item.issue), [10]);
  ok(dispatcherApply(gh, [{ issue: 10, decision: 'IMPLEMENT' }]), 'Dispatcher apply');
  assert.deepEqual(gh.labelsOf(10), ['pi:ready']);
  assert.deepEqual(gh.read().dispatches, [
    { workflow: 'pi-issue-agent.yml', ref: 'dev', inputs: { issue_number: '10', dispatch_mode: 'dispatcher' } },
  ]);

  ok(transition(gh, 10, 'running'), 'claim');
  assert.deepEqual(gh.labelsOf(10), ['pi:running']);
  const candidate = implementerCandidate(gh, 10);
  const published = lastJson(ok(candidate.publish(), 'PR publication'));
  assert.equal(published.verification_state, 'VERIFIED');
  const prNumber = published.number;
  const pr = gh.read().pulls[prNumber];
  assert.equal(pr.head.sha, candidate.head);
  assert.equal(pr.head.ref, 'pi/issue-10');
  assert.match(pr.body, /Closes #10\b/);
  assert.deepEqual(gh.labelsOf(prNumber), [], 'a verified sandboxed candidate is not gated');
  // A retried publication step (e.g. after a later step failed) updates the same PR.
  assert.equal(lastJson(ok(candidate.publish(), 'PR re-publication')).number, prNumber);
  assert.equal(gh.read().requests.filter(request => request.method === 'POST' && request.path === '/pulls').length, 1);
  ok(transition(gh, 10, 'mr-created', 'Opened the implementation PR.'), 'mr-created');
  assert.deepEqual(gh.labelsOf(10), ['pi:mr-created']);
  ok(gh.run(SCRIPT.publication, ['review', String(prNumber)]), 'reviewer dispatch');

  const guardFile = gh.file('guard.json', '');
  ok(gh.run(SCRIPT.guard, [String(prNumber), guardFile]), 'PR guard');
  const guard = JSON.parse(readFileSync(guardFile, 'utf8'));
  assert.equal(guard.skip, false);
  assert.equal(guard.head, candidate.head);
  assert.equal(guard.review.issue.number, 10);

  reviewerStarted(gh, prNumber, candidate.head, 7001);
  const review = reviewerVerdict(gh, prNumber, candidate.head, 'PASS', 7001);
  assert.deepEqual(review.applied, { status: 'applied', verdict: 'PASS' });
  assert.deepEqual(review.followup, { status: 'followup-dispatched', verdict: 'PASS' });
  assert.deepEqual(gh.labelsOf(prNumber), ['review:passed']);

  // Merge Gate without PR CI for the reviewed HEAD waits and changes nothing.
  let before = gh.mark();
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate (CI pending)');
  assert.deepEqual(gh.mutationsSince(before), []);

  gh.update(state => { state.runs.push(ciRun(candidate.head)); });
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate');
  assert.deepEqual(gh.read().merges, [{ pr: prNumber, sha: candidate.head, merge_method: 'squash' }]);
  const mergeSha = gh.read().pulls[prNumber].merge_commit_sha;

  ok(gh.run(SCRIPT.postMerge, [mergeSha]), 'post-merge');
  const done = gh.read().issues[10];
  assert.equal(done.state, 'closed');
  assert.equal(done.state_reason, 'completed');
  assert.deepEqual(gh.labelsOf(10), []);
  assert.equal(gh.read().refs['heads/pi/issue-10'], undefined);

  assert.deepEqual(dispatchSummary(gh), [
    { workflow: 'pi-issue-agent.yml', inputs: { issue_number: '10', dispatch_mode: 'dispatcher' } },
    { workflow: 'pi-pr-review.yml', inputs: { pr_number: String(prNumber) } },
    { workflow: 'pi-auto-merge.yml', inputs: null },
    { workflow: 'ci.yml', inputs: null },
  ]);

  // Re-entry: every stage woken again (duplicate webhook, late timer) is a no-op.
  before = gh.mark();
  ok(triage(gh).apply, 'Triage re-run');
  assert.deepEqual(dispatcherPrepare(gh).candidates, []);
  ok(dispatcherApply(gh, []), 'Dispatcher re-run');
  ok(transition(gh, 10, 'mr-created'), 'late mr-created');
  assert.deepEqual(lastJson(ok(gh.run(SCRIPT.review, ['dispatch', String(prNumber), 'PASS'], { env: reviewEnv(candidate.head, 7001) }))),
    { status: 'followup-already-dispatched', verdict: 'PASS' });
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate re-run');
  ok(gh.run(SCRIPT.postMerge, [mergeSha]), 'post-merge re-run');
  ok(reconcile(gh, 'RUNNING'), 'Reconciler pass');
  assert.deepEqual(gh.mutationsSince(before), [], 'a second pass must not mutate GitHub');
  assert.equal(gh.read().dispatches.length, 4);
}

/** Dispatcher → Architect split → children exposed in dependency order. */
export async function architectSplit(t, { root } = {}) {
  const gh = fakeGithub(t, { issues: [issue(20, { labels: ['dispatcher:ready'], title: 'Large task to split' })] }, { root });
  ok(dispatcherApply(gh, [{ issue: 20, decision: 'ARCHITECT' }]), 'Dispatcher apply');
  assert.deepEqual(gh.labelsOf(20), ['architect:ready']);
  assert.deepEqual(dispatchSummary(gh), [{ workflow: 'pi-architect.yml', inputs: { issue_number: '20' } }]);

  const context = gh.file('architect-context.json', '');
  ok(gh.run(SCRIPT.architect, ['prepare', '20', context]), 'Architect prepare');
  const stepBody = goal => `${goal}\n\n## Acceptance criteria\n- The ${goal.toLowerCase()} is merged behind tests.\n- The change stays independently reviewable.\n- Focused validation covers the new behavior.`;
  const plan = gh.file('architect.jsonl', submitResult('architect-result', {
    parent_issue: 20,
    steps: [
      { key: 'contract', kind: 'contract', priority: 'P1', title: 'Define the greeting contract', body: stepBody('Contract for the greeting handler'), depends_on: [] },
      { key: 'impl', kind: 'implementation', priority: 'P1', title: 'Implement the greeting handler', body: stepBody('Implementation of the greeting handler'), depends_on: ['contract'] },
    ],
  }));
  ok(gh.run(SCRIPT.architect, ['publish', '20', plan, context]), 'Architect publish');

  const state = gh.read();
  const children = Object.values(state.issues).filter(item => item.number !== 20).map(item => item.number).sort((a, b) => a - b);
  assert.equal(children.length, 2);
  assert.deepEqual(gh.labelsOf(20), ['architect:epic']);
  assert.match(state.issues[20].body, new RegExp(`<!-- architect-children:${children.join(',')} -->`));
  for (const child of children) assert.deepEqual(gh.labelsOf(child), ['dispatcher:ready']);
  assert.match(state.issues[children[1]].body, new RegExp(`Depends on: \\[#${children[0]}\\]`));

  const next = dispatcherPrepare(gh);
  assert.deepEqual(next.candidates.map(item => item.issue), [children[0]]);
  assert.deepEqual(next.skipped, [{ issue: children[1], reason: `dependency #${children[0]} is not completed` }]);

  // Interrupted publication: a child created but never labeled is completed by the Reconciler.
  gh.update(current => { current.issues[children[1]].labels = []; });
  ok(reconcile(gh, 'RUNNING'), 'Reconciler');
  assert.deepEqual(gh.labelsOf(children[1]), ['dispatcher:ready']);
  assert.equal(gh.read().dispatches.length, 1, 'split recovery never dispatches directly');
}

/**
 * CHANGES_REQUESTED → PR Fix publishes a new HEAD (lease-guarded push) → the
 * old verdict is invalidated → the Reviewer handoff dispatch fails → the
 * Reconciler restarts Reviewer once → PASS on the new HEAD → merge.
 */
export async function repairLoop(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(30, { labels: ['pi:mr-created'] })],
    pulls: [pullRequest(31, 30)],
    runs: [ciRun('dev-0', { event: 'push' })],
  }, { root });
  const workspace = repairWorkspace(gh, 30, 31);
  const first = workspace.head;

  reviewerStarted(gh, 31, first, 7101);
  assert.equal(reviewerVerdict(gh, 31, first, 'CHANGES_REQUESTED', 7101).applied.status, 'applied');
  assert.deepEqual(gh.labelsOf(31), ['review:changes-requested']);
  assert.deepEqual(dispatchSummary(gh), [{ workflow: 'pi-pr-fix.yml', inputs: { pr_number: '31' } }]);

  // PR Fix refuses to publish over a HEAD it did not start from.
  failed(workspace.publish('0'.repeat(40)), /HEAD moved during repair/);
  assert.equal(workspace.remoteHead(), first);
  const published = lastJson(ok(workspace.publish(), 'PR Fix publish'));
  assert.equal(published.published, true);
  const second = published.head;
  assert.notEqual(second, first);
  assert.equal(workspace.remoteHead(), second);

  // GitHub synchronize: the PR moves to the pushed HEAD and the old verdict is invalidated.
  gh.update(state => { state.pulls[31].head.sha = second; });
  ok(gh.run(SCRIPT.review, ['invalidate', '31', second]), 'review invalidation');
  assert.deepEqual(gh.labelsOf(31), []);

  // The Reviewer handoff dispatch fails; nothing else restarts the Reviewer.
  gh.update(state => { state.faults.push({ method: 'POST', path: '/actions/workflows/pi-pr-review\\.yml/dispatches$', status: 502 }); });
  failed(gh.run(SCRIPT.repair, ['review', '31']), /502/);
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate (unreviewed)');
  assert.deepEqual(gh.read().merges, []);
  ok(reconcile(gh, 'RUNNING'), 'Reconciler inside grace');
  assert.equal(gh.read().dispatches.length, 1);
  gh.update(state => { state.pulls[31].updated_at = LONG_AGO; });
  ok(reconcile(gh, 'RUNNING'), 'Reconciler');
  assert.deepEqual(dispatchSummary(gh).at(-1), { workflow: 'pi-pr-review.yml', inputs: { pr_number: '31' } });
  assert.equal(gh.read().dispatches.length, 2);

  reviewerStarted(gh, 31, second, 7102);
  reviewerVerdict(gh, 31, second, 'PASS', 7102);
  gh.update(state => { state.runs.push(ciRun(second)); });
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate');
  assert.deepEqual(gh.read().merges, [{ pr: 31, sha: second, merge_method: 'squash' }]);
}

/** A verdict, follow-up or merge for an outdated HEAD is never accepted. */
export async function staleHead(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(40, { labels: ['pi:mr-created'] })],
    pulls: [pullRequest(41, 40, { sha: 'h41-b', labels: ['review:passed'] })],
    runs: [ciRun('dev-0', { event: 'push' }), ciRun('h41-a')],
  }, { root });

  // Reviewer finished reviewing h41-a after the PR moved to h41-b.
  const text = gh.file('review.md', 'REVIEW_RESULT: PASS\n\nReviewed an old head.');
  const env = reviewEnv('h41-a', 7201);
  assert.deepEqual(lastJson(ok(gh.run(SCRIPT.review, ['apply', '41', 'h41-a', 'PASS', text], { env }))), { status: 'stale' });
  assert.deepEqual(gh.labelsOf(41), [], 'a stale verdict also clears the verdict it would have replaced');
  assert.deepEqual(lastJson(ok(gh.run(SCRIPT.review, ['dispatch', '41', 'PASS'], { env }))), { status: 'stale' });
  assert.deepEqual(gh.read().dispatches, []);

  // Green CI exists only for the old HEAD: Merge Gate must keep waiting.
  gh.update(state => { state.pulls[41].labels = [{ name: 'review:passed' }]; });
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate (stale CI)');
  assert.deepEqual(gh.read().merges, []);

  // HEAD changes between Merge Gate's first read and its pre-merge re-read.
  gh.update(state => {
    state.pulls[41].head.sha = 'h41-a';
    state.interleave.push({ method: 'GET', path: '^/pulls/41$', skip: 1, patch: { pulls: { 41: { head: { sha: 'h41-c' } } } } });
  });
  const raced = ok(gh.run(SCRIPT.mergeGate), 'Merge Gate (raced)');
  assert.match(raced.output, /PR changed before merge/);
  assert.deepEqual(gh.read().merges, []);
}

/** RUNNING / DRAINING / PAUSED keep their documented dispatch and recovery policies. */
export async function automationModes(t, { root } = {}) {
  const seed = () => ({
    issues: [
      issue(50, { labels: ['pi:running'] }),
      issue(51, { labels: ['architect:ready'] }),
      issue(52, { labels: ['pi:mr-created'] }),
      issue(54, { labels: ['pi:mr-created'] }),
      issue(56, { labels: ['pi:ready'] }),
    ],
    pulls: [pullRequest(53, 52, { sha: 'h53' }), pullRequest(55, 54, { sha: 'h55', labels: ['review:passed'] })],
    refs: { 'heads/dev': 'dev-0', 'heads/pi/issue-50-checkpoint': 'cp50' },
  });
  const expected = {
    RUNNING: { issue: ['dispatcher:ready'], dispatches: [
      { workflow: 'pi-pr-review.yml', inputs: { pr_number: '53' } }, { workflow: 'pi-auto-merge.yml', inputs: null },
    ] },
    DRAINING: { issue: [], dispatches: [
      { workflow: 'pi-pr-review.yml', inputs: { pr_number: '53' } }, { workflow: 'pi-auto-merge.yml', inputs: null },
    ] },
    PAUSED: { issue: [], dispatches: [] },
  };
  for (const [mode, want] of Object.entries(expected)) {
    const gh = fakeGithub(t, seed(), { root });
    const audit = gh.mark();
    ok(reconcile(gh, mode, { apply: false }), `${mode} audit`);
    assert.deepEqual(gh.mutationsSince(audit), [], `${mode} audit mode is read-only`);
    ok(reconcile(gh, mode), `${mode} reconcile`);
    assert.deepEqual(gh.labelsOf(50), want.issue, `${mode}: orphaned Implementer`);
    assert.deepEqual(gh.labelsOf(51), want.issue, `${mode}: orphaned Architect`);
    assert.deepEqual(gh.labelsOf(56), want.issue, `${mode}: stranded pi:ready whose Implementer never started`);
    assert.deepEqual(gh.labelsOf(52), ['pi:mr-created'], `${mode}: PR ownership is durable`);
    assert.deepEqual(dispatchSummary(gh), want.dispatches, `${mode}: dispatches`);
    assert.equal(gh.read().refs['heads/pi/issue-50-checkpoint'], 'cp50', `${mode}: checkpoint is the only saved work`);
  }

  const gh = fakeGithub(t, { variables: { PI_AUTOMATION_MODE: 'PAUSED' } }, { root });
  ok(gh.run(SCRIPT.control, ['set', 'DRAINING']), 'set DRAINING');
  assert.equal(gh.read().variables.PI_AUTOMATION_MODE, 'DRAINING');
  ok(gh.run(SCRIPT.control, ['resume']), 'resume');
  assert.deepEqual(dispatchSummary(gh), [{ workflow: 'pi-dispatcher.yml', inputs: null }]);
  gh.update(state => {
    state.interleave.push({ method: 'GET', path: '^/actions/variables/', patch: { variables: { PI_AUTOMATION_MODE: 'PAUSED' } } });
  });
  failed(gh.run(SCRIPT.control, ['set', 'RUNNING']), /verification failed: expected RUNNING, got PAUSED/);
}

/**
 * #698 regression fixture: an N150 reboot kills an independent Reviewer after
 * it recorded its run and started, and kills an Implementer that saved a
 * checkpoint. Recovery must be bounded, idempotent and escalate on repeat.
 */
export async function rebootOrphanedReviewer(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(60, { labels: ['pi:mr-created'] }), issue(62, { labels: ['pi:running'] })],
    pulls: [pullRequest(61, 60, { sha: 'h61' })],
    refs: { 'heads/dev': 'dev-0', 'heads/pi/issue-62-checkpoint': 'cp62' },
  }, { root });
  reviewerStarted(gh, 61, 'h61', 777);
  // The reboot: no run is live any more. A fresh PR is still inside the grace period.
  gh.update(state => { state.pulls[61].updated_at = new Date().toISOString(); });
  ok(reconcile(gh, 'RUNNING'), 'Reconciler inside grace');
  assert.deepEqual(gh.read().dispatches, [], 'no recovery inside the grace period');
  assert.deepEqual(gh.labelsOf(62), ['dispatcher:ready'], 'orphaned Implementer returns to Dispatcher');
  assert.equal(gh.read().refs['heads/pi/issue-62-checkpoint'], 'cp62', 'checkpoint survives');

  // The cancelled workflow_run arrives (twice: duplicate delivery).
  assert.deepEqual(recoverReviewRun(gh, 61, 777, 1, 'cancelled'), { status: 'retry-dispatched' });
  assert.deepEqual(recoverReviewRun(gh, 61, 777, 1, 'cancelled'), { status: 'retry-already-requested' });
  assert.deepEqual(dispatchSummary(gh), [{ workflow: 'pi-pr-review.yml', inputs: { pr_number: '61', model: 'qwen' } }]);
  assert.deepEqual(gh.labelsOf(61), []);

  // The retry is interrupted too: bounded retry escalates to a human.
  reviewerStarted(gh, 61, 'h61', 778);
  assert.deepEqual(recoverReviewRun(gh, 61, 778, 1, 'cancelled'), { status: 'needs-human', reason: 'retry-exhausted' });
  assert.deepEqual(gh.labelsOf(61), ['pi:needs-human']);
  gh.update(state => { state.pulls[61].updated_at = LONG_AGO; });
  ok(reconcile(gh, 'RUNNING'), 'Reconciler after escalation');
  assert.equal(gh.read().dispatches.length, 1, 'human-owned PR is not restarted');
  assert.equal(gh.read().merges.length, 0);
}

/** The workflow_run signal is lost entirely: only the Reconciler can restart the Reviewer. */
export async function lostReviewWake(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(70, { labels: ['pi:mr-created'] })],
    pulls: [pullRequest(71, 70, { sha: 'h71' })],
    runs: [stageRun('🔬 Review PR #71 · qwen')],
  }, { root });
  ok(reconcile(gh, 'RUNNING'), 'Reconciler with live Reviewer');
  assert.deepEqual(gh.read().dispatches, [], 'a live Reviewer is never duplicated');

  gh.update(state => { state.runs = []; });
  ok(reconcile(gh, 'RUNNING'), 'Reconciler after lost wake');
  assert.deepEqual(dispatchSummary(gh), [{ workflow: 'pi-pr-review.yml', inputs: { pr_number: '71' } }]);
}

// ---------------------------------------------------------------- fault injection

/** GitHub 429 on the Implementer dispatch rolls ownership back; a retry dispatches once. */
export async function dispatchRateLimited(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(80, { labels: ['dispatcher:ready'] })],
    faults: [{ method: 'POST', path: '/actions/workflows/pi-issue-agent\\.yml/dispatches$', status: 429, body: 'API rate limit exceeded' }],
  }, { root });
  failed(dispatcherApply(gh, [{ issue: 80, decision: 'IMPLEMENT' }]), /429 .*rate limit/);
  assert.deepEqual(gh.labelsOf(80), ['dispatcher:ready'], 'ownership returns to the serialized Dispatcher');
  assert.deepEqual(gh.read().dispatches, []);
  ok(dispatcherApply(gh, [{ issue: 80, decision: 'IMPLEMENT' }]), 'Dispatcher retry');
  assert.deepEqual(gh.labelsOf(80), ['pi:ready']);
  assert.equal(gh.read().dispatches.length, 1);
}

/** Another actor takes ownership between Dispatcher's read and its write. */
export async function concurrentOwnership(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(81, { labels: ['dispatcher:ready'] })],
    interleave: [{ method: 'GET', path: '^/issues/81$', skip: 1, patch: { issues: { 81: { labels: [{ name: 'pi:needs-human' }] } } } }],
  }, { root });
  failed(dispatcherApply(gh, [{ issue: 81, decision: 'IMPLEMENT' }]), /concurrent pipeline transition on #81/);
  assert.deepEqual(gh.labelsOf(81), ['pi:needs-human'], 'the newer owner is not overwritten');
  assert.deepEqual(gh.read().dispatches, []);
}

/** 5xx on a Triage label write fails the run without a partial comment; a retry succeeds. */
export async function triageServerError(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(82, { labels: ['triage:ready'] }), issue(83, { labels: ['triage:ready'], body: 'Too vague.' })],
    faults: [{ method: 'PATCH', path: '^/issues/82$', status: 502, body: 'Bad Gateway' }],
  }, { root });
  const first = triage(gh, { ready: [82], needsHuman: [{ issue: 83, comment: 'Add task metadata and acceptance criteria.' }] });
  failed(first.apply, /502/);
  assert.deepEqual(gh.labelsOf(82), ['triage:ready']);
  assert.deepEqual(gh.read().comments, [], 'no human-facing comment for an unfinished batch');
  ok(triage(gh, { ready: [82], needsHuman: [{ issue: 83, comment: 'Add task metadata and acceptance criteria.' }] }).apply, 'Triage retry');
  assert.deepEqual(gh.labelsOf(82), ['dispatcher:ready']);
  assert.deepEqual(gh.labelsOf(83), ['pi:needs-human']);
  assert.equal(gh.read().comments.length, 1);
  assert.match(gh.read().comments[0].body, /<!-- pi-triage:hash:[0-9a-f]{16} -->/);
}

/** A GitHub API timeout and a transport error abort Merge Gate before any merge. */
export async function mergeGateTransportFaults(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(84, { labels: ['pi:mr-created'] })],
    pulls: [pullRequest(85, 84, { sha: 'h85', labels: ['review:passed'] })],
    runs: [ciRun('dev-0', { event: 'push' }), ciRun('h85')],
    faults: [
      { method: 'GET', path: '^/pulls/85$', kind: 'timeout' },
      { method: 'PUT', path: '^/pulls/85/merge$', kind: 'network' },
    ],
  }, { root });
  failed(gh.run(SCRIPT.mergeGate, [], { env: { PI_GITHUB_HTTP_TIMEOUT_MS: '200' } }), /timed out after 200ms/);
  failed(gh.run(SCRIPT.mergeGate), /fetch failed/);
  assert.deepEqual(gh.read().merges, []);
  assert.deepEqual(gh.read().dispatches, [], 'no dev CI wake for a merge that did not happen');
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate after recovery');
  assert.deepEqual(gh.read().merges, [{ pr: 85, sha: 'h85', merge_method: 'squash' }]);
}

/** Product CI failure + failed PR Fix dispatch: ownership is durable and the Reconciler recovers once. */
export async function repairDispatchLost(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(86, { labels: ['pi:mr-created'] })],
    pulls: [pullRequest(87, 86, { sha: 'h87', labels: ['review:passed'] })],
    runs: [ciRun('dev-0', { event: 'push' }), ciRun('h87', {
      conclusion: 'failure', jobs: [{ name: 'test', conclusion: 'failure', steps: [{ name: 'Pytest', conclusion: 'failure' }] }],
    })],
    faults: [{ method: 'POST', path: '/actions/workflows/pi-pr-fix\\.yml/dispatches$', status: 503 }],
  }, { root });
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate');
  assert.deepEqual(gh.labelsOf(87), ['review:changes-requested']);
  assert.match(gh.read().comments.at(-1).body, /PR Fix dispatch failed and Reconciler owns recovery/);
  assert.deepEqual(gh.read().dispatches, []);

  ok(reconcile(gh, 'RUNNING'), 'Reconciler inside grace');
  assert.deepEqual(gh.read().dispatches, []);
  gh.update(state => { state.pulls[87].updated_at = LONG_AGO; });
  ok(reconcile(gh, 'RUNNING'), 'Reconciler');
  assert.deepEqual(dispatchSummary(gh), [{ workflow: 'pi-pr-fix.yml', inputs: { pr_number: '87' } }]);
  gh.update(state => { state.runs.push(stageRun('🔧 Fix PR #87')); });
  ok(reconcile(gh, 'RUNNING'), 'Reconciler with live PR Fix');
  assert.equal(gh.read().dispatches.length, 1, 'a live PR Fix is never duplicated');
  assert.deepEqual(gh.read().merges, []);
}

/** Cancelled CI is infrastructure: one bounded retry, idempotent wakes, then a human. */
export async function cancelledCi(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(88, { labels: ['pi:mr-created'] })],
    pulls: [pullRequest(89, 88, { sha: 'h89', labels: ['review:passed'] })],
    runs: [ciRun('dev-0', { event: 'push' }), ciRun('h89', { id: 6089, conclusion: 'cancelled' })],
  }, { root });
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate');
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate duplicate wake');
  assert.deepEqual(gh.read().reruns, [{ run: 6089, action: 'rerun' }]);
  gh.update(state => { state.runs.find(run => run.id === 6089).run_attempt = 2; });
  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate after failed retry');
  assert.deepEqual(gh.labelsOf(89), ['pi:needs-human', 'review:passed']);
  assert.equal(gh.read().reruns.length, 1);
  assert.deepEqual(gh.read().dispatches, [], 'infrastructure failure never dispatches PR Fix');
  assert.deepEqual(gh.read().merges, []);
}

/** Model output that is missing, truncated or invalid changes nothing at any stage boundary. */
export async function invalidProviderOutput(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [
      issue(90, { labels: ['dispatcher:ready'] }),
      issue(91, { labels: ['triage:ready'] }),
      issue(92, { labels: ['architect:ready'] }),
    ],
  }, { root });
  const truncated = gh.file('truncated.jsonl', '{"type":"message_update","delta":"I will now call submit_res');
  failed(gh.run(SCRIPT.dispatcher, ['apply', truncated]), /expected submit_result tool output/);
  failed(dispatcherApply(gh, [{ issue: 90, decision: 'MAYBE' }]), /invalid dispatcher classifications/);
  failed(dispatcherApply(gh, [{ issue: 90, decision: 'IMPLEMENT' }, { issue: 90, decision: 'ARCHITECT' }]), /duplicate issue/);
  failed(triage(gh, { ready: [91], skipped: [{ issue: 91, reason: 'twice' }] }).apply, /duplicate issue classification/);
  failed(gh.run(SCRIPT.triage, ['apply', truncated]), /expected submit_result tool output/);

  const context = gh.file('architect-context.json', '');
  ok(gh.run(SCRIPT.architect, ['prepare', '92', context]), 'Architect prepare');
  const foreign = gh.file('architect.jsonl', submitResult('architect-result', { parent_issue: 999, action: 'keep', reason: 'A plan produced for another issue entirely.' }));
  failed(gh.run(SCRIPT.architect, ['publish', '92', foreign, context]), /Plan targets another issue/);
  assert.deepEqual(gh.mutations().filter(request => request.path !== '/labels'), []);
  assert.deepEqual(gh.read().dispatches, []);
}

/** Terminal receipts gate publication: a truncated or foreign receipt publishes nothing. */
export async function terminalReceipts(t, { root } = {}) {
  const gh = fakeGithub(t, { issues: [issue(93, { labels: ['pi:running'] })] }, { root });
  const candidate = implementerCandidate(gh, 93, { receipt: 'truncated' });
  failed(candidate.publish(), /terminal|receipt/i);
  assert.deepEqual(gh.read().pulls, {}, 'no PR without a valid terminal receipt');

  const result = { verdict: 'CHANGES_REQUESTED', text: '## Blocking findings\nsrc/app.py:1 fails because the greeting is missing.' };
  const transcript = gh.file('review.jsonl', submitResult('review-result', result));
  const reviewContext = gh.file('review-context.json', JSON.stringify({ pr: 94, issue: 93, head: 'h94', review: { issue: { body: taskBody() } } }));
  const env = { GITHUB_RUN_ID: '9', REVIEW_RUN_ATTEMPT: '1', ISSUE: '93', PR: '94', HEAD_SHA: 'h94', REVIEW_CONTEXT: reviewContext };
  const missing = gh.run(SCRIPT.reviewResult, [transcript], { env });
  assert.equal(missing.status, 4);
  assert.match(missing.stderr, /review_terminal_receipt_missing/);

  const receiptFor = head => gh.file('review-receipt.json', JSON.stringify(createReviewReceipt(validateReviewResult(result), {
    session: 's1', head, run: '9', attempt: '1', issue: '93', pr: '94',
  })));
  const foreign = gh.run(SCRIPT.reviewResult, [transcript], { env: { ...env, PI_TERMINAL_RESULT_FILE: receiptFor('h94-old') } });
  assert.equal(foreign.status, 4);
  assert.match(foreign.stderr, /review_terminal_receipt_foreign_identity/);
  const accepted = ok(gh.run(SCRIPT.reviewResult, [transcript], { env: { ...env, PI_TERMINAL_RESULT_FILE: receiptFor('h94') } }), 'review result');
  assert.equal(JSON.parse(accepted.stdout).verdict, 'CHANGES_REQUESTED');
}

/** Non-happy terminal states: needs-human, blocked, draft, unverified and control-plane PRs. */
export async function gatedStates(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [
      issue(100, { labels: ['dispatcher:ready', 'pi:blocked'] }),
      issue(101, { labels: ['pi:running', 'pi:blocked'] }),
      issue(102, { labels: ['pi:mr-created'] }),
      issue(104, { labels: ['pi:mr-created'] }),
      issue(106, { labels: ['pi:running'] }),
    ],
    pulls: [
      pullRequest(103, 102, { sha: 'h103', draft: true, labels: ['review:passed'] }),
      pullRequest(105, 104, { sha: 'h105', labels: ['review:passed'], files: [{ filename: '.github/workflows/ci.yml', status: 'modified' }] }),
    ],
    runs: [ciRun('dev-0', { event: 'push' }), ciRun('h103'), ciRun('h105')],
  }, { root });

  const context = dispatcherPrepare(gh);
  assert.deepEqual(context.candidates, []);
  assert.match(context.skipped.find(item => item.issue === 100).reason, /non-dispatchable|inconsistent/);

  ok(transition(gh, 101, 'mr-created', 'Should stay silent while blocked.'), 'blocked transition');
  assert.deepEqual(gh.labelsOf(101), ['pi:blocked']);
  assert.deepEqual(gh.read().comments, []);

  ok(gh.run(SCRIPT.mergeGate), 'Merge Gate');
  assert.deepEqual(gh.read().merges, [], 'neither a draft nor a control-plane PR merges');
  assert.deepEqual(gh.labelsOf(105), ['pi:needs-human']);
  const guardFile = gh.file('guard.json', '');
  ok(gh.run(SCRIPT.guard, ['105', guardFile]), 'PR guard');
  assert.equal(JSON.parse(readFileSync(guardFile, 'utf8')).reason, 'needs-human');

  // Unverified validation: publication gates the PR to a human; nothing downstream proceeds.
  const candidate = implementerCandidate(gh, 106, { verified: false });
  const published = lastJson(ok(candidate.publish(), 'PR publication'));
  assert.notEqual(published.verification_state, 'VERIFIED');
  assert.deepEqual(gh.labelsOf(published.number), ['pi:needs-human']);
  ok(gh.run(SCRIPT.guard, [String(published.number), guardFile]), 'PR guard');
  assert.equal(JSON.parse(readFileSync(guardFile, 'utf8')).skip, true);
  // Publication is idempotent: re-running it updates the same PR.
  assert.equal(lastJson(ok(candidate.publish(), 'PR re-publication')).number, published.number);
  assert.equal(gh.read().requests.filter(request => request.method === 'POST' && request.path === '/pulls').length, 1);
}

/** A late failure signal after the PR merged completes the issue instead of escalating it. */
export async function delayedCompletion(t, { root } = {}) {
  const gh = fakeGithub(t, {
    issues: [issue(110, { labels: ['pi:mr-created'] }), issue(112, { labels: ['pi:mr-created'] })],
    pulls: [pullRequest(111, 110, { sha: 'h111', state: 'closed', merged: true, merged_at: LONG_AGO, merge_commit_sha: 'm111' })],
  }, { root });
  const output = join(gh.dir, 'github-output');
  writeFileSync(output, '');
  ok(transition(gh, 110, 'needs-human', 'Late failure.', { GITHUB_OUTPUT: output }), 'late needs-human');
  assert.equal(gh.read().issues[110].state, 'closed');
  assert.equal(gh.read().issues[110].state_reason, 'completed');
  assert.match(readFileSync(output, 'utf8'), /terminal=true/);
  assert.deepEqual(gh.read().comments, []);
  failed(transition(gh, 112, 'needs-human'), /needs-human cannot replace pi:mr-created/);
  assert.deepEqual(gh.labelsOf(112), ['pi:mr-created']);
}
