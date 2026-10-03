import assert from 'node:assert/strict';
import test from 'node:test';

const BASE_URL = process.env.PI_MODEL_BASE_URL || 'http://192.168.8.184:4001/v1';

test('live provider honors required tool choice on the first request', { timeout: 20000 }, async (t) => {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    t.skip('live provider smoke runs only on the self-hosted GitHub runner');
    return;
  }

  const modelsResponse = await fetch(`${BASE_URL.replace(/\/$/, '')}/models`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(modelsResponse.ok, true, `models endpoint returned ${modelsResponse.status}`);
  const modelsBody = await modelsResponse.json();
  const ids = (modelsBody.data ?? []).map(item => String(item.id ?? '')).filter(Boolean);
  assert.ok(ids.length > 0, 'provider exposed no loaded model');
  const model = ids.find(id => /laguna/i.test(id)) ?? ids[0];

  const response = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: 'Call the probe_required_tool function exactly once now. Do not answer with prose.',
      }],
      tools: [{
        type: 'function',
        function: {
          name: 'probe_required_tool',
          description: 'Required-tool transport smoke probe.',
          parameters: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: ['value'],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: 'required',
      max_tokens: 128,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  const raw = await response.text();
  assert.equal(response.ok, true, `chat completion returned ${response.status}: ${raw.slice(0, 1000)}`);
  const body = JSON.parse(raw);
  const message = body.choices?.[0]?.message ?? {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  assert.ok(calls.length > 0, `required request returned no tool call: ${raw.slice(0, 1500)}`);
  assert.equal(calls[0]?.function?.name, 'probe_required_tool');
  console.log(`LIVE_REQUIRED_TOOL_SMOKE model=${model} tool=${calls[0].function.name}`);
});
