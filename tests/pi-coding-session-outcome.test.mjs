import test from 'node:test';
import assert from 'node:assert/strict';

import { codingSessionRecoveryReceipt, normalizeCodingSessionOutcome } from '../scripts/pi-common/coding-session-outcome.mjs';

test('#402 earlier tool error is recovered by a trusted final submission', () => {
  assert.deepEqual(
    normalizeCodingSessionOutcome({
      submitted: true,
      sessionError: new Error('read failed: unavailable tool'),
    }),
    {
      submitted: true,
      successful_final_submission: true,
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
