import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preload = path.join(root, 'tests/helpers/reconcile-fake-github.mjs');

function run(mode, { apply = false, automation = 'RUNNING', deadline = 250, http = 1000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reconcile-observability-'));
  const callsFile = path.join(dir, 'requests.jsonl');
  try {
    const result = spawnSync(process.execPath,
      ['--import', preload, 'scripts/pi-reconcile.mjs', ...(apply ? ['--apply'] : [])], {
        cwd: root, encoding: 'utf8', timeout: 4000,
        env: {
          ...process.env, GITHUB_REPOSITORY: 'example/repo',
          GITHUB_TOKEN: 'SECRET_GITHUB_AUTH_TOKEN',
          GITHUB_WORKSPACE: root,
          PI_AUTOMATION_MODE: automation,
          PI_RECONCILE_DEADLINE_MS: String(deadline),
          PI_GITHUB_HTTP_TIMEOUT_MS: String(http),
          PI_RECONCILE_HEARTBEAT_MS: '5',
          PI_RECONCILE_SLOW_MS: '10',
          TEST_RECONCILE_MODE: mode, TEST_RECONCILE_CALLS: callsFile,
        },
      });
    const calls = fs.existsSync(callsFile)
      ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const progress = result.stdout.split('\n')
      .filter(line => line.startsWith('RECONCILE_PROGRESS '))
      .map(line => JSON.parse(line.slice('RECONCILE_PROGRESS '.length)));
    const warnings = result.stderr.split('\n')
      .filter(line => line.startsWith('RECONCILE_WARN '))
      .map(line => JSON.parse(line.slice('RECONCILE_WARN '.length)));
    return { ...result, calls, progress, warnings };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const event = (result, name) => result.progress.find(item => item.event === name);
const warningsOf = (result, name) => result.warnings.filter(item => item.event === name);

function assertRedacted(result) {
  const output = result.stdout + result.stderr;
  for (const secret of ['SECRET_GITHUB_AUTH_TOKEN', 'PRIVATE_RESPONSE_BODY_TOKEN',
    'private-issue-title-', 'example/repo', '?state=all']) {
    assert.equal(output.includes(secret), false, 'log leaked sensitive data: ' + secret);
  }
}

test('fast audit prints first progress, ordered phases and a successful final record', () => {
  const result = run('fast');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.progress[0].event, 'start');
  assert.equal(result.progress[0].mode, 'audit');
  assert.deepEqual(result.progress.filter(x => x.event === 'phase_start').map(x => x.stage),
    ['github-snapshot', 'issue-inspection', 'issue-repairs', 'pr-recovery', 'checkpoint-gc', 'summary']);
  assert.deepEqual(result.progress.filter(x => x.event === 'phase_end').map(x => x.status),
    Array(6).fill('ok'));
  assert.equal(event(result, 'complete').completed_mutations, 0);
  assert.equal(result.calls.some(x => x.method !== 'GET'), false);
  assertRedacted(result);
});

test('multi-page issues report total items, pages and counts without per-issue log spam', () => {
  const result = run('multipage');
  assert.equal(result.status, 0, result.stderr);
  const issues = result.progress.find(x => x.event === 'collection_end' && x.collection === 'issues');
  assert.equal(issues.pages, 2);
  assert.equal(issues.items, 101);
  assert.equal(result.progress.find(x => x.event === 'phase_end' && x.stage === 'issue-inspection').inspected, 101);
  assert.equal(result.calls.filter(x => x.endpoint === '/issues').length, 2);
  assert.ok(result.stdout.split('\n').length < 50, 'unexpected per-record logging');
  assertRedacted(result);
});

test('slow request is visible before it finishes, with safe endpoint/page metadata', () => {
  const result = run('slow');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(warningsOf(result, 'slow_request_pending').some(x =>
    x.endpoint === 'issues' && x.page === 1 && x.duration_ms >= 10));
  assert.ok(warningsOf(result, 'slow_request').some(x => x.endpoint === 'issues' && x.code === 200));
  assert.ok(event(result, 'heartbeat')?.pending_total >= 1);
  assertRedacted(result);
});

test('never-resolving transport hits deadline, exits nonzero and never claims completion', () => {
  const result = run('hung', { deadline: 95, http: 1000 });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(warningsOf(result, 'slow_request_pending').some(x => x.endpoint === 'issues'));
  assert.ok(result.warnings.some(x => x.event === 'failed' && x.cause === 'deadline_exceeded'));
  assert.equal(event(result, 'complete'), undefined);
  assert.equal(result.calls.some(x => x.method !== 'GET'), false);
  assertRedacted(result);
});

test('per-request HTTP timeout is distinct from overall deadline', () => {
  const result = run('hung', { deadline: 250, http: 35 });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(warningsOf(result, 'request_failed').some(x => x.cause === 'timeout'));
  assert.ok(result.progress.some(x => x.event === 'phase_end' && x.cause === 'request_timeout'));
  assert.equal(event(result, 'complete'), undefined);
  assertRedacted(result);
});

test('cooperative cancellation also fails closed', () => {
  const result = run('cancel', { deadline: 75 });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.warnings.some(x => x.event === 'failed' && x.cause === 'deadline_exceeded'));
  assert.equal(event(result, 'complete'), undefined);
  assertRedacted(result);
});

for (const [mode, code] of [['rate429', 429], ['server503', 503]]) {
  test('HTTP ' + code + ' fails snapshot without mutation or leaking response body', () => {
    const result = run(mode, { apply: true });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(warningsOf(result, 'http_error').some(x => x.endpoint === 'issues' && x.code === code));
    assert.ok(result.progress.some(x => x.event === 'phase_end' && x.cause === 'http_' + code));
    assert.equal(result.calls.some(x => x.method !== 'GET'), false);
    assert.equal(event(result, 'complete'), undefined);
    assertRedacted(result);
  });
}

test('partial issue failure reports completed mutations and a retry is safe', () => {
  const failed = run('partial', { apply: true });
  assert.equal(failed.status, 1, failed.stderr);
  const failure = warningsOf(failed, 'mutation_failed').at(-1);
  assert.equal(failure.kind, 'issue');
  assert.equal(failure.number, 2);
  assert.equal(failure.action, 'replace-state');
  assert.equal(failure.cause, 'http_503');
  assert.equal(failure.completed_count, 1);
  assert.deepEqual(failure.recently_completed.map(x => x.number), [1]);
  assert.equal(event(failed, 'complete'), undefined);
  assert.deepEqual(failed.calls.filter(x => x.method === 'PATCH').map(x => x.endpoint),
    ['/issues/1', '/issues/2']);
  assertRedacted(failed);
  const recovered = run('retry', { apply: true });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(event(recovered, 'complete').completed_mutations, 2);
  assert.deepEqual(recovered.calls.filter(x => x.method === 'PATCH').map(x => x.body.labels),
    [['dispatcher:ready'], ['dispatcher:ready']]);
  assertRedacted(recovered);
});

test('live Implementer is never requeued and PAUSED never grants executable ownership', () => {
  const live = run('live', { apply: true });
  assert.equal(live.status, 0, live.stderr);
  assert.deepEqual(live.calls.filter(x => x.method === 'PATCH').map(x => x.endpoint), ['/issues/2']);
  const paused = run('paused', { apply: true, automation: 'PAUSED' });
  assert.equal(paused.status, 0, paused.stderr);
  assert.deepEqual(paused.calls.filter(x => x.method === 'PATCH').map(x => x.body.labels), [[], []]);
  assertRedacted(live);
  assertRedacted(paused);
});
