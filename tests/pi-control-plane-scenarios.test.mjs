import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectIssueState, inspectPrState, safeRemovals } from '../scripts/pi-state-machine.mjs';
import { recoveryForIssue, recoveryForPr, checkpointGcDecision } from '../scripts/pi-recovery-policy.mjs';

const labels = (...names) => names.map(name => ({ name }));
test('control plane: dead implementer with checkpoint is released and resumed', () => {
  const issue = { state:'open', labels:labels('pi:running') };
  const findings = inspectIssueState(issue, { hasLiveImplementer:false, hasCheckpoint:true });
  assert.deepEqual(safeRemovals(findings), ['pi:running']);
  assert.equal(recoveryForIssue(issue, { hasCheckpoint:true }).add, 'pi:ready');
  assert.equal(checkpointGcDecision(issue).remove, false);
});

test('control plane: published PR wins over restarting a dead implementer', () => {
  const issue = { state:'open', labels:labels('pi:running') };
  const recovery = recoveryForIssue(issue, { hasOpenPiPr:true, hasCheckpoint:true });
  assert.equal(recovery.add, 'pi:mr-created');
  assert.equal(recovery.dispatch, null);
});

test('control plane: dead reviewer is released and review is restarted', () => {
  const pr = { state:'open', labels:labels('review:running') };
  assert.deepEqual(safeRemovals(inspectPrState(pr, { hasLiveReviewer:false })), ['review:running']);
  assert.equal(recoveryForPr(pr).add, 'review:ready');
});

test('control plane: completed issue makes checkpoint garbage collectable', () => {
  assert.equal(checkpointGcDecision({ state:'closed', state_reason:'completed', labels:[] }).remove, true);
});


test('reconciler defers recovery dispatch outside RUNNING mode', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /automationMode === 'RUNNING'/);
  assert.match(source, /recoveryDispatchAllowed/);
  assert.match(source, /recovery\.dispatch === 'implementer' && recoveryDispatchAllowed/);
  assert.match(source, /recovery\.dispatch === 'reviewer' && recoveryDispatchAllowed/);
  assert.match(source, /apply && recoveryDispatchAllowed/);
  assert.match(source, /repair recovery deferred until RUNNING/);
  const workflow = fs.readFileSync('.github/workflows/pi-reconcile.yml', 'utf8');
  assert.match(workflow, /PI_AUTOMATION_MODE:/);
});


test('RUNNING control wakes both dispatcher and reconciler', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-automation-control.yml', 'utf8');
  assert.match(workflow, /pi-dispatcher\.yml\/dispatches/);
  assert.match(workflow, /pi-reconcile\.yml\/dispatches/);
});


test('reconciler keeps recovery retryable when workflow dispatch fails', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /async function tryDispatchWorkflow/);
  assert.match(source, /pi:ready retained for retry/);
  assert.match(source, /resume ready review through merge-gate scheduler/);
  assert.match(source, /Recovery dispatch failed/);
});


test('reconciler retries stranded ready implementation and review states', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /retryReadyImplementer/);
  assert.match(source, /return stranded ready issue to serialized dispatcher/);
  assert.match(source, /tryDispatchWorkflow\('pi-dispatcher\.yml'/);
  assert.match(source, /retryReadyReviewer/);
  assert.match(source, /resume ready review through merge-gate scheduler/);
});


test('reconciler recognizes live agents by custom run title', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /const implement = \/\^🤖 Implement #/);
  assert.match(source, /const review = \/\^🔬 Review PR #/);
  assert.match(source, /const repair = \/\^🔧 Repair PR #/);
  assert.doesNotMatch(source, /run\.name === 'Pi Issue Agent'/);
  assert.doesNotMatch(source, /run\.name === 'Pi PR Review'/);
  assert.doesNotMatch(source, /run\.name === 'Pi PR Fix'/);
});


test('agent concurrency preserves active work and duplicate runs have idempotency guards', () => {
  for (const path of ['.github/workflows/pi-issue-agent.yml', '.github/workflows/pi-pr-review.yml', '.github/workflows/pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(path, 'utf8');
    assert.match(workflow, /cancel-in-progress: false/);
  }
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(review, /social-mcp\/pi-review/);
  assert.match(review, /already has final state/);
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(repair, /review:changes-requested/);
  assert.match(repair, /duplicate dispatch exits without model work/);
});


test('long-running checkpoints use explicit compare-and-swap leases', () => {
  const implementer = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.match(implementer, /PI_CHECKPOINT_EXPECTED/);
  assert.match(implementer, /--force-with-lease="refs\/heads\/pi\/issue-\$\{ISSUE\}-checkpoint:\$\{PI_CHECKPOINT_EXPECTED\}"/);
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(repair, /REPAIR_CHECKPOINT_EXPECTED/);
  assert.match(repair, /--force-with-lease="\$\{CHECKPOINT_REF\}:\$\{REPAIR_CHECKPOINT_EXPECTED\}"/);
});


test('published checkpoints update their leases and deletion requires exact published SHA', () => {
  const issue = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(issue, /PI_CHECKPOINT_EXPECTED=\$\{CHECKPOINT_COMMIT\}/);
  assert.match(issue, /PI_CHECKPOINT_EXPECTED=\$\{INTEGRATION_COMMIT\}/);
  assert.match(issue, /PI_CHECKPOINT_PUBLISHED/);
  assert.match(issue, /--force-with-lease="refs\/heads\/pi\/issue-\$\{ISSUE\}-checkpoint:\$\{PI_CHECKPOINT_PUBLISHED\}"/);
  assert.match(repair, /REPAIR_CHECKPOINT_PUBLISHED=\$\{CHECKPOINT_COMMIT\}/);
  assert.match(repair, /--force-with-lease="refs\/heads\/pi\/repair-pr-\$\{PR\}-checkpoint:\$\{REPAIR_CHECKPOINT_PUBLISHED:-\$REPAIR_CHECKPOINT_EXPECTED\}"/);
});


test('published PR state is committed before merge-gate wake and survives wake failure', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.ok(workflow.indexOf('- name: Mark pull request created') < workflow.indexOf('- name: Wake merge gate'));
  assert.match(workflow, /if: failure\(\) && steps\.pr\.outputs\.number == ''/);
  assert.match(workflow, /Merge Gate wake failed/);
});


test('final review and repair states survive secondary dispatch failures', () => {
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(review, /Review PASS is already recorded/);
  assert.match(review, /CHANGES_REQUESTED is already recorded/);
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(repair, /Published repair is safe/);
  assert.match(repair, /Repair is already published/);
  assert.match(repair, /if: failure\(\) && steps\.changes\.outputs\.changed != 'true'/);
});


test('reconciler resumes durable PR pipeline states', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /issueLabels\.has\('pi:mr-created'\)/);
  assert.match(source, /prLabels\.has\('review:passed'\)/);
  assert.match(source, /prLabels\.has\('review:changes-requested'\)/);
  assert.match(source, /!liveRepairs\.has\(pr\.number\) && !repairCheckpoint/);
  assert.match(source, /mergeGateWakeNeeded = true/);
  assert.doesNotMatch(source, /tryDispatchWorkflow\('pi-pr-fix\.yml'/);
  assert.match(source, /tryDispatchWorkflow\('pi-auto-merge\.yml'/);
});


test('repair with no repository change becomes terminal instead of retrying forever', () => {
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(repair, /Mark no-change repair terminal/);
  assert.match(repair, /if: steps\.changes\.outputs\.changed == 'false'/);
  assert.match(repair, /repair completed without producing a repository change/);
  assert.match(repair, /pi-pr-review-status\.sh failed/);
});


test('repair checkpoint recovery respects terminal review failure', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /!initialPrLabels\.has\('review:failed'\)/);
});


test('stranded pi:ready is requeued for dispatcher rather than merely waking it', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /replaceStateLabels\(issue\.number, issue, 'dispatcher:ready', ISSUE_STATE_LABELS\)/);
  assert.match(source, /return stranded ready issue to serialized dispatcher/);
});


test('merge gate is the sole scheduler for ready semantic reviews', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  const reconciler = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(gate, /label\.name === 'review:running'/);
  assert.doesNotMatch(gate, /\['review:ready', 'review:running'\]/);
  assert.doesNotMatch(reconciler, /tryDispatchWorkflow\('pi-pr-review\.yml'/);
  assert.match(reconciler, /resume ready review through merge-gate scheduler/);
  assert.match(reconciler, /return orphaned review to merge-gate scheduler/);
});


test('merge gate is the sole scheduler for Pi repair workflow', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  const reconciler = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  const reviewer = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(gate, /pi-pr-fix\.yml\/dispatches/);
  assert.doesNotMatch(reconciler, /pi-pr-fix\.yml\/dispatches|tryDispatchWorkflow\('pi-pr-fix\.yml'/);
  assert.doesNotMatch(reviewer, /pi-pr-fix\.yml\/dispatches/);
  assert.match(reconciler, /resume saved repair checkpoint through merge-gate scheduler/);
  assert.match(reconciler, /resume changes-requested repair through merge-gate scheduler/);
});


test('status wrappers delegate mutations to guarded transition engine', () => {
  const issue = fs.readFileSync('scripts/pi-issue-status.sh', 'utf8');
  const review = fs.readFileSync('scripts/pi-pr-review-status.sh', 'utf8');
  const transition = fs.readFileSync('scripts/pi-transition.mjs', 'utf8');
  assert.doesNotMatch(issue, /clear_states|remove_label|add_label/);
  assert.doesNotMatch(review, /clear_review_status|remove_label|add_label/);
  assert.match(issue, /pi-transition\.mjs issue/);
  assert.match(review, /pi-transition\.mjs review/);
  assert.match(transition, /concurrent pipeline transition detected/);
  assert.match(transition, /await load\(\)/);
  assert.match(transition, /method: 'PATCH'/);
});

test('guarded transition replaces only its state-family labels', () => {
  const transition = fs.readFileSync('scripts/pi-transition.mjs', 'utf8');
  assert.match(transition, /filter\(label => !stateLabels\.has\(label\)\)/);
  assert.match(transition, /ISSUE_STATE_LABELS/);
  assert.match(transition, /REVIEW_LABELS/);
});


test('dispatcher and reconciler use guarded whole-state writes', () => {
  const dispatcher = fs.readFileSync('scripts/pi-dispatcher.mjs', 'utf8');
  const reconciler = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(dispatcher, /transitionIssue\(number, "ready"\)/);
  assert.match(dispatcher, /transitionIssue\(number, "queued"\)/);
  assert.match(dispatcher, /transitionIssue\(number, "architect-ready"\)/);
  assert.doesNotMatch(dispatcher, /labels\/pi%3Aready|labels\/dispatcher%3Aready/);
  assert.match(reconciler, /concurrent reconciliation transition/);
  assert.match(reconciler, /replaceStateLabels\(issue\.number, issue, recovery\.add, ISSUE_STATE_LABELS\)/);
  assert.match(reconciler, /replaceStateLabels\(pr\.number, pr, recovery\.add, REVIEW_LABELS\)/);
  assert.doesNotMatch(reconciler, /async function addLabel|async function removeLabel/);
});

test('issue state family includes dispatcher ownership', () => {
  const source = fs.readFileSync('scripts/pi-state-machine.mjs', 'utf8');
  assert.match(source, /ISSUE_STATE_LABELS/);
  assert.match(source, /PIPELINE_LABELS\.queued/);
  assert.match(source, /ready: PIPELINE_LABELS\.ready/);
  assert.match(source, /'architect-ready': PIPELINE_LABELS\.architectReady/);
});


test('merge finalization clears issue state with a guarded whole-state write', () => {
  const gate = fs.readFileSync('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /clearCompletedIssueState/);
  assert.match(gate, /issueStateLabels\(expected\)/);
  assert.match(gate, /concurrent merge finalization/);
  assert.doesNotMatch(gate, /labels\/pi%3Amr-created/);
});


test('architect uses guarded state handoffs and atomic split ownership', () => {
  const source = fs.readFileSync('scripts/pi-architect.mjs', 'utf8');
  assert.match(source, /transitionIssue\(issue, 'architect-ready'\)/);
  assert.match(source, /transitionIssue\(issue, 'queued'\)/);
  assert.match(source, /Parent state changed before split publish/);
  assert.match(source, /Child #\$\{number\} acquired pipeline state before dispatch/);
  assert.doesNotMatch(source, /labels\/dispatcher%3Aready|labels\/architect%3Aready/);
});

test('triage uses guarded whole-state classification transitions', () => {
  const source = fs.readFileSync('scripts/pi-triage.mjs', 'utf8');
  assert.match(source, /transitionIssue\(number, "queued"\)/);
  assert.match(source, /transitionIssue\(number, "needs-human"\)/);
  assert.match(source, /concurrent Triage transition/);
  assert.doesNotMatch(source, /labels\/pi%3Aneeds-human/);
});


test('label provisioning covers the complete executable issue state family', () => {
  const source = fs.readFileSync('scripts/pi-labels.mjs', 'utf8');
  assert.match(source, /dispatcher:ready/);
  assert.match(source, /architect:ready/);
  for (const label of ['pi:ready','pi:running','pi:mr-created','pi:needs-human','pi:failed','pi:cancelled']) {
    assert.match(source, new RegExp(label.replace(':', '\\:')));
  }
});
