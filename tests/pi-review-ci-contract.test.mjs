import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('review workflow consumes SHA-bound CI instead of rerunning Python checks', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(workflow, /pi-await-ci\.mjs "\$HEAD_SHA" "\$HEAD_REF"/);
  assert.doesNotMatch(workflow, /pytest_exit|ruff_exit|pytest\.log|ruff\.log/);
  assert.doesNotMatch(workflow, /\n\s+pytest(?:\s|>)/);
  assert.doesNotMatch(workflow, /\n\s+ruff check/);
  assert.match(workflow, /steps\.checks\.outputs\.ci_passed == 'true'/);
});
