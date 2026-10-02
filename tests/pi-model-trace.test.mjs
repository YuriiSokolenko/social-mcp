import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
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

test('model trace records sequential full exchanges and redacts transport credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-trace-'));
  const tracePath = join(dir, 'trace.jsonl');
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ echoed: body.messages[0].content, credential: 'Bearer upstreamsecret123' }));
  });
  const targetBaseUrl = await listen(upstream);
  const proxy = await startModelTraceProxy({
    targetBaseUrl: `${targetBaseUrl}?token=url-secret`, tracePath, stage: 'implementer', issue: '312',
    provider: 'compat', model: 'model-x',
  });
  try {
    for (const content of ['first prompt', 'second prompt']) {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer header-secret' },
        body: JSON.stringify({ model: 'model-x', messages: [{ role: 'user', content }], api_key: 'body-secret' }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /first prompt|second prompt/);
    }
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
  const content = readFileSync(tracePath, 'utf8');
  const records = content.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.sequence), [1, 2]);
  assert.deepEqual(records.map(record => record.request.body.messages[0].content), ['first prompt', 'second prompt']);
  assert.equal(records[0].response.echoed, 'first prompt');
  assert.equal(records[0].request.body.api_key, '[REDACTED]');
  assert.equal(records[0].response.credential, 'Bearer [REDACTED]');
  assert.equal(records[0].model.baseUrl, targetBaseUrl);
  assert.ok(records.every(record => record.stage === 'implementer' && record.issue === '312' && record.status === 200));
  assert.doesNotMatch(content, /header-secret|body-secret|url-secret|upstreamsecret123/);
  rmSync(dir, { recursive: true, force: true });
});

test('model trace records HTTP failures and transport errors without exposing payloads to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-trace-error-'));
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
  const [record] = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(record.status, 429);
  assert.equal(record.error.name, 'HttpError');
  assert.deepEqual(record.response, { error: { message: 'rate limited' } });
  assert.equal(record.request.body.prompt, 'private-prompt');
  assert.ok(record.elapsedMs >= 0);
  assert.ok(fs.statSync(tracePath).size > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('Implementer workflow uploads the temporary trace after failed or cancelled runs', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/pi-issue-agent.yml', import.meta.url)), 'utf8');
  const upload = workflow.slice(workflow.indexOf('- name: Upload model request and response trace'));
  assert.match(upload, /if: always\(\)/);
  assert.match(upload, /uses: actions\/upload-artifact@v4/);
  assert.match(upload, /if-no-files-found: ignore/);
  assert.match(upload, /pi-model-trace-implementer-\$\{\{ inputs\.issue_number \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
});
