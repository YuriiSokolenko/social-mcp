import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readScript } from './helpers/resolved-source.mjs';
import { PRODUCT_CI_STEPS, allowedFiles, devCiVerdict, infraRetryEndpoint, issueNumber, prCiVerdict } from '../scripts/pi-auto-merge.mjs';

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
  ], 'abc', [{ conclusion: 'success' }]).state, 'success');
  assert.equal(prCiVerdict([
    { id: 9, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'success' },
  ], 'abc', []).state, 'infra_failure');
  assert.equal(prCiVerdict([
    { id: 10, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'action_required' },
  ], 'abc').state, 'infra_failure');
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

test('current dev CI must be green before a merge attempt, including explicit post-merge dispatches', () => {
  assert.deepEqual(devCiVerdict([], 'dev-sha'), { state: 'pending', run: null });
  assert.equal(devCiVerdict([
    { id: 1, event: 'push', head_sha: 'dev-old', status: 'completed', conclusion: 'success' },
  ], 'dev-sha').state, 'pending');
  assert.equal(devCiVerdict([
    { id: 2, event: 'workflow_dispatch', head_sha: 'dev-sha', status: 'in_progress', conclusion: null },
  ], 'dev-sha').state, 'pending');
  assert.equal(devCiVerdict([
    { id: 3, event: 'workflow_dispatch', head_sha: 'dev-sha', status: 'completed', conclusion: 'failure' },
  ], 'dev-sha').state, 'failed');
  assert.equal(devCiVerdict([
    { id: 4, event: 'workflow_dispatch', head_sha: 'dev-sha', status: 'completed', conclusion: 'success' },
  ], 'dev-sha').state, 'success');
  assert.equal(devCiVerdict([
    { id: 5, event: 'pull_request', head_sha: 'dev-sha', status: 'completed', conclusion: 'success' },
  ], 'dev-sha').state, 'pending');

  const source = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  assert.match(source, /git\/ref\/heads/);
  assert.match(source, /runs\?branch=.*&head_sha=/);
  assert.match(source, /\['push', 'workflow_dispatch'\]/);
  assert.match(source, /waiting for green .* CI/);
});

test('terminal PR CI wakes merge gate only after workflow completion while push and explicit dev CI keep their green-CI wake', () => {
  const workflow = parseWorkflow('.github/workflows/ci.yml');
  const wake = workflow.jobs['wake-merge-gate'];
  assert.deepEqual(wake.needs, ['test', 'docker']);

  const condition = wake.if.replace(/\s+/g, ' ').trim();
  assert.equal(
    condition,
    "always() && contains(fromJSON('[\"push\",\"workflow_dispatch\"]'), github.event_name) && github.ref == 'refs/heads/dev' && needs.test.result == 'success' && needs.docker.result == 'success'",
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


test('merge gate merges at most one PR per dev CI cycle and explicitly starts the next cycle', () => {
  const gate = readScript('scripts/pi-auto-merge.mjs', 'utf8');
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(gate, /if \(await processPR\(pr\)\) break/);
  assert.match(gate, /const devCi = await loadDevCiVerdict\(\)/);
  assert.match(gate, /if \(devCi\.state !== 'success'\)/);
  assert.match(gate, /return 'blocked'/);
  assert.match(gate, /await dispatchWorkflow\('ci\.yml'\)/);
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

test('#401 missing rw snapshot and #402 setup failure stay infrastructure with one retry and no PR Fix', () => {
  const run = { id: 37069737717, event: 'pull_request', head_sha: 'abc', status: 'completed', conclusion: 'failure', run_attempt: 2 };
  const jobs = [{ name: 'test', conclusion: 'success', steps: [{ name: 'Pytest', conclusion: 'success' }] },
    { name: 'docker', conclusion: 'failure', steps: [{ name: 'Set up BuildKit', conclusion: 'failure',
      output: 'Error response from daemon: failed to retrieve container list: rw layer snapshot not found for container 37d2be901d24' }] }];
  assert.equal(prCiVerdict([run], 'abc', jobs).state, 'infra_failure');
  assert.equal(infraRetryEndpoint(run), 'rerun-failed-jobs');
  assert.equal(prCiVerdict([{ ...run, id: 37069129733 }], 'abc', [{ name: 'docker', steps: [{ name: 'Set up job', conclusion: 'failure' }] }]).state, 'infra_failure');
});

test('optional Docker diagnostics fail without blocking the remaining CI setup', () => {
  const step = parseWorkflow('.github/workflows/ci.yml').jobs.docker.steps.find(step => step.name === 'Set up BuildKit');
  const diagnostics = step.run.split('\n').filter(line => /docker (system df|buildx du)/.test(line)).join('\n');
  const result = spawnSync('bash', ['-e', '-c', 'docker() { return 1; };\n' + diagnostics + '\nprintf reached-build'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /warning/); assert.match(result.stdout, /reached-build/);
});

test('general worker checks daemon snapshots before registering, while Pi workers skip Docker access', () => {
  const source = fs.readFileSync('infra/github-runner-autoscaler/worker-entrypoint.sh', 'utf8');
  const start = source.indexOf('# Best-effort durable evidence');
  assert.ok(start > 0);
  const end = source.indexOf('\ncd "${RUNNER_HOME}/actions-runner"', start);
  assert.ok(end > start);
  const health = source.slice(start, end);
  const script = 'timeout() { shift; "$@"; }; sleep() { :; }; docker() { if [[ "$*" == "system df" ]]; then echo "rw layer snapshot not found" >&2; return 1; fi; };\n' + health + '\necho registered';
  const general = spawnSync('bash', ['-eu', '-c', script], { encoding: 'utf8', env: { ...process.env, RUNNER_LABELS: 'n150,general' } });
  assert.equal(general.status, 1);
  assert.match(general.stderr, /infra_error DOCKER_METADATA_CORRUPTION/);
  assert.doesNotMatch(general.stdout, /registered/);
  const pi = spawnSync('bash', ['-eu', '-c', script], { encoding: 'utf8', env: { ...process.env, RUNNER_LABELS: 'n150,pi-agent' } });
  assert.equal(pi.status, 0, pi.stderr);
  assert.match(pi.stdout, /registered/);
});
