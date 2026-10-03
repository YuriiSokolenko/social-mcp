import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  IMPLEMENTATION_PLANNER_DEADLINE_MS,
  bootstrapFailureFallback,
  preparedImplementationBlock,
  readPreparedImplementation,
  validatePreparedImplementation,
  writePreparedImplementation,
} from '../scripts/pi-common/implementation-planner.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

const prepared = {
  version: 1, status: 'prepared', plan: ['Inspect the module', 'Add the regression test'], complexity: 'trivial',
  evidenceBudget: 1, largeMutation: false, reason: 'One bounded edit', workspaceRoot: '/work/tree', freshBaseCommit: 'deadbeef',
  baseRef: 'origin/dev', layoutHint: null, plannerUsage: { output: 40 }, plannerDurationMs: 900,
};

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-prepared-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'prepared.json');
}

test('the planner hard deadline is exactly 15 minutes and drives the stage config', () => {
  assert.equal(IMPLEMENTATION_PLANNER_DEADLINE_MS, 900000);
  assert.equal(stageConfig('implementer').implementationPlannerTimeoutMs, IMPLEMENTATION_PLANNER_DEADLINE_MS);
});

test('PreparedImplementation artifact round-trips and a missing file means no bootstrap ran', (t) => {
  const file = tempFile(t);
  assert.equal(readPreparedImplementation(file), null);
  assert.equal(readPreparedImplementation(undefined), null);
  writePreparedImplementation(file, prepared);
  assert.deepEqual(readPreparedImplementation(file), prepared);
});

test('malformed artifacts fail closed instead of being applied', (t) => {
  const file = tempFile(t);
  for (const bad of [
    { ...prepared, version: 2 },
    { ...prepared, status: 'unknown' },
    { ...prepared, plan: [] },
    { ...prepared, complexity: 'medium' },
    { ...prepared, evidenceBudget: 9 },
    { ...prepared, largeMutation: 'yes' },
    { ...prepared, reason: '' },
    { version: 1, status: 'fallback', reason: 'x' },
  ]) {
    assert.throws(() => validatePreparedImplementation(bad), /./, JSON.stringify(bad).slice(0, 60));
    assert.throws(() => writePreparedImplementation(file, bad));
    assert.equal(fs.existsSync(file), false, 'an invalid artifact is never written');
  }
  fs.writeFileSync(file, '{"version":1,');
  assert.throws(() => readPreparedImplementation(file));
});

test('the prepared block carries only the normalized result, with provenance and no preparation tool', () => {
  const block = preparedImplementationBlock(prepared);
  assert.match(block, /1\. Inspect the module\n2\. Add the regression test/);
  assert.match(block, /Complexity: trivial — One bounded edit/);
  assert.match(block, /Evidence budget: 1/);
  assert.match(block, /Large mutation: normal mutation budget/);
  assert.match(block, /origin\/dev at deadbeef/);
  assert.match(block, /LSP workspace root: \/work\/tree/);
  assert.doesNotMatch(block, /prepare_implementation|structured_output|REPAIR|usage|plannerDurationMs/);
  assert.match(preparedImplementationBlock({ ...prepared, largeMutation: true }, { largeMutationArmed: true }), /auto-arm one-shot elevated mutation budget/);
});

test('the fallback block states preparation is already resolved and names the failure class', () => {
  const fallback = bootstrapFailureFallback('/work/tree', 'pi exited 3', { PI_IMPLEMENTER_START_COMMIT: 'deadbeef' });
  validatePreparedImplementation(fallback);
  assert.equal(fallback.status, 'fallback');
  assert.equal(fallback.failureClass, 'bootstrap_process_failure');
  const block = preparedImplementationBlock(fallback);
  assert.match(block, /PREPARATION_FALLBACK/);
  assert.match(block, /bootstrap_process_failure/);
  assert.match(block, /nothing to prepare or retry/);
  assert.match(block, /origin\/dev at deadbeef/);
  assert.doesNotMatch(block, /prepare_implementation/);
});
