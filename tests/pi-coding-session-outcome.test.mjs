import test from 'node:test';
import assert from 'node:assert/strict';

import { codingSessionRecoveryReceipt, normalizeCodingSessionOutcome } from '../scripts/pi-common/coding-session-outcome.mjs';

test('#402 earlier tool error is recovered by a trusted final submission', () => {
  assert.deepEqual(
    normalizeCodingSessionOutcome({
      submitted: true,
      outcome: 'changed',
      sessionError: new Error('read failed: unavailable tool'),
    }),
    {
      submitted: true,
      successful_final_submission: true,
      outcome: 'changed',
      status: 'ok',
      recovered_errors: ['read failed: unavailable tool'],
      unresolved_terminal_error: null,
      receipt_error: null,
    },
  );
});

test('#396 failed submit followed by valid retry succeeds while failed-only stays unresolved', () => {
  const recovered = normalizeCodingSessionOutcome({
    submitted: true,
    outcome: 'changed',
    sessionError: new Error('submit_result file-set mismatch'),
  });
  assert.equal(recovered.successful_final_submission, true);
  assert.deepEqual(recovered.recovered_errors, ['submit_result file-set mismatch']);
  assert.equal(recovered.unresolved_terminal_error, null);

  const failedOnly = normalizeCodingSessionOutcome({
    submitted: false,
    sessionError: new Error('submit_result file-set mismatch'),
  });
  assert.equal(failedOnly.successful_final_submission, false);
  assert.equal(failedOnly.status, 'error');
  assert.equal(failedOnly.unresolved_terminal_error, 'submit_result file-set mismatch');
});

test('coding-session terminal semantics preserve changed, already_satisfied, and blocked separately', () => {
  const changed = normalizeCodingSessionOutcome({ submitted: true, outcome: 'changed' });
  const alreadySatisfied = normalizeCodingSessionOutcome({ submitted: true, outcome: 'already_satisfied' });
  const blocked = normalizeCodingSessionOutcome({ submitted: true, outcome: 'blocked' });
  assert.equal(changed.successful_final_submission, true);
  assert.equal(alreadySatisfied.successful_final_submission, true);
  assert.equal(alreadySatisfied.outcome, 'already_satisfied');
  assert.equal(blocked.submitted, true, 'the terminal submission itself is valid');
  assert.equal(blocked.successful_final_submission, false, 'blocked is not implementation success');
  assert.equal(blocked.status, 'blocked');
});

test('an invalid receipt is recoverable incomplete state, not a terminal session error', () => {
  const result = normalizeCodingSessionOutcome({
    submitted: false,
    receiptError: new Error('terminal_receipt_candidate_mismatch'),
  });
  assert.equal(result.successful_final_submission, false);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.unresolved_terminal_error, null);
  assert.equal(result.receipt_error, 'terminal_receipt_candidate_mismatch');
});


test('#481 recovery receipt admits only runtime-derived accepted changed paths and validation state', () => {
  assert.deepEqual(codingSessionRecoveryReceipt({
    changedFiles: ['src/game.py', 'scratch.txt', 'tests/test_game.py'],
    acceptedScope: {
      accepted: [{ path: 'src/game.py' }, { path: 'tests/test_game.py' }],
      temporary: [{ path: 'scratch.txt' }],
    },
    preparedOutputs: { source: true, test: true },
    lastValidation: {
      kind: 'pytest',
      status: 'infra_error',
      infrastructure_code: 'CHECK_ENV',
      summary: 'model prose must not cross',
    },
  }), {
    coding_session_status: 'aborted',
    changed_publishable_paths: ['src/game.py', 'tests/test_game.py'],
    prepared_outputs_present: { source: true, test: true },
    last_validation: { kind: 'pytest', status: 'infra_error', infrastructure_code: 'CHECK_ENV' },
    remaining_terminal_obligation: 'validation',
  });
});


test('#481 recovery receipt keeps trusted child worktree and validation state compact', () => {
  assert.deepEqual(
    codingSessionRecoveryReceipt({
      changedFiles: [
        'src/social_mcp/diagnostics/smoke_connect_four.py',
        'tests/test_smoke_connect_four.py',
        'stray.tmp',
      ],
      acceptedScope: {
        accepted: [
          { path: 'src/social_mcp/diagnostics/smoke_connect_four.py', rationale: 'source' },
          { path: 'tests/test_smoke_connect_four.py', rationale: 'test' },
        ],
      },
      preparedOutputs: { source: true, test: true },
      lastValidation: { kind: 'pytest', status: 'infra_error', infrastructure_code: 'CHECK_ENV' },
    }),
    {
      coding_session_status: 'aborted',
      changed_publishable_paths: [
        'src/social_mcp/diagnostics/smoke_connect_four.py',
        'tests/test_smoke_connect_four.py',
      ],
      prepared_outputs_present: { source: true, test: true },
      last_validation: { kind: 'pytest', status: 'infra_error', infrastructure_code: 'CHECK_ENV' },
      remaining_terminal_obligation: 'validation',
    },
  );
});

test('#481 complete prepared outputs without a passing validation still require validation', () => {
  const missingValidation = codingSessionRecoveryReceipt({
    changedFiles: ['src/a.py', 'tests/test_a.py'],
    acceptedScope: { accepted: [{ path: 'src/a.py' }, { path: 'tests/test_a.py' }] },
    preparedOutputs: { source: true, test: true },
    lastValidation: null,
  });
  assert.equal(missingValidation.remaining_terminal_obligation, 'validation');

  const passed = codingSessionRecoveryReceipt({
    changedFiles: ['src/a.py', 'tests/test_a.py'],
    acceptedScope: { accepted: [{ path: 'src/a.py' }, { path: 'tests/test_a.py' }] },
    preparedOutputs: { source: true, test: true },
    lastValidation: { kind: 'pytest', status: 'pass', infrastructure_code: null },
  });
  assert.equal(passed.remaining_terminal_obligation, 'terminal_submission');
});
