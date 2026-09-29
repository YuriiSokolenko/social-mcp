import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectIssueState, isIssueTransitionNoop, safeRemovals, validateIssueTransition } from '../scripts/pi-common/state-machine.mjs';
import { replaceIssueState } from '../scripts/pi-common/github-state.mjs';

const issue = (state, labels) => ({ state, labels: labels.map(name => ({ name })) });

test('closed issues cannot remain queued or active', () => {
  const findings = inspectIssueState(issue('closed', ['dispatcher:ready', 'pi:running']));
  assert.deepEqual(safeRemovals(findings).sort(), ['dispatcher:ready', 'pi:running']);
});

test('terminal state wins over queued or active labels', () => {
  const findings = inspectIssueState(issue('open', ['pi:needs-human', 'dispatcher:ready', 'pi:ready']));
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


test('mr-created without a matching open PR needs investigation', () => {
  const findings = inspectIssueState(issue('open', ['pi:mr-created']), { hasOpenPiPr: false });
  assert.equal(findings.some(item => item.code === 'mr-label-without-open-pr'), true);
});


test('implementer transitions require an open executable issue', () => {
  assert.equal(validateIssueTransition(issue('open', ['pi:ready']), 'running'), 'pi:running');
  assert.throws(() => validateIssueTransition(issue('closed', ['pi:ready']), 'running'), /closed issue/);
  assert.throws(() => validateIssueTransition(issue('open', ['architect:epic', 'pi:ready']), 'running'), /epic/);
  assert.throws(() => validateIssueTransition(issue('open', []), 'running'), /pi:ready/);
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



test('terminal issue may retain a checkpoint for human recovery without reconciliation noise', () => {
  const findings = inspectIssueState({ state: 'open', labels: [{ name: 'pi:needs-human' }] }, {
    hasOpenPiPr: false,
    hasLiveImplementer: false,
    hasCheckpoint: true,
  });
  assert.equal(findings.some(item => item.code === 'checkpoint-without-live-implementer'), false);
  assert.equal(findings.some(item => item.code === 'orphaned-implementer-state'), false);
});

test('triage or a human retry may queue unowned and needs-human issues', () => {
  assert.equal(validateIssueTransition(issue('open', []), 'queued'), 'dispatcher:ready');
  assert.equal(validateIssueTransition(issue('open', ['pi:needs-human']), 'queued'), 'dispatcher:ready');
});

test('orphaned Architect ownership is detected', () => {
  const findings = inspectIssueState(issue('open', ['architect:ready']), { hasLiveArchitect: false });
  assert.deepEqual(safeRemovals(findings), ['architect:ready']);
  assert.equal(findings.some(item => item.code === 'orphaned-architect-state'), true);
});

test('live Architect keeps ownership', () => {
  const findings = inspectIssueState(issue('open', ['architect:ready']), { hasLiveArchitect: true });
  assert.equal(findings.some(item => item.code === 'orphaned-architect-state'), false);
});


test('mr-created is only published from running implementation state', () => {
  assert.equal(validateIssueTransition(issue('open', ['pi:running']), 'mr-created'), 'pi:mr-created');
  assert.equal(validateIssueTransition(issue('open', ['pi:mr-created']), 'mr-created'), 'pi:mr-created');
  assert.throws(() => validateIssueTransition(issue('open', ['pi:ready']), 'mr-created'), /pi:running/);
});

test('PR-owned issue cannot be overwritten by needs-human state', () => {
  assert.throws(() => validateIssueTransition(issue('open', ['pi:mr-created']), 'needs-human'), /published PR ownership/);
  assert.equal(validateIssueTransition(issue('open', ['pi:running']), 'needs-human'), 'pi:needs-human');
});


test('queued transition cannot steal PR ownership', () => {
  assert.throws(() => validateIssueTransition(issue('open', ['pi:mr-created']), 'queued'), /queued requires/);
});

test('needs-human transition is idempotent for non-PR terminal issues', () => {
  assert.equal(validateIssueTransition(issue('open', ['pi:needs-human']), 'needs-human'), 'pi:needs-human');
});


test('queued transition cannot steal a live implementer state', () => {
  assert.throws(() => validateIssueTransition(issue('open', ['pi:running']), 'queued'), /queued requires/);
});


test('already-satisfied completion is allowed only from a running implementer state', () => {
  assert.equal(validateIssueTransition(issue('open', ['pi:running']), 'satisfied'), null);
  assert.throws(() => validateIssueTransition(issue('open', []), 'satisfied'), /pi:running/);
  assert.throws(() => validateIssueTransition(issue('open', ['pi:ready']), 'satisfied'), /pi:running/);
  assert.throws(() => validateIssueTransition(issue('closed', ['pi:running']), 'satisfied'), /closed issue/);
});

test('all pipeline transitions are no-ops once an issue is closed', () => {
  assert.equal(isIssueTransitionNoop(issue('closed', []), 'stopped'), true);
  assert.equal(isIssueTransitionNoop(issue('closed', ['architect:ready']), 'stopped'), true);
  assert.equal(isIssueTransitionNoop(issue('closed', []), 'needs-human'), true);
  assert.equal(isIssueTransitionNoop(issue('closed', []), 'running-manual'), true);
  assert.equal(isIssueTransitionNoop(issue('open', ['architect:ready']), 'stopped'), false);
});

test('stopped transition removes pipeline ownership and preserves unrelated labels', async () => {
  const running = issue('open', ['pi:running', 'keep-me']);
  assert.equal(validateIssueTransition(running, 'stopped'), null);
  let patched;
  const result = await replaceIssueState({
    number: 25,
    expected: running,
    target: null,
    load: async () => running,
    patch: async (_number, labels) => { patched = labels; },
  });
  assert.deepEqual(patched, ['keep-me']);
  assert.deepEqual(result.labels, ['keep-me']);

  assert.equal(validateIssueTransition(issue('open', ['architect:ready']), 'stopped'), null);
  assert.throws(() => validateIssueTransition(issue('open', []), 'stopped'), /pi:running or architect:ready/);
  assert.throws(() => validateIssueTransition(issue('open', ['dispatcher:ready']), 'stopped'), /pi:running or architect:ready/);
});

test('manual implementer start can claim an open issue without pi:ready but cannot steal PR or Architect ownership', () => {
  assert.equal(validateIssueTransition(issue('open', []), 'running-manual'), 'pi:running');
  assert.equal(validateIssueTransition(issue('open', ['dispatcher:ready']), 'running-manual'), 'pi:running');
  assert.equal(validateIssueTransition(issue('open', ['pi:needs-human']), 'running-manual'), 'pi:running');
  assert.throws(() => validateIssueTransition(issue('open', ['pi:mr-created']), 'running-manual'), /cannot steal/);
  assert.throws(() => validateIssueTransition(issue('open', ['architect:ready']), 'running-manual'), /cannot steal/);
});
