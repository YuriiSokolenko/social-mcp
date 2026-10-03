import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCodingSessionOutcome } from '../scripts/pi-common/coding-session-outcome.mjs';

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
