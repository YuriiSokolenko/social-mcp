import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkpointBranch } from '../scripts/pi-common/project-config.mjs';
import { readScript } from './helpers/resolved-source.mjs';
import { inspectIssueState, safeRemovals } from '../scripts/pi-common/state-machine.mjs';
import { checkpointGcDecision, issueRecoveryTarget } from '../scripts/pi-common/recovery-policy.mjs';

const labels = (...names) => names.map(name => ({ name }));

test('dead implementer returns to Dispatcher without losing saved work', () => {
  const issue = { state: 'open', labels: labels('pi:running') };
  const findings = inspectIssueState(issue, { hasLiveImplementer: false, hasCheckpoint: true });
  assert.deepEqual(safeRemovals(findings), ['pi:running']);
  assert.equal(issueRecoveryTarget(issue, { automationMode: 'RUNNING' }), 'dispatcher:ready');
  assert.equal(checkpointGcDecision(issue).remove, false);
});

test('published PR wins over returning a dead implementer to Dispatcher', () => {
  const issue = { state: 'open', labels: labels('pi:running') };
  assert.equal(issueRecoveryTarget(issue, { hasOpenPiPr: true, automationMode: 'RUNNING' }), 'pi:mr-created');
  assert.equal(issueRecoveryTarget(issue, { automationMode: 'DRAINING' }), null);
});

test('completed issue makes checkpoint garbage collectable', () => {
  assert.equal(checkpointGcDecision({ state: 'closed', state_reason: 'completed', labels: [] }).remove, true);
});

test('RUNNING control wakes only the normal Dispatcher scheduler', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-automation-control.yml', 'utf8');
  const control = readScript('scripts/pi-common/automation-control.mjs', 'utf8');
  assert.match(workflow, /automation-control\.mjs" resume/);
  assert.match(control, /dispatchWorkflow\('pi-dispatcher\.yml'\)/);
  assert.doesNotMatch(control, /dispatchWorkflow\('pi-reconcile\.yml'\)/);
});

test('agent concurrency never cancels active work', () => {
  for (const path of ['.github/workflows/pi-issue-agent.yml', '.github/workflows/pi-pr-review.yml', '.github/workflows/pi-pr-fix.yml']) {
    assert.match(fs.readFileSync(path, 'utf8'), /cancel-in-progress: false/);
  }
});

test('Pi issue review invalidation is isolated per branch and outside the N150 queue', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-review-invalidate.yml', 'utf8');
  const group = workflow.match(/^concurrency:\n\s+group: (.+)$/m)?.[1] ?? '';
  assert.match(workflow, /push:[\s\S]*'pi\/issue-\*'/);
  assert.match(group, /github\.ref_name/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(workflow, /n150|general/);
});

test('implementer checkpoint uses compare-and-swap lease and exact deletion', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const publication = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(workflow, /PI_CHECKPOINT_EXPECTED/);
  assert.match(publication, /const ref = `refs\/heads\/\$\{checkpointBranch\(issue\)\}`/);
  assert.match(publication, /--force-with-lease=\$\{ref\}:\$\{expectedSha/);
  assert.equal(checkpointBranch(42), 'pi/issue-42-checkpoint');
  assert.match(workflow, /PI_CHECKPOINT_PUBLISHED/);
  assert.match(workflow, /--force-with-lease="refs\/heads\/pi\/issue-\$\{ISSUE\}-checkpoint:\$\{PI_CHECKPOINT_PUBLISHED\}"/);
});

test('published PR state is durable before independent review starts', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.ok(workflow.indexOf('- name: Mark pull request created') < workflow.indexOf('- name: Start independent PR review'));
  const publication = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(workflow, /issue-publication\.mjs" review/);
  assert.match(publication, /dispatchWorkflow\('pi-pr-review\.yml'/);
  assert.doesNotMatch(publication, /dispatchWorkflow\('pi-auto-merge\.yml'/);
  assert.match(workflow, /pi-run-stage\.mjs" implementer/);
  assert.match(workflow, /- name: Mark no-change result[\s\S]*exit 1/);
  assert.match(workflow, /if: failure\(\) && steps\.preflight\.outcome == 'success' && steps\.checkpoint\.outputs\.changed != 'false' && steps\.pr\.outputs\.number == ''/);
});








test('closed unmerged Pi PR is a normal review skip and immediately enters issue recovery', () => {
  const guard = readScript('scripts/pi-common/pr-guard.mjs', 'utf8');
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');
  const workflow = fs.readFileSync('.github/workflows/pi-reconcile.yml', 'utf8');
  assert.match(guard, /pr\.state !== 'open'[\s\S]*reason: pr\.merged \? 'merged' : 'closed'/);
  assert.match(reconcile, /safeRemovals\(findings\)/);
  assert.doesNotMatch(reconcile, /lostOwner[\s\S]{0,220}mr-label-without-open-pr/);
  assert.match(workflow, /pull_request:[\s\S]*types: \[closed\]/);
  assert.match(workflow, /pull_request\.merged == false/);
  assert.match(workflow, /startsWith\(github\.event\.pull_request\.head\.ref, 'pi\/issue-'\)/);
});


test('issue state family is intentionally small', () => {
  const source = readScript('scripts/pi-common/state-machine.mjs', 'utf8');
  for (const label of ['dispatcher:ready', 'pi:ready', 'pi:running', 'pi:mr-created', 'pi:needs-human', 'architect:ready']) {
    assert.match(source, new RegExp(label.replace(':', '\\:')));
  }
  assert.doesNotMatch(source, /pi:failed|pi:cancelled/);
});





test('architect and reconciler contain no removed terminal-state machinery', () => {
  const architect = readScript('scripts/pi-architect.mjs', 'utf8');
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');
  assert.doesNotMatch(architect, /pi:failed|pi:blocked|pi:cancelled/);
  assert.doesNotMatch(reconcile, /repairCheckpointRefs|liveRepairs|repair-pr-/);
});











test('reconciler may recover a lost PASS-to-merge-gate handoff without becoming the normal scheduler', () => {
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /passed-pr-needs-merge-gate/);
  assert.match(reconcile, /tryDispatchWorkflow\('pi-auto-merge\.yml'/);
  assert.match(reconcile, /RECOVERY_GRACE_MS = 10 \* 60 \* 1000/);
});


test('implementer preserves PR ownership when a post-publication step fails or is cancelled', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.match(workflow, /Recover publication state after failure[\s\S]*failure\(\).*steps\.pr\.outputs\.number != ''[\s\S]*issue mr-created/);
  assert.match(workflow, /Recover publication state after cancellation[\s\S]*cancelled\(\).*steps\.pr\.outputs\.number != ''[\s\S]*issue mr-created/);
});


test('control runner watch covers both post-dev and PR terminal wake lanes', () => {
  const workflow = fs.readFileSync('.github/workflows/control-runner-watch.yml', 'utf8');
  assert.match(workflow, /workflowId: 'ci\.yml'/);
  assert.match(workflow, /jobName: 'wake-merge-gate'/);
  assert.match(workflow, /workflowId: 'ci-terminal-wake\.yml'/);
  assert.match(workflow, /jobName: 'wake-pr-merge-gate'/);
  assert.match(workflow, /\['queued', 'in_progress'\]/);
});

test('stateful control workflows serialize without cancelling active work', () => {
  for (const file of ['pi-dispatcher.yml', 'pi-triage.yml', 'pi-reconcile.yml', 'pi-architect.yml', 'pi-issue-agent.yml', 'pi-pr-review.yml', 'pi-pr-fix.yml', 'pi-auto-merge.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${file}`, 'utf8');
    assert.match(workflow, /concurrency:[\s\S]*?group:[^\n]+[\s\S]*?cancel-in-progress: false/);
    assert.doesNotMatch(workflow, /^\s+queue:\s*/m);
  }
});


test('orphaned architect ownership is infrastructure recovery, not human escalation', () => {
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /orphaned-architect-state[\s\S]*dispatcher:ready/);
  assert.doesNotMatch(reconcile, /orphaned-architect-state[\s\S]{0,600}pi-dispatcher\.yml/);
  assert.doesNotMatch(reconcile, /orphaned-architect-state[\s\S]{0,180}pi:needs-human/);
});


test('implementer structured result requires at least one concrete change', () => {
  const tool = readScript('scripts/pi-implementer-result-tool.mjs', 'utf8');
  assert.match(tool, /at least one concrete change is required/);
});


test('Reconciler never schedules Implementer directly', () => {
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');
  assert.doesNotMatch(reconcile, /pi-issue-agent\.yml/);
  assert.match(reconcile, /issueRecoveryTarget/);
  assert.match(reconcile, /dispatcher:ready/);
});

test('merge gate owns only eligibility and merge; dev CI owns validation', () => {
  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /merge_method: 'squash'/);
  assert.doesNotMatch(gate, /pi-pr-review|social-mcp\/integration|social-mcp\/pi-review|statuses/);
  assert.match(gate, /dispatchWorkflow\('pi-pr-fix\.yml'/);
});

test('manual review and repair contain no captured dev-base state', () => {
  for (const file of ['pi-pr-review.yml', 'pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(`.github/workflows/${file}`, 'utf8');
    assert.doesNotMatch(workflow, /integration_base_sha|repair_base_sha|BASE_SHA|social-mcp\/integration/);
  }
});


test('stranded pi:ready work returns through the normal Dispatcher round trip', () => {
  const reconcile = readScript('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(reconcile, /strandedReady/);
  assert.match(reconcile, /issueRecoveryTarget/);
  assert.doesNotMatch(reconcile, /dispatchWorkflow\('pi-issue-agent\.yml'/);
  const dispatcher = fs.readFileSync('.github/workflows/pi-dispatcher.yml', 'utf8');
  assert.match(dispatcher, /github\.event\.label\.name == 'dispatcher:ready'/);
});

test('dispatcher-ready label event is the only normal wake after architect publication', () => {
  const architect = readScript('scripts/pi-architect.mjs', 'utf8');
  const dispatcher = fs.readFileSync('.github/workflows/pi-dispatcher.yml', 'utf8');
  assert.match(dispatcher, /github\.event\.label\.name == 'dispatcher:ready'/);
  assert.doesNotMatch(architect, /dispatchWorkflow\('pi-dispatcher\.yml'/);
});

test('manual Implementer dispatch bypasses pi:ready while Dispatcher keeps the strict ready gate', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const dispatcher = readScript('scripts/pi-dispatcher.mjs', 'utf8');
  assert.match(workflow, /dispatch_mode:/);
  assert.match(workflow, /default: manual/);
  assert.match(workflow, /PI_DISPATCH_MODE: \$\{\{ inputs\.dispatch_mode \|\| 'manual' \}\}/);
  assert.match(workflow, /MODE="plain"/);
  assert.match(workflow, /PI_DISPATCH_MODE" = "dispatcher"[\s\S]*MODE="ready"/);
  assert.match(workflow, /ACTION="running-manual"/);
  assert.match(workflow, /PI_DISPATCH_MODE" = "dispatcher"[\s\S]*ACTION="running"/);
  assert.match(dispatcher, /dispatchWorkflow\("pi-issue-agent\.yml", \{ issue_number: String\(number\), dispatch_mode: "dispatcher" \}\)/);
});


test('stale implementation refs do not create restored work when latest dev already contains them', () => {
  const worktree = readScript('scripts/pi-common/issue-worktree.mjs', 'utf8');
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const runtime = readScript('scripts/pi-agent-runtime.mjs', 'utf8');
  const resultTool = readScript('scripts/pi-implementer-result-tool.mjs', 'utf8');
  assert.match(worktree, /diff', '--quiet', 'origin\/dev', '--'/);
  assert.match(worktree, /if \(!resumed\)[\s\S]*writeFileSync\(patch, ''\)/);
  assert.match(workflow, /PI_RESUME_ACTIVE=.*\.resumed/);
  assert.match(runtime, /PI_RESUME_ACTIVE/);
  assert.match(resultTool, /PI_RESUME_ACTIVE/);
  assert.match(resultTool, /Latest dev already contains the replayed saved implementation/);
  assert.match(resultTool, /already_satisfied: true/);
});

test('merged implementation PR is terminal before a repeated Implementer run becomes expensive', () => {
  const transition = readScript('scripts/pi-transition.mjs', 'utf8');
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.match(transition, /mergedImplementationPr/);
  assert.match(transition, /state: 'closed', state_reason: 'completed'/);
  assert.match(transition, /terminal=true/);
  assert.match(workflow, /id: claim/);
  assert.match(workflow, /if: steps\.claim\.outputs\.terminal != 'true'/);
});
