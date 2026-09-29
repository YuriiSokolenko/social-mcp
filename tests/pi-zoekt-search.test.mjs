import test from 'node:test';
import assert from 'node:assert/strict';

import { buildZoektQuery, zoektSearch } from '../scripts/pi-common/zoekt-search.mjs';

test('buildZoektQuery creates literal scoped content search', () => {
  const query = buildZoektQuery({
    kind: 'content',
    query: 'threads_get_profile',
    pathPrefix: 'src/social_mcp',
    extensions: ['py'],
    repository: 'YuriiSokolenko/social-mcp',
  });

  assert.match(query, /repo:/);
  assert.match(query, /repo:\^YuriiSokolenko\/social-mcp\$/);
  assert.match(query, /file:/);
  assert.match(query, /case:yes/);
  assert.match(query, /content:/);
  assert.match(query, /threads_get_profile/);
});

test('buildZoektQuery supports symbol and path discovery', () => {
  assert.match(buildZoektQuery({ kind: 'symbol', query: 'ThreadsClient' }), /sym:/);
  assert.match(buildZoektQuery({ kind: 'path', query: 'threads' }), /type:filename/);
});

test('buildZoektQuery escapes literals and scopes path prefixes and extensions', () => {
  const query = buildZoektQuery({
    kind: 'content',
    query: 'a.b*[x]',
    pathPrefix: 'src/social_mcp',
    extensions: ['.PY', 'py'],
    repository: 'org/repo',
  });
  assert.equal(query, 'repo:^org/repo$ file:"^src/social_mcp/" file:"\\.py$" case:yes content:"a\\\\.b\\\\*\\\\[x\\\\]"');
});

test('zoektSearch normalizes JSON API matches', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          Files: [{
            FileName: 'src/social_mcp/platforms/threads/api.py',
            Repository: 'YuriiSokolenko/social-mcp',
            Version: 'abc123',
            LineMatches: [{
              LineNumber: 42,
              Line: Buffer.from('def get_profile():\n').toString('base64'),
            }],
          }],
        };
      },
    };
  };

  const result = await zoektSearch({
    endpoint: 'http://127.0.0.1:6070',
    repository: 'YuriiSokolenko/social-mcp',
    kind: 'content',
    query: 'get_profile',
    maxResults: 10,
  }, fetchImpl);

  assert.equal(request.url, 'http://127.0.0.1:6070/api/search');
  assert.equal(request.options.method, 'POST');
  assert.equal(result.backend, 'zoekt');
  assert.deepEqual(result.matches, [{
    path: 'src/social_mcp/platforms/threads/api.py',
    line: 42,
    text: 'def get_profile():',
    version: 'abc123',
    repository: 'YuriiSokolenko/social-mcp',
  }]);
});

test('zoektSearch accepts the wrapped SearchResponse returned by zoekt-webserver', async () => {
  const result = await zoektSearch({
    endpoint: 'http://127.0.0.1:6070',
    kind: 'content',
    query: 'Threads',
  }, async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        Result: {
          Files: [{
            FileName: 'README.md',
            Repository: 'YuriiSokolenko/social-mcp',
            Version: 'abc123',
            LineMatches: [{ LineNumber: 7, Line: 'VGhyZWFkcw==' }],
          }],
        },
      };
    },
  }));

  assert.equal(result.matches[0].path, 'README.md');
  assert.equal(result.matches[0].text, 'Threads');
});

test('zoektSearch handles empty results, HTTP failures, malformed endpoints, and timeout', async () => {
  const empty = await zoektSearch({ endpoint: 'http://127.0.0.1:6070', query: 'missing' }, async () => ({
    ok: true,
    async json() { return { Result: { Files: [] } }; },
  }));
  assert.deepEqual(empty.matches, []);

  await assert.rejects(
    zoektSearch({ endpoint: 'http://127.0.0.1:6070', query: 'missing' }, async () => ({ ok: false, status: 503 })),
    /HTTP 503/,
  );
  await assert.rejects(
    zoektSearch({ endpoint: 'bad-endpoint', query: 'missing' }),
    /must be an http\(s\) URL/,
  );
  await assert.rejects(
    zoektSearch({ endpoint: 'http://127.0.0.1:6070', timeoutMs: 5, query: 'missing' }, (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })),
    /timeout/i,
  );
});
