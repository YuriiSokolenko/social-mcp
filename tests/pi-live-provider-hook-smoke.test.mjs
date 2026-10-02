import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_MODEL_BASE_URL, resolveModelId } from '../scripts/pi-run-stage.mjs';

test('live pi transport emits after_provider_response for a real provider 4xx', async () => {
  const expectedModel = resolveModelId(process.env);
  const modelsUrl = new URL('models', DEFAULT_MODEL_BASE_URL.endsWith('/') ? DEFAULT_MODEL_BASE_URL : DEFAULT_MODEL_BASE_URL + '/');
  const status = await fetch(modelsUrl, { signal: AbortSignal.timeout(5000) });
  assert.equal(status.ok, true, 'real model endpoint must be reachable');
  const loaded = (await status.json()).data?.map(entry => entry.id) ?? [];
  assert.ok(loaded.includes(expectedModel), 'expected live model is loaded');

  const sourceAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const sourceModels = path.join(sourceAgentDir, 'models.json');
  assert.ok(fs.existsSync(sourceModels), 'runner Pi models.json must exist');

  const source = JSON.parse(fs.readFileSync(sourceModels, 'utf8'));
  const provider = structuredClone(source.providers?.['hp-laguna']);
  assert.ok(provider && typeof provider === 'object' && !Array.isArray(provider), 'hp-laguna provider must exist');

  provider.baseUrl = DEFAULT_MODEL_BASE_URL;
  for (const entry of provider.models ?? []) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) entry.baseUrl = DEFAULT_MODEL_BASE_URL;
  }
  for (const entry of Object.values(provider.modelOverrides ?? {})) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) entry.baseUrl = DEFAULT_MODEL_BASE_URL;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-live-provider-hook-'));
  try {
    const agentDir = path.join(root, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'hp-laguna': provider } }), { mode: 0o600 });
    const sourceAuth = path.join(sourceAgentDir, 'auth.json');
    if (fs.existsSync(sourceAuth)) fs.copyFileSync(sourceAuth, path.join(agentDir, 'auth.json'));

    const extension = path.join(root, 'probe.mjs');
    fs.writeFileSync(extension, `
export default function (pi) {
  let corrupted = false;
  pi.on('before_provider_request', event => {
    if (corrupted) return event.payload;
    corrupted = true;
    return { ...event.payload, model: { invalid: true } };
  });
  pi.on('after_provider_response', event => {
    const status = Number(event?.status ?? 0);
    console.error('PI_LIVE_AFTER_PROVIDER_RESPONSE ' + JSON.stringify({ status }));
    if (status >= 400 && status < 500) process.exit(0);
  });
}
`);

    const result = spawnSync('pi', [
      '--extension', extension,
      '--provider', 'hp-laguna',
      '--model', expectedModel,
      '--mode', 'json',
      '--no-session',
      'Reply with OK.',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    });

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, output);
    assert.match(output, /PI_LIVE_AFTER_PROVIDER_RESPONSE \{"status":4\d\d\}/, output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
