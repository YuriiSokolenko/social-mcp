import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// End-to-end coverage for pi-architect.mjs's network-bound prepare()/publish()
// flow (including createSplitChildren()/publishSplit()), which the
// pure-logic unit tests in pi-architect.test.mjs deliberately do not
// exercise.

const taskBody = (goal, priority = 'P1', deps = []) =>
  `## Task metadata\nPriority: ${priority}\nDepends on: [${deps.map(d => `#${d}`).join(', ')}]\n\n## Goal\n${goal}\n\n## Acceptance criteria\n- Deliver the requested outcome.\n- Keep the change independently reviewable.\n- Add focused validation for the behavior.`;

function writeMock(mockFile, storeFile) {
  writeFileSync(mockFile, `
    import { readFileSync, writeFileSync } from 'node:fs';
    const storeFile = ${JSON.stringify(storeFile)};
    function load() { return JSON.parse(readFileSync(storeFile, 'utf8')); }
    function save(store) { writeFileSync(storeFile, JSON.stringify(store)); }

    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const { pathname, searchParams, search } = new URL(url);
      const store = load();

      if (method === 'POST' && pathname.endsWith('/labels')) {
        return new Response(null, { status: 201 });
      }
      if (method === 'GET' && /\\/actions\\/runs$/.test(pathname)) {
        return Response.json({ workflow_runs: [] });
      }
      if (method === 'GET' && pathname.endsWith('/pulls')) {
        store.pullQueries = [...(store.pullQueries ?? []), { base: searchParams.get('base'), raw: search }];
        save(store);
        return Response.json((store.prs ?? []).filter(pr => pr.base?.ref === searchParams.get('base')));
      }
      const commentsMatch = /\\/issues\\/(\\d+)\\/comments$/.exec(pathname);
      if (commentsMatch && method === 'POST') {
        const number = Number(commentsMatch[1]);
        const body = JSON.parse(options.body);
        store.issues[number].comments = store.issues[number].comments ?? [];
        store.issues[number].comments.push({ body: body.body });
        save(store);
        return Response.json({});
      }
      if (method === 'GET' && pathname.endsWith('/issues')) {
        // allIssues() paginates '/issues?state=all&per_page=100&page=N'; a
        // single short page ends pagination here.
        return Response.json(Object.values(store.issues));
      }
      if (method === 'POST' && pathname.endsWith('/issues')) {
        const body = JSON.parse(options.body);
        const number = store.nextId++;
        store.issues[number] = { number, state: 'open', title: body.title, body: body.body, labels: [] };
        save(store);
        return Response.json(store.issues[number]);
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
          if (body.labels) store.issues[number].labels = body.labels.map(name => ({ name }));
          if (body.body !== undefined) store.issues[number].body = body.body;
          if (body.title !== undefined) store.issues[number].title = body.title;
          save(store);
          return Response.json(store.issues[number]);
        }
      }
      throw new Error('Unexpected ' + method + ' ' + url);
    };
  `);
}

function run(args, storeFile, { configFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-architect-'));
  const mockFile = join(dir, 'mock.mjs');
  writeMock(mockFile, storeFile);
  return spawnSync(process.execPath, ['--import', pathToFileURL(mockFile).href, 'scripts/pi-architect.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'test/repo', GITHUB_TOKEN: 'synthetic-token',
      ...(configFile ? { AGENT_HARNESS_CONFIG: configFile } : {}) },
  });
}

test('prepare + publish "keep" comments, marks dispatcher:ready, and drops architect:ready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-architect-'));
  const storeFile = join(dir, 'store.json');
  writeFileSync(storeFile, JSON.stringify({
    nextId: 100,
    issues: {
      42: { number: 42, state: 'open', title: 'Already well-scoped', body: taskBody('Ship the thing.'), labels: [{ name: 'architect:ready' }] },
    },
  }));

  const contextFile = join(dir, 'context.json');
  const prepareResult = run(['prepare', '42', contextFile], storeFile);
  assert.equal(prepareResult.status, 0, prepareResult.stderr);
  const context = JSON.parse(readFileSync(contextFile, 'utf8'));
  assert.equal(context.number, 42);
  assert.equal(context.was_dispatcher_ready, false);

  const jsonlFile = join(dir, 'result.jsonl');
  const plan = { parent_issue: 42, action: 'keep', reason: 'Scope is already tight and dependencies are correct.' };
  writeFileSync(jsonlFile, JSON.stringify({
    type: 'entry_appended', entry: { type: 'custom', customType: 'architect-result', data: plan },
  }));

  const publishResult = run(['publish', '42', jsonlFile, contextFile], storeFile);
  assert.equal(publishResult.status, 0, publishResult.stderr);
  assert.match(publishResult.stdout, /Reviewed #42: keep/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.deepEqual(store.issues[42].labels.map(l => l.name), ['dispatcher:ready']);
  assert.equal(store.issues[42].comments.length, 1);
  assert.deepEqual(store.pullQueries.map(query => query.base), ['dev']);
  assert.match(store.issues[42].comments[0].body, /Pi Architect review: \*\*keep\*\*/);
});

test('prepare uses configured PR base and includes the matching open PR in queue context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-architect-'));
  const storeFile = join(dir, 'store.json');
  const configFile = join(dir, 'config.json');
  const config = JSON.parse(readFileSync('.agent-harness.json', 'utf8'));
  config.git.defaultBranch = 'release/v2';
  // The temporary fixture has no src/ tree for package-root validation.
  config.checks.packageRoots.canonicalRoots = [];
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(storeFile, JSON.stringify({
    nextId: 100,
    issues: {
      42: { number: 42, state: 'open', title: 'Awaiting planning',
        body: taskBody('Prepare the queue.'), labels: [{ name: 'architect:ready' }] },
    },
    prs: [
      { number: 77, title: 'Release PR', draft: false, base: { ref: 'release/v2' },
        head: { ref: 'pi/issue-42', sha: 'abc', repo: { full_name: 'test/repo' } }, labels: [] },
      { number: 78, title: 'Other branch PR', draft: false, base: { ref: 'dev' },
        head: { ref: 'pi/issue-43', sha: 'def', repo: { full_name: 'test/repo' } }, labels: [] },
    ],
  }));

  const contextFile = join(dir, 'context.json');
  const result = run(['prepare', '42', contextFile], storeFile, { configFile });
  assert.equal(result.status, 0, result.stderr);
  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.deepEqual(store.pullQueries.map(query => query.base), ['release/v2']);
  assert.match(store.pullQueries[0].raw, /(?:^|[?&])base=release%2Fv2(?:&|$)/);
  const context = JSON.parse(readFileSync(contextFile, 'utf8'));
  assert.deepEqual(context.queue.open_prs.map(pr => ({ number: pr.number, issue: pr.issue })),
    [{ number: 77, issue: 42 }]);
});

test('prepare + publish "split" creates ordered children and exposes them to Dispatcher', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-architect-'));
  const storeFile = join(dir, 'store.json');
  writeFileSync(storeFile, JSON.stringify({
    nextId: 100,
    issues: {
      50: { number: 50, state: 'open', title: 'Big feature', body: taskBody('Too much for one PR.'), labels: [{ name: 'architect:ready' }] },
    },
  }));

  const contextFile = join(dir, 'context.json');
  const prepareResult = run(['prepare', '50', contextFile], storeFile);
  assert.equal(prepareResult.status, 0, prepareResult.stderr);

  const longBody = '## Goal\nDefine one independently mergeable slice of the feature.\n\n' +
    '## Acceptance criteria\n- Define the stable behavior for this slice.\n- Cover compatibility with focused tests.\n- Keep unrelated modules unchanged.\n\n' +
    '## Out of scope\nDo not implement adjacent slices.';
  const plan = {
    parent_issue: 50,
    action: 'split',
    steps: [
      { key: 'schema', kind: 'contract', priority: 'P1', title: 'Define the schema contract for issue 50', body: longBody, depends_on: [] },
      { key: 'feature', kind: 'implementation', priority: 'P1', title: 'Implement the feature behind the schema', body: longBody, depends_on: ['schema'] },
    ],
  };
  const jsonlFile = join(dir, 'result.jsonl');
  writeFileSync(jsonlFile, JSON.stringify({
    type: 'entry_appended', entry: { type: 'custom', customType: 'architect-result', data: plan },
  }));

  const publishResult = run(['publish', '50', jsonlFile, contextFile], storeFile);
  assert.equal(publishResult.status, 0, publishResult.stderr);
  assert.match(publishResult.stdout, /Split #50 into #100, #101/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.deepEqual(store.issues[50].labels.map(l => l.name).sort(), ['architect:epic']);
  assert.match(store.issues[50].body, /<!-- architect-children:100,101 -->/);
  assert.deepEqual(store.issues[100].labels.map(l => l.name), ['dispatcher:ready']);
  assert.deepEqual(store.issues[101].labels.map(l => l.name), ['dispatcher:ready']);
  assert.match(store.issues[100].body, /<!-- architect-parent:50; architect-key:schema -->/);
  assert.match(store.issues[101].body, /<!-- architect-parent:50; architect-key:feature -->/);
});
