import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { nextResponseBudgetLevel, RESPONSE_BUDGETS } from '../scripts/pi-common/response-budget-policy.mjs';

test('shared response budgets are SHORT 2048, NORMAL 4096, DEEP 8192', () => {
  assert.deepEqual(RESPONSE_BUDGETS, {
    short: 2048,
    normal: 4096,
    deep: 8192,
  });
});

test('a response below its ceiling resets the next response to SHORT', () => {
  assert.equal(nextResponseBudgetLevel('short', 2047), 'short');
  assert.equal(nextResponseBudgetLevel('normal', 4095), 'short');
  assert.equal(nextResponseBudgetLevel('deep', 8191), 'short');
});

test('ceiling hits without concrete progress stay SHORT instead of rewarding runaway reasoning', () => {
  assert.equal(nextResponseBudgetLevel('short', 2048), 'short');
  assert.equal(nextResponseBudgetLevel('normal', 4096), 'short');
  assert.equal(nextResponseBudgetLevel('deep', 8192), 'short');
});

test('a ceiling hit promotes exactly one level only after concrete action progress', () => {
  const progress = { madeProgress: true };
  assert.equal(nextResponseBudgetLevel('short', 2048, RESPONSE_BUDGETS, progress), 'normal');
  assert.equal(nextResponseBudgetLevel('normal', 4096, RESPONSE_BUDGETS, progress), 'deep');
  assert.equal(nextResponseBudgetLevel('deep', 8192, RESPONSE_BUDGETS, progress), 'short');
});

test('runtime extension keeps explicit overrides one-response-only and fixed mode disables escalation', () => {
  const extension = fs.readFileSync('scripts/pi-response-budget.mjs', 'utf8');
  assert.match(extension, /explicitNextResponse = true/);
  assert.match(extension, /if \(explicitNextResponse\)/);
  assert.match(extension, /progressTools = new Set/);
  assert.match(extension, /madeProgress: turnMadeProgress/);
  assert.match(extension, /nextResponseBudgetLevel\(turnLevel, outputTokens, configuredBudgets, \{ madeProgress: turnMadeProgress \}\)/);
  assert.match(extension, /if \(fixedMaxTokens\) return/);

  const triage = fs.readFileSync('.github/workflows/pi-triage.yml', 'utf8');
  assert.match(triage, /PI_FIXED_RESPONSE_MAX_TOKENS: '1000'/);
});
