import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readScript } from './helpers/resolved-source.mjs';
import { PRODUCT_CI_STEPS, allowedFiles, infraRetryEndpoint, issueNumber, prCiVerdict } from '../scripts/pi-auto-merge.mjs';

const repo = 'owner/social-mcp';

function parseWorkflow(path) {
  const python = [
    'import json, sys, yaml',
    'with open(sys.argv[1], encoding="utf-8") as fh:',
    '    data = yaml.load(fh, Loader=yaml.BaseLoader)',
    'print(json.dumps(data))',
  ].join('\n');
  const result = spawnSync('python', ['-c', python, path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const pr = {
  state: 'open', draft: false, body: 'Closes #42',
  base: { ref: 'dev', repo: { full_name: repo } },
  head: { ref: 'pi/issue-42', repo: { full_name: repo }, sha: 'abc' },
};

test('only a same-repository Pi PR closing its own issue is eligible', () => {
  assert.equal(issueNumber(pr, repo), 42);
  assert.equal(issueNumber({ ...pr, base: { ...pr.base, ref: 'main' } }, repo), null);
  assert.equal(issueNumber({ ...pr, body: 'Closes #43' }, repo), null);
  assert.equal(issueNumber({ ...pr, head: { ...pr.head, repo: { full_name: 'attacker/fork' } } }, repo), null);
  assert.equal(issueNumber({ ...pr, draft: true }, repo), null);
});

test('Pi cannot change the workflow definitions used for its own merge', () => {
  assert.equal(allowedFiles([{ filename: 'app/server.py' }], 1), true);
  assert.equal(allowedFiles([{ filename: '.github/workflows/ci.yml' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'scripts/pi-auto-merge.mjs' }], 1), false);
  assert.equal(allowedFiles([{ filename: 'app/server.py' }], 2), false);
});

test('merge gate requires successful PR CI for the exact head SHA and classifies terminal failures from trusted step metadata', () => {
  assert.deepEqual(prCiVerdict([], 'abc'), { state: 'pending', run: null });
  assert.equal(prCiVerdict([
    { id: 1, event: 'pull_request', head_sha: 'old', status: 'completed', conclusion: 'success' },
  ], 'abc').state, 'pending');
  assert.equal(prCiVerdict([
    { id: 2, event: 'pull_request', head_sha: 'abc', status: 'in_progress', conclusion: null },
  ], 'abc').state, 'pending');
  assert.equal(prCiVerdict([
    { id: 3, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'failure' },
  ], 'abc', [{
    name: 'test',
    steps: [{ name: 'Pytest', conclusion: 'failure' }],
  }]).state, 'code_failure');
  assert.equal(prCiVerdict([
    { id: 4, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'failure' },
  ], 'abc', [{
    name: 'test',
    steps: [{ name: 'Set up Python', conclusion: 'failure' }],
  }]).state, 'infra_failure');
  assert.equal(prCiVerdict([
    { id: 5, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'cancelled' },
  ], 'abc').state, 'infra_failure');
  assert.equal(prCiVerdict([
    { id: 6, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'timed_out' },
  ], 'abc').state, 'infra_failure');
  assert.equal(prCiVerdict([
    { id: 7, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'success' },
  ], 'abc').state, 'success');
  assert.equal(prCiVerdict([
    { id: 8, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'failure' },
  ], 'abc', [{
    name: 'docker',
    steps: [{ name: 'Build and start isolated Compose environment', conclusion: 'failure' }],
  }]).state, 'infra_failure');

  assert.equal(infraRetryEndpoint({ conclusion: 'failure' }), 'rerun-failed-jobs');
  assert.equal(infraRetryEndpoint({ conclusion: 'cancelled' }), 'rerun');
  assert.equal(infraRetryEndpoint({ conclusion: 'timed_out' }), 'rerun');

  const source = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(source, /actions\/workflows\/.*\/runs\?event=pull_request&head_sha=/);
  assert.match(source, /actions\/runs\/\$\{initial\.run\.id\}\/jobs/);
  assert.match(source, /head_sha=/);
  assert.match(source, /waiting for green PR CI/);
  assert.match(source, /code_failure/);
  assert.match(source, /infra_failure/);
  assert.match(source, /actions\/runs\/\$\{runId\}\/\$\{retryAction\}/);
  assert.match(source, /assigned .*review:changes-requested.*dispatched PR Fix/s);
  assert.match(source, /merge_method: 'squash'/);
  assert.doesNotMatch(source, /integration_base_sha|repair_base_sha|BASE_SHA|base\.object\.sha/);
  assert.doesNotMatch(source, /social-mcp\/(?:integration|integration-conflict|pi-review|repair-)/);
});

test('terminal PR CI wakes merge gate only after workflow completion while dev pushes keep their green-CI wake', () => {
  const workflow = parseWorkflow('.github/workflows/ci.yml');
  const wake = workflow.jobs['wake-merge-gate'];
  assert.deepEqual(wake.needs, ['test', 'docker']);

  const condition = wake.if.replace(/\s+/g, ' ').trim();
  assert.equal(
    condition,
    "always() && github.event_name == 'push' && github.ref == 'refs/heads/dev' && needs.test.result == 'success' && needs.docker.result == 'success'",
  );
  assert.ok(wake.steps.map(step => step.name).includes('Continue merge queue after green dev CI'));

  const terminal = parseWorkflow('.github/workflows/ci-terminal-wake.yml');
  assert.deepEqual(terminal.on.workflow_run.workflows, ['CI']);
  assert.deepEqual(terminal.on.workflow_run.types, ['completed']);

  const prWake = terminal.jobs['wake-pr-merge-gate'];
  assert.equal(
    prWake.if.replace(/\s+/g, ' ').trim(),
    "github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.head_repository.full_name == github.repository",
  );

  const terminalSource = fs.readFileSync('.github/workflows/ci-terminal-wake.yml', 'utf8');
  assert.match(terminalSource, /ref: dev/);
  assert.match(terminalSource, /workflow-dispatch\.mjs pi-auto-merge\.yml/);
  assert.doesNotMatch(terminalSource, /workflow_run\.head_sha|workflow_run\.pull_requests/);
  assert.doesNotMatch(terminalSource, /workflow_run\.conclusion/);
});

test('repairable CI step names are present in the parsed workflow and Docker failures stay conservative', () => {
  const workflow = parseWorkflow('.github/workflows/ci.yml');
  const testStepNames = new Set(workflow.jobs.test.steps.map(step => step.name));
  for (const name of PRODUCT_CI_STEPS) {
    assert.ok(testStepNames.has(name), `PRODUCT_CI_STEPS contains unknown CI step: ${name}`);
  }

  const dockerStepNames = new Set(workflow.jobs.docker.steps.map(step => step.name));
  for (const name of PRODUCT_CI_STEPS) {
    assert.ok(!dockerStepNames.has(name), `Docker step must not be auto-classified as repairable: ${name}`);
  }
});

test('unsafe control-plane PRs leave one explicit human-attention comment', () => {
  const source = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(source, /Human review is required/);
  assert.match(source, /merge-gate:unsafe-pr:/);
  assert.match(source, /comments\.some/);
});

test('agent workflows execute control scripts only from fresh GITHUB_WORKSPACE checkout', () => {
  const workflows = [
    'pi-issue-agent.yml', 'pi-pr-fix.yml', 'pi-pr-review.yml',
    'pi-dispatcher.yml', 'pi-architect.yml', 'pi-triage.yml', 'pi-auto-merge.yml',
  ];
  for (const name of workflows) {
    const source = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.doesNotMatch(source, /(?:node|bash) scripts\//, name);
    assert.doesNotMatch(source, /\/home\/runner|actions-runner\/_work/, name);
    assert.match(source, /GITHUB_WORKSPACE\/scripts\//, name);
  }
});


test('merge gate merges at most one PR per dev CI cycle', () => {
  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(gate, /if \(await processPR\(pr\)\) break/);
  assert.match(ci, /needs: \[test, docker\]/);
  assert.match(ci, /github\.ref == 'refs\/heads\/dev'/);
  assert.match(ci, /workflow-dispatch\.mjs pi-auto-merge\.yml/);
});


test('late merge conflict invalidates review, dispatches PR Fix, and blocks the queue', () => {
  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(gate, /merge conflicts/i);
  assert.match(gate, /merge-gate:conflict-pr:\$\{pr\.number\}:\$\{sha\}/);
  assert.match(gate, /withoutReviewLabels/);
  assert.match(gate, /dispatchWorkflow\('pi-pr-fix\.yml'/);
  assert.match(gate, /return 'blocked'/);
  assert.match(gate, /if \(await processPR\(pr\)\) break/);
});
