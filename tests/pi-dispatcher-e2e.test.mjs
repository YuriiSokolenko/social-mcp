import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// End-to-end coverage for pi-dispatcher.mjs's network-bound prepare/apply
// flow (scripts/pi-dispatcher.mjs main()/snapshot()), which the pure-logic
// unit tests in pi-dispatcher.test.mjs deliberately do not exercise. These
// tests spawn the real script with a stubbed global.fetch acting as an
// in-memory GitHub API, matching the pattern already used for
// pi-usage-collect.test.mjs.

const taskBody = (priority, deps = []) =>
  `## Task metadata\nPriority: ${priority}\nDepends on: [${deps.map(d => `#${d}`).join(', ')}]\n\n## Goal\nDo the thing.`;

function writeMock(mockFile, storeFile) {
  writeFileSync(mockFile, `
    import { readFileSync, writeFileSync } from 'node:fs';
    const storeFile = ${JSON.stringify(storeFile)};
    function load() { return JSON.parse(readFileSync(storeFile, 'utf8')); }
    function save(store) { writeFileSync(storeFile, JSON.stringify(store)); }

    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const { pathname } = new URL(url);
      const store = load();

      if (method === 'POST' && pathname.endsWith('/labels')) {
        return new Response(null, { status: 201 });
      }
      if (method === 'GET' && pathname.endsWith('/issues')) {
        return Response.json(Object.values(store.issues));
      }
      if (method === 'GET' && pathname.endsWith('/pulls')) {
        return Response.json(store.prs ?? []);
      }
      if (method === 'GET' && /\\/actions\\/runs$/.test(pathname)) {
        return Response.json({ workflow_runs: [] });
      }
      const issueMatch = /\\/issues\\/(\\d+)$/.exec(pathname);
      if (issueMatch) {
        const number = Number(issueMatch[1]);
        if (method === 'GET') {
          const issue = store.issues[number];
          if (!issue) return new Response('not found', { status: 404 });
          return Response.json(issue);
        }
        if (method === 'PATCH') {
          const body = JSON.parse(options.body);
          store.issues[number].labels = body.labels.map(name => ({ name }));
          save(store);
          return Response.json(store.issues[number]);
        }
      }
      const dispatchMatch = /\\/actions\\/workflows\\/([^/]+)\\/dispatches$/.exec(pathname);
      if (dispatchMatch && method === 'POST') {
        const workflow = dispatchMatch[1];
        const body = JSON.parse(options.body);
        if (store.failDispatch && store.failDispatch === workflow) {
          return new Response('boom', { status: 500 });
        }
        store.dispatched = store.dispatched ?? [];
        store.dispatched.push({ workflow, inputs: body.inputs });
        save(store);
        return new Response(null, { status: 204 });
      }
      throw new Error('Unexpected ' + method + ' ' + url);
    };
  `);
}

function run(args, storeFile) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-dispatcher-'));
  const mockFile = join(dir, 'mock.mjs');
  writeMock(mockFile, storeFile);
  return spawnSync(process.execPath, ['--import', pathToFileURL(mockFile).href, 'scripts/pi-dispatcher.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'test/repo', GITHUB_TOKEN: 'synthetic-token' },
  });
}

test('prepare writes eligible candidates, skips blocked/dependency-pending issues, and reports active work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-dispatcher-'));
  const storeFile = join(dir, 'store.json');
  const outFile = join(dir, 'context.json');
  writeFileSync(storeFile, JSON.stringify({
    issues: {
      10: { number: 10, state: 'open', title: 'Fix A', body: taskBody('P1'), labels: [{ name: 'dispatcher:ready' }] },
      11: { number: 11, state: 'open', title: 'In flight', body: taskBody('P1'), labels: [{ name: 'pi:ready' }] },
      12: { number: 12, state: 'open', title: 'Blocked on #99', body: taskBody('P1', [99]), labels: [{ name: 'dispatcher:ready' }] },
      99: { number: 99, state: 'open', title: 'Dependency not done', body: taskBody('P1'), labels: [] },
    },
    prs: [],
  }));

  const result = run(['prepare', outFile], storeFile);
  assert.equal(result.status, 0, result.stderr);

  const context = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.deepEqual(context.active, [11]);
  assert.deepEqual(context.candidates.map(c => c.issue), [10]);
  assert.equal(context.skipped.length, 1);
  assert.equal(context.skipped[0].issue, 12);
  assert.match(context.skipped[0].reason, /dependency #99 is not completed/);
  assert.ok(context.queue, 'prepare includes queue context');
  assert.match(result.stdout, /1 active, 1 ready candidates/);
});

test('apply dispatches IMPLEMENT to Implementer and ARCHITECT to Architect, updating pipeline state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-dispatcher-'));
  const storeFile = join(dir, 'store.json');
  const jsonlFile = join(dir, 'result.jsonl');
  writeFileSync(storeFile, JSON.stringify({
    issues: {
      10: { number: 10, state: 'open', title: 'Fix A', body: taskBody('P1'), labels: [{ name: 'dispatcher:ready' }] },
      20: { number: 20, state: 'open', title: 'Split me', body: taskBody('P1'), labels: [{ name: 'dispatcher:ready' }] },
    },
    prs: [],
  }));
  const classifications = { classifications: [
    { issue: 10, decision: 'IMPLEMENT' },
    { issue: 20, decision: 'ARCHITECT' },
  ] };
  writeFileSync(jsonlFile, JSON.stringify({
    type: 'entry_appended',
    entry: { type: 'custom', customType: 'dispatcher-result', data: classifications },
  }));

  const result = run(['apply', jsonlFile], storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dispatched #10/);
  assert.match(result.stdout, /Sent #20 to Architect/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.deepEqual(store.issues[10].labels.map(l => l.name), ['pi:ready']);
  assert.deepEqual(store.issues[20].labels.map(l => l.name), ['architect:ready']);
  assert.deepEqual(store.dispatched, [
    { workflow: 'pi-issue-agent.yml', inputs: { issue_number: '10', dispatch_mode: 'dispatcher' } },
    { workflow: 'pi-architect.yml', inputs: { issue_number: '20' } },
  ]);
});

test('apply rolls back architect:ready when the explicit Architect dispatch fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-dispatcher-'));
  const storeFile = join(dir, 'store.json');
  const jsonlFile = join(dir, 'result.jsonl');
  writeFileSync(storeFile, JSON.stringify({
    issues: {
      30: { number: 30, state: 'open', title: 'Split me', body: taskBody('P1'), labels: [{ name: 'dispatcher:ready' }] },
    },
    prs: [],
    failDispatch: 'pi-architect.yml',
  }));
  writeFileSync(jsonlFile, JSON.stringify({
    type: 'entry_appended',
    entry: { type: 'custom', customType: 'dispatcher-result', data: { classifications: [{ issue: 30, decision: 'ARCHITECT' }] } },
  }));

  const result = run(['apply', jsonlFile], storeFile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /500/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  // Rolled back to dispatcher:ready rather than left stranded on architect:ready.
  assert.deepEqual(store.issues[30].labels.map(l => l.name), ['dispatcher:ready']);
});
