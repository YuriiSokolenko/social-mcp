import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TRUSTED_RECOVERY_TOOLS,
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
    incapableCodingSessionRecord({ submitted: false, attemptedTools: ['read', 'bash'], contractTools: CONTRACT, recoveryEpoch: 3 }),
    { unreachable: ['bash'], contractTools: [...CONTRACT].sort(), recoveryEpoch: 3 },
  );
});

test('an equivalent retry is recognized until a trusted recovery or full capability transition', () => {
  const previous = incapableCodingSessionRecord({ submitted: false, attemptedTools: ['bash'], contractTools: CONTRACT, recoveryEpoch: 1 });
  assert.equal(equivalentIncapableCodingSession(null, { contractTools: CONTRACT, recoveryEpoch: 1 }), null);
  assert.deepEqual(equivalentIncapableCodingSession(previous, { contractTools: CONTRACT, recoveryEpoch: 1 }), previous);
  assert.equal(equivalentIncapableCodingSession(previous, { contractTools: CONTRACT, recoveryEpoch: 2 }), null, 'trusted recovery succeeded since');
  assert.equal(equivalentIncapableCodingSession(previous, { contractTools: [...CONTRACT, 'bash'], recoveryEpoch: 1 }), null);
});

test('a partial capability transition keeps the guard for the capabilities that remain unreachable', () => {
  const previous = incapableCodingSessionRecord({
    submitted: false,
    attemptedTools: ['bash', 'some_other_forbidden_tool'],
    contractTools: CONTRACT,
    recoveryEpoch: 0,
  });
  const blocking = equivalentIncapableCodingSession(previous, { contractTools: [...CONTRACT, 'bash'], recoveryEpoch: 0 });
  assert.deepEqual(blocking.unreachable, ['some_other_forbidden_tool']);
  assert.equal(
    equivalentIncapableCodingSession(previous, { contractTools: [...CONTRACT, 'bash', 'some_other_forbidden_tool'], recoveryEpoch: 0 }),
    null,
  );
});

test('trusted recovery transitions are the shell-free cleanup paths only', () => {
  assert.deepEqual([...TRUSTED_RECOVERY_TOOLS].sort(), ['recover_worktree', 'rollback_last_mutation', 'undo_mutation']);
});
