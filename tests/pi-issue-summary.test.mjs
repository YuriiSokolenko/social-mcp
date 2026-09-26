import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('issue summary reports the status-driven merge pipeline', () => {
  const source = fs.readFileSync('scripts/pi-issue-summary.mjs', 'utf8');
  assert.match(source, /social-mcp\/pi-review/);
  assert.match(source, /social-mcp\/integration/);
  assert.match(source, /MERGE GATE/);
  assert.match(source, /pi\/issue-/);
  assert.match(source, /SHA-bound status/);
  assert.match(source, /exact dev\+PR pair status/);
  assert.doesNotMatch(source, /pi:failed|pi:cancelled|pi:blocked/);
});


test('issue summary follows gate order: integration before semantic review', () => {
  const source = fs.readFileSync('scripts/pi-issue-summary.mjs', 'utf8');
  assert.match(source, /integration !== 'success' \? 'CI' : review === 'success' \? 'MERGE GATE' : 'REVIEW'/);
});


test('issue summary paginates commit statuses', () => {
  const source = fs.readFileSync('scripts/pi-issue-summary.mjs', 'utf8');
  assert.match(source, /pages\(.+commits\/.+\/statuses/);
});
