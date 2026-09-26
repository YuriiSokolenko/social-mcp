import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectIssueState, inspectPrState, safeRemovals, validateIssueTransition, validateReviewTransition } from '../scripts/pi-state-machine.mjs';

const issue = (state, labels) => ({ state, labels: labels.map(name => ({ name })) });

test('closed issues cannot remain queued or active', () => {
  const findings = inspectIssueState(issue('closed', ['dispatcher:ready', 'pi:running']));
  assert.deepEqual(safeRemovals(findings).sort(), ['dispatcher:ready', 'pi:running']);
});

test('terminal state wins over queued or active labels', () => {
  const findings = inspectIssueState(issue('open', ['pi:failed', 'dispatcher:ready', 'pi:ready']));
  assert.deepEqual(safeRemovals(findings).sort(), ['dispatcher:ready', 'pi:ready']);
});

test('epics are never executable work', () => {
  const findings = inspectIssueState(issue('open', ['architect:epic', 'dispatcher:ready', 'pi:running']));
  assert.deepEqual(safeRemovals(findings).sort(), ['dispatcher:ready', 'pi:running']);
});

test('ambiguous multiple active states keep the furthest safe state', () => {
  const findings = inspectIssueState(issue('open', ['pi:ready', 'pi:running']));
  assert.equal(findings.some(item => item.code === 'multiple-active' && item.keep === 'pi:running'), true);
  assert.deepEqual(safeRemovals(findings), ['pi:ready']);
});

test('multiple review states keep the currently executing state', () => {
  const findings = inspectPrState({ state: 'open', labels: [
    { name: 'review:ready' }, { name: 'review:running' }, { name: 'review:passed' },
  ] }, { hasLiveReviewer: true });
  assert.deepEqual(safeRemovals(findings).sort(), ['review:passed', 'review:ready']);
});

test('mr-created without a matching open PR needs investigation', () => {
  const findings = inspectIssueState(issue('open', ['pi:mr-created']), { hasOpenPiPr: false });
  assert.equal(findings.some(item => item.code === 'mr-label-without-open-pr'), true);
});

test('closed PR cannot keep an active review label', () => {
  const findings = inspectPrState({ state: 'closed', labels: [{ name: 'review:running' }] });
  assert.deepEqual(safeRemovals(findings), ['review:running']);
});

test('implementer transitions require an open executable issue', () => {
  assert.equal(validateIssueTransition(issue('open', ['pi:ready']), 'running'), 'pi:running');
  assert.throws(() => validateIssueTransition(issue('closed', ['pi:ready']), 'running'), /closed issue/);
  assert.throws(() => validateIssueTransition(issue('open', ['architect:epic', 'pi:ready']), 'running'), /epic/);
  assert.throws(() => validateIssueTransition(issue('open', []), 'running'), /pi:ready/);
});

test('review transitions require an open PR', () => {
  assert.equal(validateReviewTransition({ state: 'open', labels: [] }, 'passed'), 'review:passed');
  assert.throws(() => validateReviewTransition({ state: 'closed', labels: [] }, 'passed'), /closed PR/);
});


test('orphaned implementer state is safely released while checkpoint is preserved', () => {
  const findings = inspectIssueState(issue('open', ['pi:running']), {
    hasLiveImplementer: false, hasCheckpoint: true,
  });
  assert.deepEqual(safeRemovals(findings), ['pi:running']);
  assert.equal(findings.some(item => item.code === 'orphaned-implementer-state' && item.checkpoint === true), true);
});

test('live implementer keeps running state', () => {
  const findings = inspectIssueState(issue('open', ['pi:running']), { hasLiveImplementer: true });
  assert.equal(findings.some(item => item.code === 'orphaned-implementer-state'), false);
});

test('checkpoint without live running state is reported but never deleted', () => {
  const findings = inspectIssueState(issue('open', ['pi:ready']), {
    hasLiveImplementer: false, hasCheckpoint: true,
  });
  assert.equal(findings.some(item => item.code === 'checkpoint-without-live-implementer'), true);
  assert.deepEqual(safeRemovals(findings), []);
});

test('orphaned reviewer state is safely released', () => {
  const findings = inspectPrState({ state: 'open', labels: [{ name: 'review:running' }] }, {
    hasLiveReviewer: false,
  });
  assert.deepEqual(safeRemovals(findings), ['review:running']);
});
