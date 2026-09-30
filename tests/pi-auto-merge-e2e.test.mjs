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
      const parsed = new URL(url);
      const { pathname, searchParams } = parsed;
      const store = load();

      if (method === 'GET' && pathname.endsWith('/pulls')) {
        return Response.json(store.openPrs);
      }
      const filesMatch = /\\/pulls\\/(\\d+)\\/files$/.exec(pathname);
      if (filesMatch) return Response.json(store.filesByPr?.[filesMatch[1]] ?? store.files);

      if (method === 'GET' && pathname.endsWith('/actions/workflows/ci.yml/runs')) {
        const headSha = searchParams.get('head_sha');
        return Response.json({ workflow_runs: store.ciRunsBySha?.[headSha] ?? store.ciRuns ?? [] });
      }

      const mergeMatch = /\\/pulls\\/(\\d+)\\/merge$/.exec(pathname);
      if (mergeMatch && method === 'PUT') {
        if (store.mergeConflict) return new Response('merge conflicts, resolve and retry', { status: 405 });
        const body = JSON.parse(options.body);
        store.merged = body;
        store.merges = store.merges ?? [];
        store.merges.push({ pr: Number(mergeMatch[1]), ...body });
        save(store);
        return Response.json({ merged: true, sha: 'merged-sha' });
      }

      const prMatch = /\\/pulls\\/(\\d+)$/.exec(pathname);
      if (prMatch && method === 'GET') return Response.json(store.prs?.[prMatch[1]] ?? store.pr);

      const labelsMatch = /\\/issues\\/(\\d+)\\/labels$/.exec(pathname);
      if (labelsMatch && method === 'PUT') {
        const body = JSON.parse(options.body);
        const target = store.prs?.[labelsMatch[1]] ?? store.pr;
        target.labels = body.labels.map(name => ({ name }));
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
      if (issueMatch && method === 'GET') return Response.json(store.issues?.[issueMatch[1]] ?? store.issue);

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
    ciRuns: [{ id: 11, event: 'pull_request', head_sha: 'sha-1', status: 'completed', conclusion: 'success' }],
  }));

  const result = run(storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /merged sha-1 after green PR CI; dev push CI now validates the merged result/);

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
    ciRuns: [{ id: 11, event: 'pull_request', head_sha: 'sha-1', status: 'completed', conclusion: 'success' }],
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

test('merge gate blocks a passed PR while exact-head CI is still pending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-merge-'));
  const storeFile = join(dir, 'store.json');
  writeFileSync(storeFile, JSON.stringify({
    openPrs: [{ number: 7 }],
    pr: basePr,
    files: [{ filename: 'src/social_mcp/app.py' }],
    issue: { number: 42, state: 'open', labels: [{ name: 'pi:mr-created' }] },
    ciRuns: [{ id: 12, event: 'pull_request', head_sha: 'sha-1', status: 'in_progress', conclusion: null }],
  }));

  const result = run(storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /waiting for green PR CI for sha-1/);
  assert.equal(JSON.parse(readFileSync(storeFile, 'utf8')).merged, undefined);
});

test('failed exact-head CI invalidates PASS, dispatches PR Fix, and does not merge that PR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-merge-'));
  const storeFile = join(dir, 'store.json');
  writeFileSync(storeFile, JSON.stringify({
    openPrs: [{ number: 7 }],
    pr: basePr,
    files: [{ filename: 'src/social_mcp/app.py' }],
    issue: { number: 42, state: 'open', labels: [{ name: 'pi:mr-created' }] },
    ciRuns: [{
      id: 13, event: 'pull_request', head_sha: 'sha-1', status: 'completed',
      conclusion: 'failure', html_url: 'https://github.test/runs/13',
    }],
  }));

  const result = run(storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PR CI failure for sha-1; assigned review:changes-requested, dispatched PR Fix, checking the next PR/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.equal(store.merged, undefined);
  assert.ok(store.pr.labels.some(label => label.name === 'review:changes-requested'));
  assert.ok(!store.pr.labels.some(label => label.name === 'review:passed'));
  assert.deepEqual(store.dispatched, [{ workflow: 'pi-pr-fix.yml', inputs: { pr_number: '7' } }]);
  assert.match(store.comments[0].body, /https:\/\/github\.test\/runs\/13/);
});

test('stale green CI from a different head SHA cannot merge the current PR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-merge-'));
  const storeFile = join(dir, 'store.json');
  writeFileSync(storeFile, JSON.stringify({
    openPrs: [{ number: 7 }],
    pr: basePr,
    files: [{ filename: 'src/social_mcp/app.py' }],
    issue: { number: 42, state: 'open', labels: [{ name: 'pi:mr-created' }] },
    ciRuns: [{ id: 14, event: 'pull_request', head_sha: 'sha-old', status: 'completed', conclusion: 'success' }],
  }));

  const result = run(storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /waiting for green PR CI for sha-1; checking the next PR/);
  assert.equal(JSON.parse(readFileSync(storeFile, 'utf8')).merged, undefined);
});

test('failed CI on one PR is routed to repair while a later green PR can still merge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-merge-'));
  const storeFile = join(dir, 'store.json');
  const secondPr = {
    ...basePr,
    number: 8,
    body: 'Closes #43',
    head: { ...basePr.head, ref: 'pi/issue-43', sha: 'sha-2' },
  };
  writeFileSync(storeFile, JSON.stringify({
    openPrs: [{ number: 7 }, { number: 8 }],
    prs: { 7: basePr, 8: secondPr },
    filesByPr: {
      7: [{ filename: 'src/social_mcp/app.py' }],
      8: [{ filename: 'src/social_mcp/storage.py' }],
    },
    issues: {
      42: { number: 42, state: 'open', labels: [{ name: 'pi:mr-created' }] },
      43: { number: 43, state: 'open', labels: [{ name: 'pi:mr-created' }] },
    },
    ciRunsBySha: {
      'sha-1': [{ id: 15, event: 'pull_request', head_sha: 'sha-1', status: 'completed', conclusion: 'cancelled' }],
      'sha-2': [{ id: 16, event: 'pull_request', head_sha: 'sha-2', status: 'completed', conclusion: 'success' }],
    },
  }));

  const result = run(storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PR CI cancelled for sha-1; assigned review:changes-requested, dispatched PR Fix, checking the next PR/);
  assert.match(result.stdout, /merged sha-2 after green PR CI/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.ok(store.prs['7'].labels.some(label => label.name === 'review:changes-requested'));
  assert.deepEqual(store.dispatched, [{ workflow: 'pi-pr-fix.yml', inputs: { pr_number: '7' } }]);
  assert.deepEqual(store.merges, [{ pr: 8, sha: 'sha-2', merge_method: 'squash' }]);
});

test('pending CI on one PR does not block a later green PR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-merge-'));
  const storeFile = join(dir, 'store.json');
  const secondPr = {
    ...basePr,
    number: 8,
    body: 'Closes #43',
    head: { ...basePr.head, ref: 'pi/issue-43', sha: 'sha-2' },
  };
  writeFileSync(storeFile, JSON.stringify({
    openPrs: [{ number: 7 }, { number: 8 }],
    prs: { 7: basePr, 8: secondPr },
    filesByPr: {
      7: [{ filename: 'src/social_mcp/app.py' }],
      8: [{ filename: 'src/social_mcp/storage.py' }],
    },
    issues: {
      42: { number: 42, state: 'open', labels: [{ name: 'pi:mr-created' }] },
      43: { number: 43, state: 'open', labels: [{ name: 'pi:mr-created' }] },
    },
    ciRunsBySha: {
      'sha-1': [{ id: 17, event: 'pull_request', head_sha: 'sha-1', status: 'in_progress', conclusion: null }],
      'sha-2': [{ id: 18, event: 'pull_request', head_sha: 'sha-2', status: 'completed', conclusion: 'success' }],
    },
  }));

  const result = run(storeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /waiting for green PR CI for sha-1; checking the next PR/);
  assert.match(result.stdout, /merged sha-2 after green PR CI/);

  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.deepEqual(store.merges, [{ pr: 8, sha: 'sha-2', merge_method: 'squash' }]);
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
