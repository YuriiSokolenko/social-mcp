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


test('CI workflow avoids approval-gated pull_request runs for bot-authored Pi PRs', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /^\s*workflow_dispatch:/m);
  assert.match(workflow, /inputs\.target_sha \|\| github\.sha/);
});


test('Pi PR Review has a single explicit-dispatch trigger', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /github\.event\.pull_request/);
});


test('implementer and repair delegate review scheduling to the merge gate', () => {
  for (const path of ['.github/workflows/pi-issue-agent.yml', '.github/workflows/pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(path, 'utf8');
    assert.doesNotMatch(workflow, /pi-pr-review\.yml\/dispatches/);
    assert.match(workflow, /pi-auto-merge\.yml\/dispatches/);
  }
});
