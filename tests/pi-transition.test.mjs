import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

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
        return Response.json([]);
      }

      const commentsMatch = /\\/issues\\/(\\d+)\\/comments$/.exec(pathname);
      if (commentsMatch && method === 'POST') {
        store.comments = store.comments ?? [];
        store.comments.push(JSON.parse(options.body).body);
        save(store);
        return Response.json({ id: store.comments.length });
      }

      const issueMatch = /\\/issues\\/(\\d+)$/.exec(pathname);
      if (issueMatch) {
        if (method === 'GET') return Response.json(store.issue);
        if (method === 'PATCH') {
          const body = JSON.parse(options.body);
          store.issue = {
            ...store.issue,
            ...body,
            labels: (body.labels ?? store.issue.labels).map(name =>
              typeof name === 'string' ? { name } : name
            ),
          };
          save(store);
          return Response.json(store.issue);
        }
      }

      throw new Error('Unexpected ' + method + ' ' + url);
    };
  `);
}

test('blocked satisfied transition stays open, clears stale ownership, and posts no completion comment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-transition-'));
  const storeFile = join(dir, 'store.json');
  const mockFile = join(dir, 'mock.mjs');

  writeFileSync(storeFile, JSON.stringify({
    issue: {
      number: 42,
      state: 'open',
      state_reason: null,
      labels: [{ name: 'pi:blocked' }, { name: 'pi:running' }],
    },
    comments: [],
  }));
  writeMock(mockFile, storeFile);

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(mockFile).href,
      'scripts/pi-transition.mjs',
      'issue',
      'satisfied',
      'Implementation completed successfully.',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ISSUE: '42',
        GITHUB_REPOSITORY: 'test/repo',
        GITHUB_TOKEN: 'synthetic-token',
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.equal(store.issue.state, 'open');
  assert.deepEqual(store.issue.labels.map(label => label.name), ['pi:blocked']);
  assert.deepEqual(store.comments, []);
  assert.match(
    result.stdout,
    /preserved pi:blocked; ignored satisfied target and removed conflicting pipeline ownership/,
  );
});
