import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_MODEL_BASE_URL, resolveModelId } from '../scripts/pi-run-stage.mjs';

test('live openai-completions adapter exposes SDK status prefix and steer continues', async () => {
  const expectedModel = resolveModelId(process.env);
  const modelsUrl = new URL('models', DEFAULT_MODEL_BASE_URL.endsWith('/') ? DEFAULT_MODEL_BASE_URL : DEFAULT_MODEL_BASE_URL + '/');
  const status = await fetch(modelsUrl, { signal: AbortSignal.timeout(5000) });
  assert.equal(status.ok, true, 'real model endpoint must be reachable');
  const loaded = (await status.json()).data?.map(entry => entry.id) ?? [];
  assert.ok(loaded.includes(expectedModel), 'expected live model is loaded');

  const provider = {
    baseUrl: DEFAULT_MODEL_BASE_URL,
    api: 'openai-completions',
    apiKey: 'local-smoke',
    models: [{
      id: expectedModel,
      name: expectedModel,
      api: 'openai-completions',
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 32000,
    }],
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-live-openai-completions-'));
  try {
    const agentDir = path.join(root, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'hp-laguna': provider } }), { mode: 0o600 });

    const extension = path.join(root, 'probe.mjs');
    fs.writeFileSync(extension, `
export default function (pi) {
  let corrupted = false;
  let sawRejectedTurn = false;

  pi.on('before_provider_request', event => {
    if (corrupted) return event.payload;
    corrupted = true;
    return { ...event.payload, model: { invalid: true } };
  });

  pi.on('turn_end', async event => {
    const message = event?.message;
    if (!sawRejectedTurn && message?.stopReason === 'error') {
      sawRejectedTurn = true;
      const errorMessage = String(message?.errorMessage ?? '');
      const match = /^(\\d{3})(?=\\s|$)/.exec(errorMessage.trim());
      console.error('PI_LIVE_COMPLETIONS_PROVIDER_ERROR ' + JSON.stringify({
        status: match ? Number(match[1]) : null,
        errorMessage,
      }));
      await pi.sendUserMessage('Retry now and reply with OK.', { deliverAs: 'steer' });
      return;
    }
    if (sawRejectedTurn && message?.stopReason !== 'error') {
      console.error('PI_LIVE_COMPLETIONS_RECOVERED ' + JSON.stringify({ stopReason: message?.stopReason ?? null }));
      process.exit(0);
    }
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
    assert.match(output, /PI_LIVE_COMPLETIONS_PROVIDER_ERROR \{"status":400,"errorMessage":"400 /, output);
    assert.match(output, /PI_LIVE_COMPLETIONS_RECOVERED /, output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
