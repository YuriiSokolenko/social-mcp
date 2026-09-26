import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectIssueState, inspectPrState, safeRemovals } from '../scripts/pi-state-machine.mjs';

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

test('ambiguous multiple active states are reported but not guessed', () => {
  const findings = inspectIssueState(issue('open', ['pi:ready', 'pi:running']));
  assert.equal(findings.some(item => item.code === 'multiple-active' && item.severity === 'warning'), true);
  assert.deepEqual(safeRemovals(findings), []);
});

test('mr-created without a matching open PR needs investigation', () => {
  const findings = inspectIssueState(issue('open', ['pi:mr-created']), { hasOpenPiPr: false });
  assert.equal(findings.some(item => item.code === 'mr-label-without-open-pr'), true);
});

test('closed PR cannot keep an active review label', () => {
  const findings = inspectPrState({ state: 'closed', labels: [{ name: 'review:running' }] });
  assert.deepEqual(safeRemovals(findings), ['review:running']);
});
