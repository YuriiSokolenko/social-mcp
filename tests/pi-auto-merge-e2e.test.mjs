import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// End-to-end coverage for pi-auto-merge.mjs's processPR()/main(), which the
// pure-logic unit tests in pi-auto-merge.test.mjs verify only through
// exported helpers and source-text contract assertions.

const basePr = {
  number: 7, state: 'open', draft: false, changed_files: 1, body: 'Closes #42',
  base: { ref: 'dev', repo: { full_name: 'test/repo' } },
  head: { ref: 'pi/issue-42', repo: { full_name: 'test/repo' }, sha: 'sha-1' },
  labels: [{ name: 'review:passed' }],
};

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

      if (method === 'GET' && pathname.endsWith('/pulls')) {
        return Response.json(store.openPrs);
      }
      const filesMatch = /\\/pulls\\/(\\d+)\\/files$/.exec(pathname);
      if (filesMatch) return Response.json(store.files);

      const mergeMatch = /\\/pulls\\/(\\d+)\\/merge$/.exec(pathname);
      if (mergeMatch && method === 'PUT') {
        if (store.mergeConflict) return new Response('merge conflicts, resolve and retry', { status: 405 });
        store.merged = JSON.parse(options.body);
        save(store);
        return Response.json({ merged: true, sha: 'merged-sha' });
      }

      const prMatch = /\\/pulls\\/(\\d+)$/.exec(pathname);
      if (prMatch && method === 'GET') return Response.json(store.pr);

      const labelsMatch = /\\/issues\\/(\\d+)\\/labels$/.exec(pathname);
      if (labelsMatch && method === 'PUT') {
        const body = JSON.parse(options.body);
        store.pr.labels = body.labels.map(name => ({ name }));
        save(store);
        return Response.json({});
      }

      const commentsMatch = /\\/issues\\/(\\d+)\\/comments$/.exec(pathname);
      if (commentsMatch) {
        const number = Number(commentsMatch[1]);
        if (method === 'GET') return Response.json(store.comments ?? []);
        if (method === 'POST') {
          const body = JSON.parse(options.body);
          store.comments = store.comments ?? [];
          store.comments.push({ body: body.body });
          save(store);
          return Response.json({});
        }
      }

      const issueMatch = /\\/issues\\/(\\d+)$/.exec(pathname);
      if (issueMatch && method === 'GET') return Response.json(store.issue);

      const dispatchMatch = /\\/actions\\/workflows\\/([^/]+)\\/dispatches$/.exec(pathname);
      if (dispatchMatch && method === 'POST') {
        store.dispatched = store.dispatched ?? [];
        store.dispatched.push({ workflow: dispatchMatch[1], inputs: JSON.parse(options.body).inputs });
        save(store);
        return new Response(null, { status: 204 });
      }

      throw new Error('Unexpected ' + method + ' ' + url);
    };
  `);
}

function run(storeFile) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-merge-'));
  const mockFile = join(dir, 'mock.mjs');
  writeMock(mockFile, storeFile);
  return spawnSync(process.execPath, ['--import', pathToFileURL(mockFile).href, 'scripts/pi-auto-merge.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'test/repo', GITHUB_TOKEN: 'synthetic-token' },
  });
}

test('merge gate squash-merges a passed, unchanged, safe PR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-merge-'));
  const storeFile = join(dir, 'store.json');
  writeFileSync(storeFile, JSON.stringify({
    openPrs: [{ number: 7 }],
    pr: basePr,
    files: [{ filename: 'src/social_mcp/app.py' }],
    issue: { number: 42, state: 'open', labels: [{ name: 'pi:mr-created' }] },
  }));

  const result = run(storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /merged sha-1; dev push CI now validates the merged result/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.deepEqual(store.merged, { sha: 'sha-1', merge_method: 'squash' });
});

test('merge gate stops on a control-plane file change and leaves one human-attention comment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-merge-'));
  const storeFile = join(dir, 'store.json');
  writeFileSync(storeFile, JSON.stringify({
    openPrs: [{ number: 7 }],
    pr: basePr,
    files: [{ filename: '.github/workflows/ci.yml' }],
    issue: { number: 42, state: 'open', labels: [{ name: 'pi:mr-created' }] },
  }));

  const result = run(storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /changed control files or incomplete file list; human review required/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.ok(store.pr.labels.some(l => l.name === 'pi:needs-human'));
  assert.equal(store.comments.length, 1);
  assert.match(store.comments[0].body, /Merge Gate stopped PR #7/);
});

test('a late merge conflict invalidates review and dispatches PR Fix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-merge-'));
  const storeFile = join(dir, 'store.json');
  writeFileSync(storeFile, JSON.stringify({
    openPrs: [{ number: 7 }],
    pr: basePr,
    files: [{ filename: 'src/social_mcp/app.py' }],
    issue: { number: 42, state: 'open', labels: [{ name: 'pi:mr-created' }] },
    mergeConflict: true,
  }));

  const result = run(storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /merge conflict; assigned review:changes-requested ownership and dispatched PR Fix/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.ok(store.pr.labels.some(l => l.name === 'review:changes-requested'));
  assert.equal(store.comments.length, 1);
  assert.match(store.comments[0].body, /conflicts with current dev/);
  assert.deepEqual(store.dispatched, [{ workflow: 'pi-pr-fix.yml', inputs: { pr_number: '7' } }]);
});

test('a PR whose issue is not yet mr-created, or that lacks review:passed, is skipped without mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-merge-'));
  const storeFile = join(dir, 'store.json');
  writeFileSync(storeFile, JSON.stringify({
    openPrs: [{ number: 7 }],
    pr: { ...basePr, labels: [] },
    files: [{ filename: 'src/social_mcp/app.py' }],
    issue: { number: 42, state: 'open', labels: [{ name: 'pi:mr-created' }] },
  }));

  const result = run(storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /waiting for independent review PASS/);
  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.equal(store.merged, undefined);
});
