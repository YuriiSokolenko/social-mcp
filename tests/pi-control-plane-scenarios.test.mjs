import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectIssueState, safeRemovals } from '../scripts/pi-state-machine.mjs';
import { checkpointGcDecision, recoveryForIssue } from '../scripts/pi-recovery-policy.mjs';

const labels = (...names) => names.map(name => ({ name }));

test('dead implementer with checkpoint is released without losing saved work', () => {
  const issue = { state: 'open', labels: labels('pi:running') };
  const findings = inspectIssueState(issue, { hasLiveImplementer: false, hasCheckpoint: true });
  assert.deepEqual(safeRemovals(findings), ['pi:running']);
  assert.equal(recoveryForIssue(issue, { hasCheckpoint: true }).add, 'pi:ready');
  assert.equal(checkpointGcDecision(issue).remove, false);
});

test('published PR wins over restarting a dead implementer', () => {
  const issue = { state: 'open', labels: labels('pi:running') };
  const recovery = recoveryForIssue(issue, { hasOpenPiPr: true, hasCheckpoint: true });
  assert.equal(recovery.add, 'pi:mr-created');
  assert.equal(recovery.dispatch, null);
});

test('completed issue makes checkpoint garbage collectable', () => {
  assert.equal(checkpointGcDecision({ state: 'closed', state_reason: 'completed', labels: [] }).remove, true);
});

test('RUNNING control wakes dispatcher and reconciler', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-automation-control.yml', 'utf8');
  assert.match(workflow, /pi-dispatcher\.yml\/dispatches/);
  assert.match(workflow, /pi-reconcile\.yml\/dispatches/);
});

test('agent concurrency never cancels active work', () => {
  for (const path of ['.github/workflows/pi-issue-agent.yml', '.github/workflows/pi-pr-review.yml', '.github/workflows/pi-pr-fix.yml']) {
    assert.match(fs.readFileSync(path, 'utf8'), /cancel-in-progress: false/);
  }
});

test('implementer checkpoint uses compare-and-swap lease and exact deletion', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.match(workflow, /PI_CHECKPOINT_EXPECTED/);
  assert.match(workflow, /--force-with-lease="refs\/heads\/pi\/issue-\$\{ISSUE\}-checkpoint:\$\{PI_CHECKPOINT_EXPECTED\}"/);
  assert.match(workflow, /PI_CHECKPOINT_PUBLISHED/);
  assert.match(workflow, /--force-with-lease="refs\/heads\/pi\/issue-\$\{ISSUE\}-checkpoint:\$\{PI_CHECKPOINT_PUBLISHED\}"/);
});

test('published PR state is durable before merge-gate wake', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.ok(workflow.indexOf('- name: Mark pull request created') < workflow.indexOf('- name: Wake merge gate'));
  assert.match(workflow, /Merge Gate wake failed/);
  assert.match(workflow, /if: failure\(\) && steps\.pr\.outputs\.number == ''/);
});







test('issue state family is intentionally small', () => {
  const source = fs.readFileSync('scripts/pi-state-machine.mjs', 'utf8');
  for (const label of ['dispatcher:ready', 'pi:ready', 'pi:running', 'pi:mr-created', 'pi:needs-human', 'architect:ready']) {
    assert.match(source, new RegExp(label.replace(':', '\\:')));
  }
  assert.doesNotMatch(source, /pi:failed|pi:cancelled/);
});





test('architect and reconciler contain no removed terminal-state machinery', () => {
  const architect = fs.readFileSync('scripts/pi-architect.mjs', 'utf8');
  const reconcile = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.doesNotMatch(architect, /pi:failed|pi:blocked|pi:cancelled/);
  assert.doesNotMatch(reconcile, /repairCheckpointRefs|liveRepairs|repair-pr-/);
});











test('reconciler coalesces merge-gate wake when a gate run is already live', () => {
  const reconcile = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /gateAlreadyLive/);
  assert.match(reconcile, /pi-auto-merge\.yml/);
  assert.match(reconcile, /skipping duplicate reconciler wake/);
});


test('implementer preserves PR ownership when a post-publication step fails or is cancelled', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.match(workflow, /Recover publication state after failure[\s\S]*failure\(\).*steps\.pr\.outputs\.number != ''[\s\S]*issue mr-created/);
  assert.match(workflow, /Recover publication state after cancellation[\s\S]*cancelled\(\).*steps\.pr\.outputs\.number != ''[\s\S]*issue mr-created/);
});


test('serialized control workflows preserve pending bursts instead of replacing them', () => {
  for (const file of ['pi-auto-merge.yml', 'pi-dispatcher.yml', 'pi-triage.yml', 'pi-reconcile.yml', 'pi-architect.yml', 'pi-issue-agent.yml', 'pi-pr-review.yml', 'pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${file}`, 'utf8');
    assert.match(workflow, /concurrency:[\s\S]*?queue: max[\s\S]*?cancel-in-progress: false/);
  }
});


test('orphaned architect ownership is infrastructure recovery, not human escalation', () => {
  const reconcile = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /orphaned-architect-state[\s\S]*dispatcher:ready[\s\S]*pi-dispatcher\.yml/);
  assert.doesNotMatch(reconcile, /orphaned-architect-state[\s\S]{0,180}pi:needs-human/);
});


test('implementer structured result requires at least one concrete change', () => {
  const tool = fs.readFileSync('scripts/pi-implementer-result-tool.mjs', 'utf8');
  assert.match(tool, /at least one concrete change is required/);
});


test('reconciler never redispatches a ready implementer when its PR already exists', () => {
  const reconcile = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /retryReadyImplementer[\s\S]*!openPiPrIssues\.has\(issue\.number\)/);
});


test('merge gate owns only eligibility and merge; dev CI owns validation', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /merge_method: 'squash'/);
  assert.doesNotMatch(gate, /pi-pr-review|pi-pr-fix|social-mcp\/integration|social-mcp\/pi-review|statuses/);
});

test('manual review and repair contain no captured dev-base state', () => {
  for (const file of ['pi-pr-review.yml', 'pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${file}`, 'utf8');
    assert.doesNotMatch(workflow, /integration_base_sha|repair_base_sha|BASE_SHA|social-mcp\/integration/);
  }
});


test('reconciler restarts stranded ready work without another dispatcher round trip', () => {
  const reconcile = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /retryReadyImplementer[\s\S]*pi-issue-agent\.yml/);
  assert.doesNotMatch(reconcile, /retryReadyImplementer[\s\S]{0,500}pi-dispatcher\.yml/);
});
