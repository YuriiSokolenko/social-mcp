import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('review workflow consumes exact-pair integration status instead of rerunning deterministic checks', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(workflow, /social-mcp\/integration\/\$\{BASE_SHA:0:12\}/);
  assert.match(workflow, /Exact integration CI has not passed/);
  assert.match(workflow, /steps\.checks\.outputs\.ci_passed == 'true'/);
  assert.doesNotMatch(workflow, /pi-await-ci\.mjs/);
  assert.doesNotMatch(workflow, /pytest_exit|ruff_exit|pytest\.log|ruff\.log/);
  assert.doesNotMatch(workflow, /\n\s+pytest(?:\s|>)/);
  assert.doesNotMatch(workflow, /\n\s+ruff check/);
});

test('CI workflow is explicitly dispatched for exact integration pairs', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /^\s*workflow_dispatch:/m);
  assert.match(workflow, /inputs\.target_sha \|\| github\.sha/);
  assert.match(workflow, /integration_base_sha/);
  assert.match(workflow, /actions\/workflows\/pi-auto-merge\.yml\/dispatches/);
});

test('Pi PR Review has a single explicit-dispatch trigger', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /github\.event\.pull_request/);
});

test('implementer and repair delegate scheduling back to the merge gate', () => {
  for (const path of ['.github/workflows/pi-issue-agent.yml', '.github/workflows/pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(path, 'utf8');
    assert.doesNotMatch(workflow, /pi-pr-review\.yml\/dispatches/);
    assert.match(workflow, /pi-auto-merge\.yml\/dispatches/);
  }
});


test('merge gate is explicitly wake-driven and does not fan out from workflow_run completions', () => {
  const gate = fs.readFileSync('.github/workflows/pi-auto-merge.yml', 'utf8');
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(gate, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(gate, /^\s*workflow_run:/m);
  assert.match(review, /Wake merge gate after current review result/);
  assert.match(review, /pi-auto-merge\.yml\/dispatches/);
});


test('review failure fallback refuses a stale dev base as well as a stale head', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(workflow, /CURRENT_BASE=.*git\/ref\/heads\/dev/s);
  assert.match(workflow, /BASE_SHA:-.*CURRENT_BASE/s);
});


test('exact-pair CI result stays successful when only the merge-gate wake fails', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /Integration status is durable; reconciler can wake Merge Gate later/);
});
