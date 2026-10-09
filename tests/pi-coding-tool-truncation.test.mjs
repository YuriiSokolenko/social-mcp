import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ProgressController,
  serializedProviderOutputBudget,
  incompleteCodingToolError,
  verifiedCodingToolTruncation,
  codingTruncationCorrectionTool,
} from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

const missingPath = 'Validation failed for tool "write":\n  - path: must have required properties path\nReceived arguments:\n{\n  "content": "generated source"\n}';

test('#633 actual wire budget: never trust an absent, contradictory or invalid token ceiling', () => {
  assert.deepEqual(serializedProviderOutputBudget({ max_completion_tokens: 2048 }),
    { verified: true, ceiling: 2048, field: 'max_completion_tokens' });
  assert.deepEqual(serializedProviderOutputBudget({ max_tokens: 8192, max_completion_tokens: 8192 }),
    { verified: true, ceiling: 8192, field: 'max_completion_tokens+max_tokens' });
  for (const payload of [{}, { max_completion_tokens: 0 },
    { max_completion_tokens: '8192' },
    { max_completion_tokens: 8192, max_tokens: 2048 }]) {
    assert.equal(serializedProviderOutputBudget(payload).verified, false);
  }
});

test('#633 only a coding tool schema error with a malformed payload is eligible', () => {
  const candidate = incompleteCodingToolError({ toolName: 'write', isError: true, text: missingPath });
  assert.deepEqual(candidate, { toolName: 'write', evidence: 'missing_path_with_payload' });
  assert.equal(incompleteCodingToolError({ toolName: 'write', isError: false, text: missingPath }), null);
  assert.equal(incompleteCodingToolError({ toolName: 'read', isError: true, text: missingPath }), null);
  assert.equal(incompleteCodingToolError({
    toolName: 'write', isError: true,
    text: 'Validation failed for tool "write":\n  - path: must have required properties path\nReceived arguments:\n{}',
  }), null, 'a deliberately missing path in otherwise complete empty JSON must not be relabeled');
  assert.equal(incompleteCodingToolError({
    toolName: 'write', isError: true, text: 'Validation failed for tool "write": content: invalid',
  }), null);
  assert.equal(incompleteCodingToolError({
    toolName: 'write', isError: true, text: 'provider error: 503',
  }), null);
});

test('#633 ceiling correlation recovers #627/#628, not genuine schema errors or prose', () => {
  const candidate = incompleteCodingToolError({ toolName: 'write', isError: true, text: missingPath });
  const requestBudget = serializedProviderOutputBudget({ max_completion_tokens: 2048 });
  const input = { candidates: [candidate], requestBudget };
  assert.deepEqual(verifiedCodingToolTruncation({ ...input, outputTokens: 2048, stopReason: 'toolUse' }), {
    ...candidate, ceiling: 2048, outputTokens: 2048,
  });
  assert.equal(verifiedCodingToolTruncation({ ...input, outputTokens: 1300, stopReason: 'toolUse' }), null);
  assert.equal(verifiedCodingToolTruncation({ ...input, outputTokens: 2048, stopReason: 'error' }), null);
  assert.equal(verifiedCodingToolTruncation({ ...input, outputTokens: 2048, stopReason: 'aborted' }), null);
  assert.equal(verifiedCodingToolTruncation({ ...input, outputTokens: 2048,
    requestBudget: serializedProviderOutputBudget({}) }), null);
  assert.equal(verifiedCodingToolTruncation({ candidates: [], requestBudget,
    outputTokens: 2048, stopReason: 'length' }), null, 'a reasoning-only ceiling is not tool transport evidence');
});

test('#633 explicit output-limit error needs no usage but never recovers cancellation', () => {
  const candidate = incompleteCodingToolError({
    toolName: 'write', isError: true,
    text: 'Tool call "write" hit the output token limit; arguments may be truncated',
  });
  const requestBudget = serializedProviderOutputBudget({ max_completion_tokens: 2048 });
  assert.deepEqual(verifiedCodingToolTruncation({
    candidates: [candidate], requestBudget, outputTokens: null, stopReason: 'toolUse',
  }), { ...candidate, ceiling: 2048, outputTokens: null });
  assert.equal(verifiedCodingToolTruncation({
    candidates: [candidate], requestBudget, outputTokens: null, stopReason: 'aborted',
  }), null);
  assert.equal(verifiedCodingToolTruncation({
    candidates: [candidate], requestBudget: serializedProviderOutputBudget({}),
    outputTokens: null, stopReason: 'toolUse',
  }), null);
});

test('#633 correction never offers a deferred tool, and shares the one-shot large budget', () => {
  assert.deepEqual(codingTruncationCorrectionTool('write', ['write', 'begin_coding_session']),
    { tool: 'write', mode: 'direct' });
  assert.deepEqual(codingTruncationCorrectionTool('write', ['begin_coding_session']),
    { tool: 'begin_coding_session', mode: 'handoff' });
  assert.deepEqual(codingTruncationCorrectionTool('write', ['edit']),
    { tool: 'edit', mode: 'split' });
  assert.equal(codingTruncationCorrectionTool('write', ['read', 'submit_result']), null);
  const c = new ProgressController(stageConfig('implementer'), {});
  c.applyPreparedImplementation({ status: 'prepared', plan: ['write'], complexity: 'normal', evidenceBudget: 0, largeMutation: false });
  assert.equal(c.grantTruncatedCodingToolBudget(), true);
  assert.equal(c.largeMutationBudgetSource, 'transport_recovery');
  assert.equal(c.grantTruncatedCodingToolBudget(), false);
  assert.equal(c.activateLargeMutationBudget(), true);
  assert.match(c.checkToolCall('bash', { command: 'echo test' }).reason, /elevated mutation budget/);
  c.resetLargeMutationBudget();
  assert.equal(c.largeMutationBudgetState, 'idle');
});

test('#633 runtime replay: schema rejection at 2048 grants ONE bounded 16k mutation request, fail-closed if wire cap mismatches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-633-'));
  try {
    const loader = path.join(dir, 'typebox-stub.mjs');
    fs.writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'typebox') return {
        url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
        shortCircuit: true,
      };
      return nextResolve(specifier, context);
    }`);
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';
      const { registerMutationScope } = await import(${JSON.stringify(new URL('../scripts/pi-common/accepted-mutation-scope.mjs', import.meta.url).href)});
      const { default: runtime } = await import(${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)});
      process.env.PI_STAGE = 'implementer';
      process.env.PI_RESUME_ACTIVE = 'true';
      const handlers = new Map(), models = [], directives = [];
      let tools = ['write', 'edit', 'safe_edit', 'accept_mutation_scope', 'request_large_mutation_budget', 'begin_coding_session', 'submit_result'];
      let aborted = 0;
      const ctx = { cwd: ${JSON.stringify(dir)}, model: { id: 'model', maxTokens: 2048 }, abort: () => { aborted += 1; } };
      const pi = {
        on: (name, fn) => handlers.set(name, fn),
        registerTool: () => {},
        getActiveTools: () => [...tools],
        setActiveTools: names => { tools = [...names]; },
        setModel: async model => { models.push(model.maxTokens); ctx.model = model; return true; },
        sendUserMessage: async text => { directives.push(text); },
      };
      const defs = names => names.map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
      const git = (...args) => execFileSync('git', args, { cwd: ctx.cwd });
      git('init', '-q');
      git('config', 'user.name', 'Replay');
      git('config', 'user.email', 'replay@example.invalid');
      fs.writeFileSync(path.join(ctx.cwd, 'base.txt'), 'baseline\\n');
      git('add', '-A');
      git('commit', '-qm', 'baseline');
      git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
      registerMutationScope({
        cwd: ctx.cwd, paths: ['done.txt'], disposition: 'publishable',
        rationale: 'Intended output required by the issue.', env: process.env,
      });
      runtime(pi);
      handlers.get('turn_start')({ turnIndex: 0 });
      const original = handlers.get('before_provider_request')({
        payload: { messages: [{ role: 'user', content: 'implement' }], tools: defs(tools), max_completion_tokens: 2048 },
      }, ctx);
      assert.ok(original.tools.some(t => t.function.name === 'write'));
      assert.ok(original.tool_choice === 'required');
      await handlers.get('tool_result')({
        toolName: 'write', toolCallId: 'partial-627', isError: true,
        content: [{ type: 'text', text: ${JSON.stringify(missingPath)} }],
      }, ctx);
      await handlers.get('turn_end')({
        turnIndex: 0, message: { stopReason: 'toolUse', usage: { output: 2048 } },
      }, ctx);
      assert.ok(models.includes(16384), 'one-shot elevated model cap must be applied');
      assert.ok(directives.some(x => x.includes('VERIFIED CODING TOOL TRANSPORT TRUNCATION')));
      handlers.get('turn_start')({ turnIndex: 1 });
      const corrected = handlers.get('before_provider_request')({
        payload: { messages: [{ role: 'user', content: 'continue' }], tools: defs(tools), max_completion_tokens: 16384 },
      }, ctx);
      assert.equal(corrected.tool_choice, 'required');
      assert.deepEqual(corrected.tools.map(t => t.function.name).sort(), ['accept_mutation_scope', 'write']);
      assert.equal(aborted, 0);

      // A successful tool call must pass accepted-scope, containment and
      // journal guards before the simulated executor mutates the worktree.
      const allowed = await handlers.get('tool_call')({
        toolName: 'write', toolCallId: 'corrected-write',
        input: { path: 'done.txt', content: 'safe output\\n' },
      }, ctx);
      assert.ok(!allowed?.block, allowed?.reason);
      fs.writeFileSync(path.join(ctx.cwd, 'done.txt'), 'safe output\\n');
      await handlers.get('tool_execution_end')({
        toolName: 'write', toolCallId: 'corrected-write', isError: false,
        result: { content: [{ type: 'text', text: 'Write succeeded' }] },
      }, ctx);
      await handlers.get('turn_end')({
        turnIndex: 1, message: { stopReason: 'toolUse', usage: { output: 180 } },
      }, ctx);
      assert.equal(aborted, 0);
      assert.equal(fs.readFileSync(path.join(ctx.cwd, 'done.txt'), 'utf8'), 'safe output\\n');
      assert.equal(ctx.model.maxTokens, 2048, 'successful correction must restore the normal cap');

      // A later independent truncation is allowed after recovered progress.
      handlers.get('turn_start')({ turnIndex: 2 });
      handlers.get('before_provider_request')({
        payload: { messages: [{ role: 'user', content: 'new file' }], tools: defs(tools), max_completion_tokens: 2048 },
      }, ctx);
      await handlers.get('tool_result')({
        toolName: 'write', toolCallId: 'second-incident', isError: true,
        content: [{ type: 'text', text: ${JSON.stringify(missingPath)} }],
      }, ctx);
      await handlers.get('turn_end')({
        turnIndex: 2, message: { stopReason: 'toolUse', usage: { output: 2048 } },
      }, ctx);
      assert.equal(aborted, 0, 'independent truncation remains eligible');
      assert.equal(ctx.model.maxTokens, 16384);
      handlers.get('turn_start')({ turnIndex: 3 });
      handlers.get('before_provider_request')({
        payload: { messages: [{ role: 'user', content: 'retry new file' }], tools: defs(tools), max_completion_tokens: 16384 },
      }, ctx);
      await handlers.get('tool_result')({
        toolName: 'write', toolCallId: 'repeat-second-incident', isError: true,
        content: [{ type: 'text', text: ${JSON.stringify(missingPath)} }],
      }, ctx);
      await handlers.get('turn_end')({
        turnIndex: 3, message: { stopReason: 'toolUse', usage: { output: 16384 } },
      }, ctx);
      assert.equal(aborted, 1, 'repeated truncation within one correction must terminate');
    `;
    const run = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, PI_STAGE: 'implementer', PI_RESUME_ACTIVE: 'true' },
    });
    assert.equal(run.status, 0, [run.stdout, run.stderr].join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
