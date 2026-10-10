import { test } from 'node:test';

import {
  cancelledCi, concurrentOwnership, dispatchRateLimited, invalidProviderOutput, lostReviewWake,
  mergeGateTransportFaults, rebootOrphanedReviewer, repairDispatchLost, terminalReceipts, triageServerError,
} from './helpers/orchestration-scenarios.mjs';

// Failure, concurrency and recovery matrix (#727). Every scenario injects one
// fault at the fake GitHub boundary or in model/terminal output and asserts
// bounded retries, no split-brain, idempotent re-entry and explicit recovery
// or human escalation. See docs/agent-harness/ORCHESTRATION_COVERAGE.md.

test('GitHub 429 on the Implementer dispatch rolls ownership back and a retry dispatches exactly once', dispatchRateLimited);
test('a concurrent ownership change between read and write fails closed without overwriting the newer owner', concurrentOwnership);
test('GitHub 5xx on a Triage label write fails the batch without partial comments; a retry completes it', triageServerError);
test('GitHub timeout and transport errors abort Merge Gate before merge or CI wake', mergeGateTransportFaults);
test('lost PR Fix dispatch after a product CI failure is recovered once by the Reconciler after grace', repairDispatchLost);
test('cancelled CI gets one bounded retry, duplicate wakes are idempotent, then a human owns it', cancelledCi);
test('missing, truncated or invalid model output changes nothing at Dispatcher, Triage or Architect', invalidProviderOutput);
test('truncated or foreign terminal receipts publish nothing; a matching receipt is accepted', terminalReceipts);
test('#698 N150 reboot: interrupted Reviewer retries once, duplicate delivery is idempotent, repeat escalates; orphaned Implementer keeps its checkpoint', rebootOrphanedReviewer);
test('a lost Reviewer wake is restarted only by the Reconciler and never while a Reviewer is live', lostReviewWake);
