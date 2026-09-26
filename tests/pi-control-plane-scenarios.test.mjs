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

test('merge gate owns exact-pair integration, review, repair, and merge scheduling', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /social-mcp\/integration\//);
  assert.match(gate, /pi-pr-review\.yml\/dispatches/);
  assert.match(gate, /pi-pr-fix\.yml\/dispatches/);
  assert.match(gate, /\/pulls\/\$\{pr\.number\}\/merge/);
});

test('review state is SHA/base-bound commit status, not review labels', () => {
  const transition = fs.readFileSync('scripts/pi-transition.mjs', 'utf8');
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(transition, /social-mcp\/pi-review\/\$\{baseSha\.slice\(0, 12\)\}/);
  assert.match(review, /social-mcp\/pi-review\/\$\{BASE_SHA:0:12\}/);
  assert.doesNotMatch(review, /review:(?:ready|running|passed|changes-requested|failed)/);
});

test('repair keeps PR ownership and records terminal outcome in pair-bound statuses', () => {
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(repair, /Mark no-change review repair terminal/);
  assert.doesNotMatch(repair, /pi-transition\.mjs" issue needs-human/);
  assert.match(repair, /steps\.changes\.outputs\.changed == 'false'/);
  assert.match(repair, /social-mcp\/repair-\$\{REASON\}/);
  assert.match(repair, /pi-auto-merge\.yml\/dispatches/);
});

test('issue state family is intentionally small', () => {
  const source = fs.readFileSync('scripts/pi-state-machine.mjs', 'utf8');
  for (const label of ['dispatcher:ready', 'pi:ready', 'pi:running', 'pi:mr-created', 'pi:needs-human', 'architect:ready']) {
    assert.match(source, new RegExp(label.replace(':', '\\:')));
  }
  assert.doesNotMatch(source, /pi:failed|pi:cancelled/);
});


test('non-review repair failures cannot overwrite review status', () => {
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(repair, /name: Report review repair failure[\s\S]*env\.REASON == 'review'/);
  assert.match(repair, /social-mcp\/repair-\$\{REASON\}/);
});
