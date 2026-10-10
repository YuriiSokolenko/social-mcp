import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mutatedRoot } from './helpers/fake-github.mjs';
import * as scenarios from './helpers/orchestration-scenarios.mjs';

// Mutation checks (#727): each row breaks one production line in a temporary
// copy of scripts/ and replays a behavioral scenario against it. The scenario
// must fail with an assertion, proving it detects that regression rather than
// only exercising the code. The same scenarios pass against the real scripts
// in pi-orchestration-flow.test.mjs and pi-orchestration-faults.test.mjs.
//
// Anchors must match exactly once (mutatedRoot enforces it), so a refactor of
// a mutated line fails here loudly and the row must be updated deliberately.

const MUTANTS = [
  {
    stage: 'Triage', regression: 'incorrect transition: a ready issue is flagged for a human',
    file: 'scripts/pi-triage.mjs', from: 'await transitionIssue(number, "queued");', to: 'await transitionIssue(number, "needs-human");',
    scenario: 'happyPath',
  },
  {
    stage: 'Dispatcher', regression: 'incorrect dispatch: IMPLEMENT wakes the Architect workflow',
    file: 'scripts/pi-dispatcher.mjs',
    from: 'await dispatchWorkflow(workflowFile("implementer"), { issue_number: String(number), dispatch_mode: "dispatcher" });',
    to: 'await dispatchWorkflow(workflowFile("architect"), { issue_number: String(number), dispatch_mode: "dispatcher" });',
    scenario: 'happyPath',
  },
  {
    stage: 'Dispatcher', regression: 'failed dispatch strands pi:ready instead of rolling back',
    file: 'scripts/pi-dispatcher.mjs',
    from: 'await transitionIssue(number, "queued");\n      } catch (rollbackError) {\n        console.error(`Could not roll back ${PIPELINE_LABELS.ready}',
    to: 'void 0;\n      } catch (rollbackError) {\n        console.error(`Could not roll back ${PIPELINE_LABELS.ready}',
    scenario: 'dispatchRateLimited',
  },
  {
    stage: 'GitHub state', regression: 'compare-and-swap disabled: a stale writer overwrites a newer owner',
    file: 'scripts/pi-common/github-state.mjs',
    from: 'if (JSON.stringify(expectedState) !== JSON.stringify(currentState)) {', to: 'if (false) {',
    scenario: 'concurrentOwnership',
  },
  {
    stage: 'Architect', regression: 'split children are created but never exposed to Dispatcher',
    file: 'scripts/pi-architect.mjs', from: '      target: PIPELINE_LABELS.queued,', to: '      target: null,',
    scenario: 'architectSplit',
  },
  {
    stage: 'PR publication', regression: 'duplicate publication: a retried publish opens a second PR',
    file: 'scripts/pi-common/issue-publication.mjs', from: 'if (existing[0]) {', to: 'if (false) {',
    scenario: 'happyPath',
  },
  {
    stage: 'Reviewer', regression: 'stale-head acceptance: a verdict for an old HEAD is applied',
    file: 'scripts/pi-common/review-state.mjs',
    from: '  if (pr.head.sha !== reviewedHead) {\n    await replaceReviewLabels(prNumber);',
    to: '  if (false) {\n    await replaceReviewLabels(prNumber);',
    scenario: 'staleHead',
  },
  {
    stage: 'Reviewer', regression: 'duplicate publication: a re-run apply step posts the verdict comment again',
    file: 'scripts/pi-common/review-state.mjs',
    from: "if (comments.some(item => String(item.body ?? '').includes(marker))) return { status: 'already-applied', verdict };",
    to: "if (false) return { status: 'already-applied', verdict };",
    scenario: 'happyPath',
  },
  {
    stage: 'Reviewer recovery', regression: 'unbounded retry: a repeated interruption is retried instead of escalated',
    file: 'scripts/pi-common/review-state.mjs', from: 'if (previousFailures === 0) {', to: 'if (true) {',
    scenario: 'rebootOrphanedReviewer',
  },
  {
    stage: 'PR Fix', regression: 'incorrect dispatch: the repair handoff wakes PR Fix again instead of Reviewer',
    file: 'scripts/pi-common/repair-publication.mjs',
    from: "await dispatchWorkflow(workflowFile('reviewer'), { pr_number: String(prNumber) });",
    to: "await dispatchWorkflow(workflowFile('repair'), { pr_number: String(prNumber) });",
    scenario: 'repairLoop',
  },
  {
    stage: 'Merge Gate', regression: 'stale-head acceptance: no re-read of the PR HEAD before merge',
    file: 'scripts/pi-auto-merge.mjs',
    from: "if (fresh.state !== 'open' || fresh.head.sha !== sha) {", to: "if (fresh.state !== 'open') {",
    scenario: 'staleHead',
  },
  {
    stage: 'Merge Gate', regression: 'unbounded infrastructure CI retries',
    file: 'scripts/pi-auto-merge.mjs', from: 'if (runAttempt <= 1) {', to: 'if (true) {',
    scenario: 'cancelledCi',
  },
  {
    stage: 'Merge Gate', regression: 'label loss: ownership is not transferred before a PR Fix dispatch that may fail',
    file: 'scripts/pi-auto-merge.mjs',
    from: 'await replaceLabels(pr.number, withReviewVerdict([...prLabels], REVIEW_CHANGES_REQUESTED));\n    let dispatched = false;',
    to: 'let dispatched = false;',
    scenario: 'repairDispatchLost',
  },
  {
    stage: 'GitHub client', regression: 'no request timeout: a stalled GitHub call hangs the stage',
    file: 'scripts/pi-common/github-api.mjs', from: 'signal: AbortSignal.timeout(timeoutMs),', to: '',
    scenario: 'mergeGateTransportFaults',
  },
  {
    stage: 'Post-merge', regression: 'merged work never completes its issue',
    file: 'scripts/pi-post-merge.mjs',
    from: "await updateIssue(issueNumber, { state: 'closed', state_reason: 'completed', labels });", to: 'void labels;',
    scenario: 'happyPath',
  },
  {
    stage: 'Reconciler', regression: 'missed recovery: an orphaned Implementer is not returned to Dispatcher',
    file: 'scripts/pi-reconcile.mjs', from: 'if (lostOwner || strandedReady) {', to: 'if (strandedReady) {',
    scenario: 'rebootOrphanedReviewer',
  },
  {
    stage: 'Reconciler', regression: 'split-brain: a second Reviewer is dispatched while one is live',
    file: 'scripts/pi-reconcile.mjs',
    from: 'if (labels.has(PIPELINE_LABELS.needsHuman) || liveReviews.has(pr.number) || liveFixes.has(pr.number)) continue;',
    to: 'if (labels.has(PIPELINE_LABELS.needsHuman)) continue;',
    scenario: 'lostReviewWake',
  },
  {
    stage: 'Reconciler', regression: 'interrupted Architect split is never completed (the pre-#727 escaped regex)',
    file: 'scripts/pi-reconcile.mjs',
    from: String.raw`/<!-- architect-children:([1-9]\d*(?:,[1-9]\d*)*) -->/`,
    to: String.raw`/<!-- architect-children:([1-9]\\d*(?:,[1-9]\\d*)*) -->/`,
    scenario: 'architectSplit',
  },
  {
    stage: 'Transition', regression: 'a late failure after merge escalates instead of completing the issue',
    file: 'scripts/pi-transition.mjs', from: '} else if (await completeFromMergedImplementation(item)) {', to: '} else if (false) {',
    scenario: 'delayedCompletion',
  },
];

// Control: every scenario used below passes against an unmodified copy, so a
// mutant failure can only come from the mutated line, not from the copy.
describe('scenarios pass against an unmodified control-plane copy', { concurrency: 4 }, () => {
  for (const name of new Set(MUTANTS.map(mutant => mutant.scenario))) {
    const { file, from } = MUTANTS.find(mutant => mutant.scenario === name);
    it(name, t => scenarios[name](t, { root: mutatedRoot(t, file, from, from) }));
  }
});

describe('behavioral scenarios detect deliberate control-plane regressions', { concurrency: 4 }, () => {
  for (const mutant of MUTANTS) {
    it(`${mutant.stage}: ${mutant.regression} → ${mutant.scenario} fails`, async t => {
      const root = mutatedRoot(t, mutant.file, mutant.from, mutant.to);
      await assert.rejects(
        () => scenarios[mutant.scenario](t, { root }),
        error => {
          assert.equal(error?.code, 'ERR_ASSERTION', `mutant must fail an assertion, not crash the harness: ${error?.stack ?? error}`);
          return true;
        },
      );
    });
  }
});
