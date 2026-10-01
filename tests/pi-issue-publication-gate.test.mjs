import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readScript } from './helpers/resolved-source.mjs';

import { nextLabelsForVerification } from '../scripts/pi-common/issue-publication.mjs';
import { PIPELINE_LABELS } from '../scripts/pi-common/state-machine.mjs';
import { VERIFICATION_STATES } from '../scripts/pi-common/validation-ledger.mjs';

/**
 * Regression for the exact smoke-run shape: focused run_check infra_error on
 * one path, broad checks.final passes, PR says VERIFICATION_BLOCKED_INFRA in
 * its body -- but prose alone must not be enough to let the PR progress.
 * `nextLabelsForVerification` is the durable control-plane gate: it is what
 * `upsertPullRequest` calls to decide whether to add pi:needs-human to the
 * PR itself, which both the shared PR-guard (used by Reviewer and PR Fix,
 * see pr-guard.mjs's "needs-human is a hard stop") and Merge Gate
 * (pi-auto-merge.mjs's own needs-human check) already treat as unconditional.
 */

test('a non-VERIFIED PR gets pi:needs-human added', () => {
  for (const state of [
    VERIFICATION_STATES.BLOCKED_INFRA,
    VERIFICATION_STATES.FAILED,
    VERIFICATION_STATES.PENDING,
    VERIFICATION_STATES.NOT_APPLICABLE,
  ]) {
    assert.deepEqual(nextLabelsForVerification([], state), [PIPELINE_LABELS.needsHuman]);
    assert.deepEqual(nextLabelsForVerification(['some-other-label'], state), ['some-other-label', PIPELINE_LABELS.needsHuman]);
  }
});

test('a VERIFIED PR never gets pi:needs-human added', () => {
  assert.equal(nextLabelsForVerification([], VERIFICATION_STATES.VERIFIED), null);
  assert.equal(nextLabelsForVerification(['some-other-label'], VERIFICATION_STATES.VERIFIED), null);
});

test('pi:needs-human is never added twice, and never removed once present', () => {
  const alreadyGated = [PIPELINE_LABELS.needsHuman, 'review:passed'];
  assert.equal(nextLabelsForVerification(alreadyGated, VERIFICATION_STATES.BLOCKED_INFRA), null);
  // Even a later VERIFIED run must not auto-clear it: exactly like every
  // other pi:needs-human producer in this codebase, clearing it is a human
  // action, never something this gate does for the PR author.
  assert.equal(nextLabelsForVerification(alreadyGated, VERIFICATION_STATES.VERIFIED), null);
});

test('label objects in GitHub API shape (not bare strings) are handled identically', () => {
  const apiShapeLabels = [{ name: 'review:passed' }];
  assert.deepEqual(
    nextLabelsForVerification(apiShapeLabels, VERIFICATION_STATES.BLOCKED_INFRA),
    ['review:passed', PIPELINE_LABELS.needsHuman],
  );
});

test('upsertPullRequest applies the gate on both the create and update paths, and returns verification_state', () => {
  const source = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(source, /const verificationState = computeVerificationState\(ledgerRecords, \{ corrupted: ledgerCorrupted \}\);/);
  assert.match(source, /nextLabelsForVerification\(existing\[0\]\.labels, verificationState\)/);
  assert.match(source, /nextLabelsForVerification\(\[\], verificationState\)/);
  assert.match(source, /if \(nextLabels\) await replaceLabels\(pr\.number, nextLabels\);/);
  assert.match(source, /return \{ number:pr\.number, url:pr\.html_url, verification_state: verificationState \};/);
});

test('the issue-agent workflow only dispatches Reviewer when the ledger says VERIFIED', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.match(workflow, /verification_state=\$\(jq -r '\.verification_state' <<<"\$PR"\)/);
  const reviewStep = workflow.slice(workflow.indexOf('Start independent PR review'));
  assert.match(reviewStep, /if: steps\.checkpoint\.outputs\.changed == 'true' && steps\.pr\.outputs\.number != '' && steps\.pr\.outputs\.verification_state == 'VERIFIED'/);
});
