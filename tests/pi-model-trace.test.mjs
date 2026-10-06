import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startModelTraceProxy } from '../scripts/pi-common/model-trace-proxy.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function recordsAt(file) {
  return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('model trace records sequential exchanges, preserves usage fields, and redacts credentials only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-trace-'));
  const tracePath = join(dir, 'trace.jsonl');
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      echoed: body.messages[0].content,
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      access_token: 'response-access-secret',
    }));
  });
  const targetBaseUrl = await listen(upstream);
  const proxy = await startModelTraceProxy({
    targetBaseUrl: `${targetBaseUrl}?api_key=url-secret`, tracePath, stage: 'implementer', issue: '312',
    provider: 'compat', model: 'model-x',
  });
  try {
    for (const content of ['first prompt: token: counter', 'second prompt']) {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer header-secret' },
        body: JSON.stringify({
          model: 'model-x', max_tokens: 123,
          usage_hint: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          credentials: {
            access_token: 'access-secret', refresh_token: 'refresh-secret', api_key: 'api-secret',
            clientSecret: 'client-secret', id_token: 'id-secret',
          },
          messages: [{ role: 'user', content }],
        }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /first prompt|second prompt/);
    }
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
  const content = readFileSync(tracePath, 'utf8');
  const records = recordsAt(tracePath);
  assert.deepEqual(records.map(record => record.sequence), [1, 2]);
  assert.deepEqual(records.map(record => record.request.body.messages[0].content), ['first prompt: token: counter', 'second prompt']);
  assert.equal(records[0].response.echoed, 'first prompt: token: counter');
  assert.equal(records[0].request.body.max_tokens, 123);
  assert.deepEqual(records[0].request.body.usage_hint, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  assert.deepEqual(records[0].request.body.credentials, {
    access_token: '[REDACTED]', refresh_token: '[REDACTED]', api_key: '[REDACTED]',
    clientSecret: '[REDACTED]', id_token: '[REDACTED]',
  });
  assert.deepEqual(records[0].response.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  assert.equal(records[0].response.access_token, '[REDACTED]');
  assert.equal(records[0].model.baseUrl, targetBaseUrl);
  assert.ok(records.every(record => record.stage === 'implementer' && record.issue === '312' && record.status === 200));
  assert.doesNotMatch(content, /header-secret|access-secret|refresh-secret|api-secret|client-secret|id-secret|url-secret|response-access-secret/);
  assert.match(content, /first prompt: token: counter/);
  rmSync(dir, { recursive: true, force: true });
});

test('model trace records non-2xx HTTP status, error summary, and response payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-trace-http-error-'));
  const tracePath = join(dir, 'trace.jsonl');
  const upstream = http.createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"rate limited"}}');
  });
  const targetBaseUrl = await listen(upstream);
  const proxy = await startModelTraceProxy({ targetBaseUrl, tracePath, stage: 'implementer', provider: 'compat', model: 'model-x' });
  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', body: '{"prompt":"private-prompt"}' });
    assert.equal(response.status, 429);
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
  const [record] = recordsAt(tracePath);
  assert.equal(record.status, 429);
  assert.equal(record.error.name, 'HttpError');
  assert.deepEqual(record.response, { error: { message: 'rate limited' } });
  assert.equal(record.request.body.prompt, 'private-prompt');
  assert.ok(record.elapsedMs >= 0);
  rmSync(dir, { recursive: true, force: true });
});

test('actual transport failures produce deterministic trace errors without leaking credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-trace-transport-error-'));
  const tracePath = join(dir, 'trace.jsonl');
  const closedServer = http.createServer();
  const targetBaseUrl = await listen(closedServer);
  await new Promise(resolve => closedServer.close(resolve));
  const proxy = await startModelTraceProxy({
    targetBaseUrl: `${targetBaseUrl}?api_key=upstream-secret`, tracePath, stage: 'implementer', provider: 'compat', model: 'model-x',
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions?access_token=request-secret`, {
      method: 'POST', body: '{"refresh_token":"body-secret"}',
    });
    assert.equal(response.status, 502);
  } finally {
    await proxy.close();
  }
  const [record] = recordsAt(tracePath);
  assert.equal(record.status, 502);
  assert.equal(record.response, null);
  assert.ok(record.error.name);
  assert.ok(record.error.message);
  assert.doesNotMatch(JSON.stringify(record), /upstream-secret|request-secret|body-secret/);
  rmSync(dir, { recursive: true, force: true });
});

test('decoded upstream response omits stale encoding, length, and hop-by-hop headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-trace-headers-'));
  const tracePath = join(dir, 'trace.jsonl');
  const compressed = gzipSync(Buffer.from('{"decoded":true}'));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': compressed.length,
      connection: 'keep-alive, x-upstream-hop',
      'x-upstream-hop': 'remove-me',
      'x-visible': 'keep-me',
    });
    res.end(compressed);
  });
  const targetBaseUrl = await listen(upstream);
  const proxy = await startModelTraceProxy({ targetBaseUrl, tracePath, stage: 'implementer' });
  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', body: '{}' });
    assert.deepEqual(await response.json(), { decoded: true });
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), null);
    // Node may add fresh chunked framing after the proxy strips the upstream value.
    assert.ok([null, 'chunked'].includes(response.headers.get('transfer-encoding')));
    assert.ok([null, 'keep-alive'].includes(response.headers.get('connection')));
    assert.equal(response.headers.get('x-upstream-hop'), null);
    assert.equal(response.headers.get('x-visible'), 'keep-me');
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
  rmSync(dir, { recursive: true, force: true });
});

test('client disconnect aborts the in-flight upstream request but completed requests stay valid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-trace-abort-'));
  const tracePath = join(dir, 'trace.jsonl');
  let markStarted;
  let markAborted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const aborted = new Promise(resolve => { markAborted = resolve; });
  const upstream = http.createServer((_req, res) => {
    res.once('close', () => markAborted());
    markStarted();
    const timer = setTimeout(() => { if (!res.destroyed) res.end('{"late":true}'); }, 5000);
    res.once('close', () => clearTimeout(timer));
  });
  const targetBaseUrl = await listen(upstream);
  const proxy = await startModelTraceProxy({ targetBaseUrl, tracePath, stage: 'implementer' });
  try {
    const client = http.request(`${proxy.baseUrl}/chat/completions`, { method: 'POST' });
    client.on('error', () => {});
    client.end('{}');
    await started;
    client.destroy();
    let timeout;
    await Promise.race([
      aborted,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('upstream was not aborted')), 1500); }),
    ]).finally(() => clearTimeout(timeout));
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
  const [record] = recordsAt(tracePath);
  assert.equal(record.status, 499);
  assert.equal(record.response, null);
  assert.equal(record.error.name, 'AbortError');
  rmSync(dir, { recursive: true, force: true });
});

test('trace size cap keeps complete records, writes one marker, and leaves model traffic working', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-trace-limit-'));
  const tracePath = join(dir, 'trace.jsonl');
  const upstream = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  const targetBaseUrl = await listen(upstream);
  const proxy = await startModelTraceProxy({ targetBaseUrl, tracePath, stage: 'implementer', maxBytes: 500 });
  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ index }) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    }
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
  const text = readFileSync(tracePath, 'utf8');
  assert.ok(Buffer.byteLength(text) <= 500);
  assert.ok(text.endsWith('\n'));
  const lines = text.trim().split('\n');
  const items = lines.map(line => JSON.parse(line));
  assert.equal(items.filter(item => item.traceLimitReached).length, 1);
  assert.deepEqual(items.filter(item => !item.traceLimitReached).map(item => item.sequence), [1]);
  assert.equal(items.at(-1).sequence, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('Implementer workflow uploads the stage-named temporary trace after failed or cancelled runs', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/pi-issue-agent.yml', import.meta.url)), 'utf8');
  const upload = workflow.slice(workflow.indexOf('- name: Upload model request and response trace'));
  const docs = readFileSync(fileURLToPath(new URL('../docs/pi-model-traces.md', import.meta.url)), 'utf8');
  const proxySource = readFileSync(fileURLToPath(new URL('../scripts/pi-common/model-trace-proxy.mjs', import.meta.url)), 'utf8');
  assert.match(upload, /if: always\(\)/);
  assert.match(upload, /uses: actions\/upload-artifact@v4/);
  assert.match(upload, /if-no-files-found: ignore/);
  assert.match(upload, /name: pi-model-trace-implementer-\$\{\{ inputs\.issue_number \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(upload, /retention-days: 7/);
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/pi-model-trace-implementer-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\.jsonl/);
  assert.match(docs, /pi-model-trace-implementer-<issue>-<run-id>-<attempt>/);
  assert.match(docs, /7 day retention/);
  assert.match(docs, /Treat the artifact itself as sensitive/);
  assert.match(docs, /any signed-in GitHub user/);
  assert.match(docs, /Streaming\/SSE responses are stored as the complete raw response text/);
  assert.doesNotMatch(proxySource, /console\.(?:log|info|warn|error)\s*\(/);
});


test('#469 model trace emits one timing callback per real provider exchange', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-trace-metrics-'));
  const tracePath = join(dir, 'trace.jsonl');
  const observed = [];
  const upstream = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  const targetBaseUrl = await listen(upstream);
  const proxy = await startModelTraceProxy({
    targetBaseUrl,
    tracePath,
    stage: 'implementer',
    issue: '469',
    onExchange: metric => observed.push(metric),
  });
  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      await response.text();
    }
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
  assert.deepEqual(observed.map(item => item.sequence), [1, 2, 3]);
  assert.ok(observed.every(item => typeof item.traceSession === 'string' && item.traceSession.length > 0));
  assert.equal(new Set(observed.map(item => item.traceSession)).size, 1, 'one proxy shares one provider session id');
  assert.ok(observed.every(item => item.requestMethod === 'POST'));
  assert.ok(observed.every(item => item.requestPath === '/v1/chat/completions'));
  assert.ok(observed.every(item => item.status === 200 && item.elapsedMs >= 0 && item.transportError === false));
  rmSync(dir, { recursive: true, force: true });
});
