import test from 'node:test';
import assert from 'node:assert/strict';

import responseBudgetExtension from '../scripts/pi-response-budget.mjs';

function harness(env = {}) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const handlers = new Map();
  const tools = new Map();
  const models = [];
  const ctx = { model: { provider: 'test', id: 'model', maxTokens: 32000 } };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    async setModel(model) {
      ctx.model = model;
      models.push(model);
      return true;
    },
  };

  responseBudgetExtension(pi);

  return {
    ctx,
    handlers,
    tools,
    models,
    restore() {
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    },
  };
}

async function finishTurn(h, turnIndex, output) {
  await h.handlers.get('turn_start')({ turnIndex }, h.ctx);
  await h.handlers.get('turn_end')({
    turnIndex,
    message: { role: 'assistant', usage: { output } },
    toolResults: [],
  }, h.ctx);
}

test('response budget escalates only the next response after a ceiling hit', async () => {
  const h = harness();
  try {
    await h.handlers.get('session_start')({}, h.ctx);
    assert.equal(h.ctx.model.maxTokens, 2048);

    await finishTurn(h, 0, 2048);
    assert.equal(h.ctx.model.maxTokens, 4096);

    await finishTurn(h, 1, 100);
    assert.equal(h.ctx.model.maxTokens, 2048);
  } finally {
    h.restore();
  }
});

test('consecutive ceiling hits climb SHORT to NORMAL to DEEP, then reset', async () => {
  const h = harness();
  try {
    await h.handlers.get('session_start')({}, h.ctx);

    await finishTurn(h, 0, 2048);
    assert.equal(h.ctx.model.maxTokens, 4096);

    await finishTurn(h, 1, 4096);
    assert.equal(h.ctx.model.maxTokens, 8192);

    await finishTurn(h, 2, 8192);
    assert.equal(h.ctx.model.maxTokens, 2048);
  } finally {
    h.restore();
  }
});

test('explicit response budget is a one-response override and is not erased by its calling turn', async () => {
  const h = harness();
  try {
    await h.handlers.get('session_start')({}, h.ctx);
    await h.handlers.get('turn_start')({ turnIndex: 0 }, h.ctx);

    const tool = h.tools.get('set_response_budget');
    await tool.execute('call-1', { level: 'deep', reason: 'next response needs synthesis' }, null, null, h.ctx);
    assert.equal(h.ctx.model.maxTokens, 8192);

    await h.handlers.get('turn_end')({
      turnIndex: 0,
      message: { role: 'assistant', usage: { output: 100 } },
      toolResults: [],
    }, h.ctx);
    assert.equal(h.ctx.model.maxTokens, 8192);

    await finishTurn(h, 1, 100);
    assert.equal(h.ctx.model.maxTokens, 2048);
  } finally {
    h.restore();
  }
});

test('fixed response budget disables automatic escalation and manual budget tool', async () => {
  const h = harness({ PI_FIXED_RESPONSE_MAX_TOKENS: '1000' });
  try {
    await h.handlers.get('session_start')({}, h.ctx);
    assert.equal(h.ctx.model.maxTokens, 1000);
    assert.equal(h.tools.has('set_response_budget'), false);

    await finishTurn(h, 0, 1000);
    assert.equal(h.ctx.model.maxTokens, 1000);
  } finally {
    h.restore();
  }
});
