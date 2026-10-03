import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  consumeUnavailableCapabilityAttempts,
  equivalentIncapableCodingSession,
  incapableCodingSessionRecord,
  recordUnavailableCapabilityAttempt,
} from '../scripts/pi-common/coding-session-capability.mjs';

const CONTRACT = ['write', 'edit', 'read', 'need_more_evidence', 'submit_result', 'undo_mutation'];

test('fork sidecar records each unavailable capability once and is removed when consumed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-capability-'));
  try {
    const file = path.join(dir, 'nested', 'capabilities.json');
    recordUnavailableCapabilityAttempt(file, 'bash');
    recordUnavailableCapabilityAttempt(file, 'bash');
    recordUnavailableCapabilityAttempt(file, 'read');
    assert.deepEqual(consumeUnavailableCapabilityAttempts(file), ['bash', 'read']);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(consumeUnavailableCapabilityAttempts(file), [], 'missing sidecar is no evidence');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"unavailable_tools":');
    assert.deepEqual(consumeUnavailableCapabilityAttempts(file), [], 'malformed sidecar is no evidence');
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only non-submitted forks that attempted tools outside the contract are incapable', () => {
  assert.equal(incapableCodingSessionRecord({ submitted: true, attemptedTools: ['bash'], contractTools: CONTRACT }), null);
  assert.equal(
    incapableCodingSessionRecord({ submitted: false, attemptedTools: ['read'], contractTools: CONTRACT }),
    null,
    'a contract tool hidden in one fork state is not proof of incapability',
  );
  assert.deepEqual(
    incapableCodingSessionRecord({ submitted: false, attemptedTools: ['read', 'bash'], contractTools: CONTRACT, repositoryState: 'a' }),
    { unreachable: ['bash'], contractTools: [...CONTRACT].sort(), repositoryState: 'a' },
  );
});

test('an equivalent retry is recognized until the capability or repository state materially changes', () => {
  const previous = incapableCodingSessionRecord({ submitted: false, attemptedTools: ['bash'], contractTools: CONTRACT, repositoryState: 'a' });
  assert.equal(equivalentIncapableCodingSession(null, { contractTools: CONTRACT, repositoryState: 'a' }), null);
  assert.equal(equivalentIncapableCodingSession(previous, { contractTools: CONTRACT, repositoryState: 'a' }), previous);
  assert.equal(
    equivalentIncapableCodingSession(previous, { contractTools: CONTRACT, repositoryState: null }),
    previous,
    'an unknown fingerprint does not prove a transition',
  );
  assert.equal(equivalentIncapableCodingSession(previous, { contractTools: CONTRACT, repositoryState: 'b' }), null);
  assert.equal(equivalentIncapableCodingSession(previous, { contractTools: [...CONTRACT, 'bash'], repositoryState: 'a' }), null);
});
