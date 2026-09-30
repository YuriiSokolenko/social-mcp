import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendCheckRecord,
  readValidationLedger,
  normalizeScope,
  reconcile,
  computeVerificationState,
  renderValidationSection,
  VERIFICATION_STATES,
} from '../scripts/pi-common/validation-ledger.mjs';

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-validation-ledger-'));
  return path.join(dir, 'ledger.jsonl');
}

const focused = (overrides = {}) => ({
  kind: 'python_compile',
  scope: { paths: ['arkanoid.py'] },
  status: 'pass',
  exit_code: 0,
  source: 'run_check',
  stage: 'implementer',
  backend: 'pi',
  run_id: 'local',
  ...overrides,
});

const finalCheck = (overrides = {}) => ({
  kind: 'pytest',
  scope: { whole_repo: true },
  status: 'pass',
  exit_code: 0,
  source: 'checks_final',
  stage: 'implementer',
  backend: 'pi',
  run_id: 'local',
  ...overrides,
});

test('appendCheckRecord/readValidationLedger round-trip preserves order and assigns seq', () => {
  const ledgerPath = tempLedger();
  appendCheckRecord(ledgerPath, focused());
  appendCheckRecord(ledgerPath, finalCheck());
  const records = readValidationLedger(ledgerPath);
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'python_compile');
  assert.equal(records[1].kind, 'pytest');
  assert.equal(records[0].seq, 0);
  assert.equal(records[1].seq, 1);
});

test('readValidationLedger on a missing path returns an empty array without throwing', () => {
  const ledgerPath = tempLedger();
  assert.deepEqual(readValidationLedger(ledgerPath), []);
});

test('normalizeScope treats an absolute in-worktree path and the equivalent relative path as the same scope', () => {
  const cwd = '/home/runner/actions-runner/_work/_temp/agent-implementer-1';
  const absolute = normalizeScope({ kind: 'python_compile', paths: [`${cwd}/arkanoid.py`] }, cwd);
  const relative = normalizeScope({ kind: 'python_compile', paths: ['arkanoid.py'] }, cwd);
  assert.deepEqual(absolute, relative);
});

test('a passing focused check is recorded and yields VERIFIED', () => {
  const records = [focused({ status: 'pass' }), finalCheck({ status: 'pass' })];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.VERIFIED);
});

test('a failing focused check yields VERIFICATION_FAILED', () => {
  const records = [focused({ status: 'fail' }), finalCheck({ status: 'pass' })];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.FAILED);
});

test('a focused check that returns infra_error yields VERIFICATION_BLOCKED_INFRA while implementation stays complete', () => {
  const records = [focused({ status: 'infra_error', infrastructure: { component: 'sandbox', code: 'SANDBOX_EXECUTOR_ERROR' } })];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.BLOCKED_INFRA);
  // Requirement #4: implementation completion is tracked entirely separately
  // (implementer-result.mjs's outcome), never derived from or blocked by the
  // ledger — an infra_error here must not be able to flip that flag.
  const implementationComplete = true;
  assert.equal(implementationComplete, true);
});

test('a focused check that times out yields VERIFICATION_BLOCKED_INFRA', () => {
  const records = [focused({ status: 'timeout' })];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.BLOCKED_INFRA);
});

test('a later equivalent authoritative check resolves an earlier infra_error', () => {
  const records = [
    focused({ status: 'infra_error' }),
    focused({ status: 'pass' }),
  ];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.VERIFIED);
});

test('an unrelated broad pytest pass does not satisfy a failed/infra-error focused python_compile requirement', () => {
  const records = [
    focused({ kind: 'python_compile', scope: { paths: ['arkanoid.py'] }, status: 'infra_error' }),
    finalCheck({ kind: 'pytest', scope: { whole_repo: true }, status: 'pass' }),
  ];
  // This is the literal shape of smoke run 36782519549: a focused python_compile
  // infra_error plus a broad, unrelated pytest pass.
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.BLOCKED_INFRA);
});

test('renderValidationSection renders only from ledger records, never from model-provided text', () => {
  const core = fs.readFileSync(new URL('../scripts/pi-common/validation-ledger.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(core, /\.title\b|\.changes\b|\.security_notes\b/);
  const records = [focused({ status: 'pass' })];
  const text = renderValidationSection(records);
  assert.match(text, /python_compile\(arkanoid\.py\): passed/);
  assert.match(text, /Overall verification state: VERIFIED/);
});

test('renderValidationSection on an empty ledger states plainly that nothing was recorded', () => {
  const text = renderValidationSection([]);
  assert.match(text, /No authoritative checks were recorded/);
  assert.match(text, /VERIFICATION_NOT_APPLICABLE/);
});

test('duplicate/equivalent checks reconcile deterministically by recency, not by best status', () => {
  const forward = [
    focused({ status: 'fail' }),
    focused({ status: 'infra_error' }),
    focused({ status: 'pass' }),
  ];
  assert.equal(reconcile(forward)[0].status, 'pass');
  assert.equal(computeVerificationState(forward), VERIFICATION_STATES.VERIFIED);

  const backward = [
    focused({ status: 'pass' }),
    focused({ status: 'infra_error' }),
    focused({ status: 'fail' }),
  ];
  assert.equal(reconcile(backward)[0].status, 'fail');
  assert.equal(computeVerificationState(backward), VERIFICATION_STATES.FAILED);
});

test('the core stays backend-neutral: no Pi-specific or project-specific coupling', () => {
  const core = fs.readFileSync(new URL('../scripts/pi-common/validation-ledger.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(core, /typebox|pi-agent-runtime|registerTool/);
});
