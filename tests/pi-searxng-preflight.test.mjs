import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkSearxngMcp } from '../infra/github-runner-autoscaler/check-pi-searxng-mcp.mjs';

const fakeServer = String.raw`
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'mcp-searxng', version: '2.5.1' }, capabilities: { tools: {} } };
    else if (request.method === 'tools/list') result = { tools: [{ name: 'searxng_web_search' }] };
    else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'Found SearXNG documentation' }] };
    else if (request.method.startsWith('notifications/')) continue;
    else result = {};
    if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  }
});
`;

function fixture(config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-searxng-preflight-'));
  const configPath = path.join(directory, 'mcp-adapter.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { directory, configPath, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function launchServer(command, args, options) {
  assert.equal(command, 'mcp-searxng');
  return spawn(process.execPath, ['-e', fakeServer], options);
}

test('preflight handshakes and calls a read-only SearXNG search tool', async () => {
  const temp = fixture({ mcpServers: { searxng: { command: 'mcp-searxng', env: { SEARXNG_URL: 'https://search.invalid' } } } });
  try {
    const result = await checkSearxngMcp({ configPath: temp.configPath, spawnProcess: launchServer });
    assert.deepEqual(result, { server: 'searxng', tool: 'searxng_web_search', handshake: true, search: true });
  } finally {
    temp.cleanup();
  }
});

test('preflight fails clearly when the SearXNG server config is absent', async () => {
  const temp = fixture({ mcpServers: {} });
  try {
    await assert.rejects(checkSearxngMcp({ configPath: temp.configPath }), /mcpServers\.searxng/);
  } finally {
    temp.cleanup();
  }
});

test('preflight reports a missing executable without exposing backend settings', async () => {
  const temp = fixture({ mcpServers: { searxng: { command: 'mcp-searxng', env: { SEARXNG_URL: 'https://search.invalid/private-token' } } } });
  try {
    await assert.rejects(checkSearxngMcp({ configPath: temp.configPath }), (error) => {
      assert.match(error.message, /could not be started/);
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    });
  } finally {
    temp.cleanup();
  }
});

test('preflight requires a configured backend URL without printing its value', async () => {
  const temp = fixture({ mcpServers: { searxng: { command: 'mcp-searxng', env: {} } } });
  try {
    await assert.rejects(checkSearxngMcp({ configPath: temp.configPath }), (error) => {
      assert.match(error.message, /SEARXNG_URL/);
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    });
  } finally {
    temp.cleanup();
  }
});

test('preflight fails if the required read-only search tool is not advertised', async () => {
  const temp = fixture({ mcpServers: { searxng: { command: 'mcp-searxng', env: { SEARXNG_URL: 'https://search.invalid' } } } });
  const missingToolServer = String.raw`
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString().trim().split('\n')) {
    const request = JSON.parse(line);
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-03-26', serverInfo: { name: 'mcp-searxng' }, capabilities: { tools: {} } }
      : { tools: [] };
    if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  }
});
`;
  try {
    await assert.rejects(checkSearxngMcp({
      configPath: temp.configPath,
      spawnProcess: (command, args, options) => spawn(process.execPath, ['-e', missingToolServer], options),
    }), /did not advertise searxng_web_search/);
  } finally {
    temp.cleanup();
  }
});
