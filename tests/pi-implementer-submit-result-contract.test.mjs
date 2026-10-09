import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertImplementerFileSet, normalizeImplementerFiles } from '../scripts/pi-common/implementer-result.mjs';
import {
  assertCodingBehavioralValidation,
  codingSessionSubmissionReadiness,
  invalidateCodingBehavioralValidation,
  recordCodingBehavioralValidation,
  repositoryFingerprintRequiresValidation,
  requiredCodingPytestTargets,
  requiredPreparedOutputPaths,
} from '../scripts/pi-common/coding-session-validation.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULT_TOOL_URL = new URL('../scripts/pi-implementer-result-tool.mjs', import.meta.url).href;
const SCOPE_TOOL_URL = new URL('../scripts/pi-common/accepted-mutation-scope.mjs', import.meta.url).href;

const TYPEBOX_LOADER = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox') {
    const source = \`
      const optional = schema => ({ ...schema, __optional: true });
      export const Type = {
        String: (options = {}) => ({ type: 'string', ...options }),
        Boolean: (options = {}) => ({ type: 'boolean', ...options }),
        Array: (items, options = {}) => ({ type: 'array', items, ...options }),
        Optional: optional,
        Object: (properties, options = {}) => {
          const normalized = {};
          const required = [];
          for (const [name, schema] of Object.entries(properties)) {
            const { __optional, ...rest } = schema;
            normalized[name] = rest;
            if (!__optional) required.push(name);
          }
          return { type: 'object', properties: normalized, required, ...options };
        },
      };
    \`;
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}`;

function writeLoader(dir) {
  const loader = path.join(dir, 'typebox-loader.mjs');
  fs.writeFileSync(loader, TYPEBOX_LOADER);
  return loader;
}

function runProgram({ dir, program, env = {}, cwd = PROJECT_ROOT }) {
  const loader = writeLoader(dir);
  const bootstrap = `
    import { register } from 'node:module';
    import { pathToFileURL } from 'node:url';
    register(pathToFileURL(${JSON.stringify(loader)}), import.meta.url);
    ${program}
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
  });
}

function configureTestGit(git) {
  git('config', 'user.name', 'Pi Test');
  git('config', 'user.email', 'pi@example.invalid');
  git('config', 'commit.gpgsign', 'false');
}

function cleanGitWorktree(root) {
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  fs.mkdirSync(work);
  const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
  git('init');
  configureTestGit(git);
  git('remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(work, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  git('branch', '-M', 'dev');
  git('push', '-u', 'origin', 'dev');
  return work;
}

function runSuccessfulSubmit({ modeEnv, params, files = {}, acceptedFiles = Object.keys(files), expectedError = null, upstreamFiles = {}, checkpointCommit = false, savedUpstreamPatch = false, submissionFirstAttempt = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-success-'));
  const work = cleanGitWorktree(root);
  if (Object.keys(upstreamFiles).length) {
    const upstream = path.join(root, 'upstream');
    execFileSync('git', ['clone', '--branch', 'dev', path.join(root, 'remote.git'), upstream]);
    const upstreamGit = (...args) => execFileSync('git', args, { cwd: upstream, encoding: 'utf8' });
    configureTestGit(upstreamGit);
    for (const [file, content] of Object.entries(upstreamFiles)) {
      fs.mkdirSync(path.dirname(path.join(upstream, file)), { recursive: true });
      fs.writeFileSync(path.join(upstream, file), content);
    }
    upstreamGit('add', '-A');
    upstreamGit('commit', '-m', 'Update dev upstream');
    if (savedUpstreamPatch) fs.writeFileSync(
      path.join(root, 'upstream.patch'),
      upstreamGit('show', '--format=', '--binary', 'HEAD'),
    );
    upstreamGit('push', 'origin', 'dev');
  }
  const context = path.join(root, 'issue.json');
  const resultFile = path.join(root, 'result.json');
  fs.writeFileSync(context, JSON.stringify({
    number: 361,
    title: 'Strengthen Implementer submit_result schema and retry behavior',
    body: 'Test context',
  }));

  try {
    const program = `
      const { default: registerResultTool } = await import(${JSON.stringify(RESULT_TOOL_URL)});
      const { registerMutationScope } = await import(${JSON.stringify(SCOPE_TOOL_URL)});
      const fs = await import('node:fs');
      const path = await import('node:path');
      let tool;
      const entries = [];
      const tools = new Map();
      const hooks = new Map();
      const ctx = { cwd: process.cwd(), model: { maxTokens: 16384, contextWindow: 262144 }, abort() {} };
      const pi = {
        registerTool(value) { tools.set(value.name, value); if (value.name === 'submit_result') tool = value; },
        appendEntry(type, data) { entries.push({ type, data }); },
        on(event, fn) { hooks.set(event, [...(hooks.get(event) || []), fn]); },
        setActiveTools() {},
        async setModel(model) { ctx.model = model; return true; },
        async sendUserMessage() {},
      };
      const emit = async (event, data) => {
        let result;
        for (const fn of hooks.get(event) || []) result = await fn(data, ctx) ?? result;
        return result;
      };
      registerResultTool(pi);
      const accepted = ${JSON.stringify(acceptedFiles)};
      if (accepted.length) registerMutationScope({
        cwd: process.cwd(),
        paths: accepted,
        rationale: 'These files implement the trusted test issue',
      });
      for (const [file, content] of Object.entries(${JSON.stringify(files)})) {
        fs.mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
        fs.writeFileSync(path.join(process.cwd(), file), content);
      }
      if (${JSON.stringify(checkpointCommit)}) {
        const { execFileSync } = await import('node:child_process');
        execFileSync('git', ['add', '-A']);
        execFileSync('git', ['commit', '-m', 'checkpoint']);
      }
      try {
        const params = ${JSON.stringify(params)};
        if (process.env.PI_RESUME_ACTIVE !== 'true' && process.env.PI_VALIDATION_REPAIR !== 'true' &&
            !params.already_satisfied && !params.blocked_reason) {
          const begin = { toolName: 'begin_result_submission', toolCallId: 'begin-1', input: {} };
          await emit('tool_call', begin);
          await tools.get('begin_result_submission').execute(begin.toolCallId, {});
          await emit('tool_execution_end', { toolCallId: begin.toolCallId, toolName: begin.toolName, isError: false });
          await emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: begin.toolCallId, name: begin.toolName }] } });
          await emit('turn_end', { message: { stopReason: 'toolUse' } });
          await emit('before_provider_request', { payload: { max_completion_tokens: 4096,
            tools: [{ function: { name: 'submit_result' } }, { function: { name: 'write' } }] } });
          const firstAttempt = ${JSON.stringify(submissionFirstAttempt)};
          if (firstAttempt) {
            if (firstAttempt === 'blank') {
              await emit('tool_call', { toolName: 'submit_result', toolCallId: 'blank-first',
                input: { resultText: '   ' } });
            }
            await emit('message_end', { message: { role: 'assistant',
              stopReason: firstAttempt === 'prose' ? 'stop' : 'toolUse',
              content: firstAttempt === 'prose' ? [{ type: 'text', text: 'Done.' }]
                : [{ type: 'toolCall', id: 'blank-first', name: 'submit_result' }] } });
            if (firstAttempt === 'blank') {
              let invalidRejected = false;
              try { await tool.execute('blank-first', { resultText: '   ' }); }
              catch (error) { invalidRejected = error.message.includes('result_submission_not_complete'); }
              if (!invalidRejected) throw new Error('Blank resultText incorrectly accepted');
              await emit('tool_execution_end', { toolCallId: 'blank-first',
                toolName: 'submit_result', isError: true });
            }
            await emit('turn_end', { message: { stopReason: firstAttempt === 'prose' ? 'stop' : 'toolUse' } });
            const correction = await emit('before_provider_request', { payload: {
              max_completion_tokens: 4096, tools: [{ function: { name: 'submit_result' } }]
            } });
            if (correction?.tools?.length !== 1) throw new Error('Missing correction-only provider surface');
          }
          await emit('tool_call', { toolName: 'submit_result', toolCallId: 'submit', input: params });
          await emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'submit', name: 'submit_result' }] } });
        }
        const result = await tool.execute('submit', params);
        console.log(JSON.stringify({ result, entries }));
      } catch (error) {
        console.log(JSON.stringify({ error: error.message, code: error.code }));
      }
    `;
    const child = runProgram({
      dir: root,
      cwd: work,
      program,
      env: {
        // The git fixture cwd is intentionally temporary, while repository
        // configuration/contracts are loaded from the real control checkout.
        GITHUB_WORKSPACE: PROJECT_ROOT,
        PI_ISSUE: '361',
        PI_ISSUE_CONTEXT: context,
        PI_IMPLEMENTER_RESULT_FILE: resultFile,
        PI_RESUME_ACTIVE: 'false',
        PI_VALIDATION_REPAIR: 'false',
        ...modeEnv,
        ...(savedUpstreamPatch ? { PI_RESUME_PATCH: path.join(root, 'upstream.patch') } : {}),
      },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const output = JSON.parse(child.stdout.trim().split('\n').at(-1));
    if (expectedError) {
      assert.match(output.error ?? '', expectedError);
      assert.equal(fs.existsSync(resultFile), false, 'rejected submission must not produce publication metadata');
      return { output, metadata: null };
    }
    assert.equal(output.error, undefined, output.error);
    return {
      output,
      metadata: JSON.parse(fs.readFileSync(resultFile, 'utf8')),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('text-only result submission advertises no model-owned publication metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-result-contract-'));
  try {
    const program = `
      import assert from 'node:assert/strict';
      const { default: registerResultTool, resultProviderBudgetEvidence } = await import(${JSON.stringify(RESULT_TOOL_URL)});
      const registered = new Map();
      let settle;
      const pi = {
        registerTool(value) { registered.set(value.name, value); },
        appendEntry() {},
        getActiveTools() { return ['begin_result_submission', 'submit_result']; },
        on(event, fn) { if (event === 'agent_before_settle') settle = fn; },
      };
      registerResultTool(pi);
      const tool = registered.get('submit_result');
      assert.deepEqual(Object.keys(tool.parameters.properties), ['resultText', 'already_satisfied', 'blocked_reason']);
      assert.deepEqual(tool.parameters.required, []);
      assert.equal(tool.parameters.additionalProperties, false, 'legacy files strings are never valid terminal metadata');
      assert.equal(registered.get('begin_result_submission').parameters.additionalProperties, false);
      assert.equal(resultProviderBudgetEvidence({ max_completion_tokens: 4096 }, 4096).verified, true);
      assert.equal(resultProviderBudgetEvidence({ max_completion_tokens: 2048 }, 4096).verified, false);
      await assert.rejects(tool.execute('early', { resultText: 'A complete Markdown result.' }),
        error => JSON.parse(error.message).code === 'result_submission_not_complete');
      const nudge = settle();
      assert.match(nudge.entries[0].content, /begin_result_submission/);
    `;
    const child = runProgram({ dir, program, env: { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' } });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh submission uses a new submit-only provider request and one truncation-only 8192 retry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-phase-'));
  try {
    const program = `
      import assert from 'node:assert/strict';
      const { default: registerResultTool } = await import(${JSON.stringify(RESULT_TOOL_URL)});
      const tools = new Map();
      const hooks = new Map();
      const caps = [];
      const steers = [];
      const visible = [];
      let aborts = 0;
      const ctx = { cwd: process.cwd(), model: { maxTokens: 2048, contextWindow: 262144 }, abort() { aborts++; } };
      const pi = {
        registerTool(value) { tools.set(value.name, value); },
        appendEntry() {},
        on(name, fn) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
        getActiveTools() { return [...visible]; },
        setActiveTools(names) { visible.splice(0, visible.length, ...names); },
        async setModel(model) { caps.push(model.maxTokens); ctx.model = model; return true; },
        async sendUserMessage(text) { steers.push(text); },
      };
      const emit = async (name, event) => {
        let output;
        for (const fn of hooks.get(name) ?? []) {
          const result = await fn(event, ctx);
          if (result?.block) return result;
          if (result !== undefined) output = result;
        }
        return output;
      };
      registerResultTool(pi);
      assert.deepEqual([...tools.keys()].sort(), ['begin_result_submission', 'submit_result']);
      assert.equal(await emit('tool_call', { toolName: 'submit_result', toolCallId: 'early', input: { resultText: 'Too early' } }).then(x => x?.block), true);
      const begin = { toolName: 'begin_result_submission', toolCallId: 'begin', input: {} };
      assert.equal(await emit('tool_call', begin), undefined);
      await tools.get('begin_result_submission').execute('begin', {});
      await emit('tool_execution_end', { ...begin, isError: false });
      await emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'begin', name: 'begin_result_submission' }] } });
      await emit('turn_end', { message: { stopReason: 'toolUse' } });
      assert.deepEqual(caps, [4096]);
      assert.deepEqual(visible, ['submit_result']);
      assert.equal(steers.length, 1);
      const outgoing = await emit('before_provider_request', { payload: {
        max_completion_tokens: 4096, tools: ['read', 'write', 'submit_result'].map(name => ({ function: { name } }))
      } });
      assert.deepEqual(outgoing.tools.map(tool => tool.function.name), ['submit_result']);
      assert.equal(outgoing.tool_choice, 'auto');
      assert.equal((await emit('tool_call', { toolName: 'write', toolCallId: 'late', input: {} })).block, true);
      await emit('message_end', { message: { role: 'assistant', stopReason: 'length',
        usage: { inputTokens: 500 }, content: [] } });
      await emit('turn_end', { message: { stopReason: 'length' } });
      assert.deepEqual(caps, [4096, 8192]);
      const retry = await emit('before_provider_request', { payload: {
        max_completion_tokens: 8192, tools: ['read', 'submit_result'].map(name => ({ function: { name } }))
      } });
      assert.deepEqual(retry.tools.map(tool => tool.function.name), ['submit_result']);
      const fullResult = 'Complete implementation and tests. '.repeat(500);
      const submit = { toolName: 'submit_result', toolCallId: 'finished', input: { resultText: fullResult } };
      assert.equal(await emit('tool_call', submit), undefined);
      await emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: submit.toolCallId, name: 'submit_result' }] } });
      // The Git terminal executor has a separate fixture; here simulate its successful receipt.
      await emit('tool_execution_end', { ...submit, isError: false });
      assert.deepEqual(caps, [4096, 8192, 2048], 'restore parent budget after successful terminal tool');
      await emit('turn_end', { message: { stopReason: 'toolUse' } });
      assert.equal(aborts, 0);
      assert.equal((await emit('tool_call', { toolName: 'read', toolCallId: 'after', input: {} })).block, true);
      assert.equal(caps.length, 3, 'only the dedicated budgets and the final restore run');
    `;
    const child = runProgram({ dir, program, env: { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' } });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#640 a corrected prose or blank resultText reaches the real terminal executor', () => {
  for (const first of ['prose', 'blank']) {
    const result = runSuccessfulSubmit({
      modeEnv: {},
      params: { resultText: 'Complete implementation description after format correction.' },
      files: { 'src/corrected.txt': 'corrected implementation\\n' },
      submissionFirstAttempt: first,
    });
    assert.equal(result.metadata.outcome, 'changed', first);
    assert.deepEqual(result.metadata.files, ['src/corrected.txt']);
    assert.match(result.metadata.result_text, /after format correction/);
  }
});

test('#640 separate correction and truncation limits never reopen coding or exceed three requests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-correction-'));
  try {
    const program = `
      import assert from 'node:assert/strict';
      const { default: registerResultTool, restrictResultSubmissionPayload,
        RESULT_SUBMISSION_MAX_REQUESTS } = await import(${JSON.stringify(RESULT_TOOL_URL)});
      assert.equal(RESULT_SUBMISSION_MAX_REQUESTS, 3);
      const openai = restrictResultSubmissionPayload({ tools: [
        { type: 'function', function: { name: 'write' } },
        { type: 'function', function: { name: 'submit_result' } },
      ] });
      assert.deepEqual(openai.tools.map(t => t.function.name), ['submit_result']);
      assert.deepEqual(openai.tool_choice, { type: 'function', function: { name: 'submit_result' } });
      const responses = restrictResultSubmissionPayload({ tools: [{ type: 'function', name: 'submit_result' }] });
      assert.deepEqual(responses.tool_choice, { type: 'function', name: 'submit_result' });
      for (const invalid of [
        { tools: [{ type: 'unknown', function: { name: 'submit_result' } }] },
        { tools: [{ type: 'function', function: { name: 'submit_result' } }], tool_choice: { type: 'unknown' } },
        { tools: [{ type: 'function', function: { name: 'submit_result' } }], toolChoice: 'auto' },
        { tools: [{ type: 'function', function: { name: 'submit_result' } }, { type: 'function', function: { name: 'submit_result' } }] },
        { tools: { submit_result: true } },
      ]) {
        const closed = restrictResultSubmissionPayload(invalid);
        assert.deepEqual(closed.tools, []);
        assert.equal(closed.tool_choice, 'none');
      }
      function harness(contextWindow = 262144) {
        const tools = new Map(), hooks = new Map(), caps = [], steers = [], surfaces = [];
        let aborts = 0;
        const ctx = { model: { maxTokens: 2048, contextWindow },
          abort() { aborts++; } };
        const pi = {
          registerTool(tool) { tools.set(tool.name, tool); }, appendEntry() {},
          on(name, callback) { hooks.set(name, [...(hooks.get(name) || []), callback]); },
          getActiveTools() { return ['submit_result']; },
          setActiveTools(names) { surfaces.push([...names]); },
          async setModel(model) { caps.push(model.maxTokens); ctx.model = model; return true; },
          async sendUserMessage(text) { steers.push(text); },
        };
        const emit = async (name, data) => {
          let value;
          for (const fn of hooks.get(name) || []) {
            const next = await fn(data, ctx);
            if (next?.block) return next;
            if (next !== undefined) value = next;
          }
          return value;
        };
        registerResultTool(pi);
        return { tools, emit, caps, steers, surfaces, aborts: () => aborts, ctx, requests: 0 };
      }
      async function begin(h) {
        const e = { toolName: 'begin_result_submission', toolCallId: 'begin', input: {} };
        assert.equal(await h.emit('tool_call', e), undefined);
        await h.tools.get(e.toolName).execute(e.toolCallId, {});
        await h.emit('tool_execution_end', { ...e, isError: false });
        await h.emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'toolCall', name: e.toolName, id: e.toolCallId }] } });
        await h.emit('turn_end', { message: { stopReason: 'toolUse' } });
        assert.deepEqual(h.surfaces, [['submit_result']]);
        assert.equal(h.caps[0], 4096);
      }
      async function request(h, budget = 4096, toolChoice = 'auto') {
        h.requests++;
        const response = await h.emit('before_provider_request', { payload: {
          max_completion_tokens: budget, tool_choice: toolChoice,
          tools: ['read', 'write', 'bash', 'run_check', 'submit_result'].map(name =>
            ({ type: 'function', function: { name } })),
        } });
        assert.deepEqual(response.tools.map(t => t.function.name), ['submit_result']);
        for (const name of ['read', 'write', 'edit', 'bash', 'run_check', 'repo_search']) {
          assert.equal((await h.emit('tool_call', { toolName: name, toolCallId: name, input: {} })).block, true);
        }
        return response;
      }
      async function reply(h, reason, calls = [], actualCalls = calls) {
        for (const c of calls) await h.emit('tool_call', { toolName: c.name, toolCallId: c.id, input: c.input });
        await h.emit('message_end', { message: { role: 'assistant', stopReason: reason,
          usage: { inputTokens: 500 },
          content: actualCalls.map(c => ({ type: 'toolCall', id: c.id, name: c.name })) } });
        await h.emit('turn_end', { message: { stopReason: reason } });
      }
      const blank = [{ name: 'submit_result', id: 'blank', input: { resultText: '   ' } }];
      {
        const h = harness(); await begin(h); await request(h);
        await reply(h, 'stop');
        assert.deepEqual(h.caps, [4096, 4096]);
        assert.match(h.steers[1], /FORMAT CORRECTION ONLY/);
        await request(h);
        await reply(h, 'toolUse', blank);
        assert.equal(h.aborts(), 1);
        assert.deepEqual(h.caps, [4096, 4096, 2048]);
        assert.equal(h.requests, 2);
        assert.equal((await h.emit('tool_call', { toolName: 'submit_result', toolCallId: 'late', input: { resultText: 'late' } })).block, true);
      }
      {
        const h = harness(); await begin(h); await request(h);
        await reply(h, 'stop'); await request(h);
        await reply(h, 'length');
        assert.deepEqual(h.caps, [4096, 4096, 8192]);
        assert.match(h.steers[2], /TRUNCATED SUBMISSION/);
        await request(h, 8192); await reply(h, 'stop');
        assert.equal(h.aborts(), 1); assert.equal(h.requests, 3);
        assert.deepEqual(h.caps, [4096, 4096, 8192, 2048]);
      }
      {
        const h = harness(); await begin(h); await request(h);
        await reply(h, 'length');
        assert.deepEqual(h.caps, [4096, 8192]);
        await request(h, 8192); await reply(h, 'stop');
        assert.deepEqual(h.caps, [4096, 8192, 4096]);
        assert.match(h.steers[2], /FORMAT CORRECTION ONLY/);
        await request(h); await reply(h, 'length');
        assert.equal(h.aborts(), 1); assert.equal(h.requests, 3);
        assert.deepEqual(h.caps, [4096, 8192, 4096, 2048]);
      }
      {
        const h = harness(); await begin(h); await request(h);
        const call = { name: 'submit_result', id: 'real', input: { resultText: 'content' } };
        await h.emit('tool_call', { toolName: call.name, toolCallId: call.id, input: call.input });
        await h.emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'toolCall', name: call.name, id: 'forged' }] } });
        await assert.rejects(h.tools.get('submit_result').execute('real', call.input), /result_submission_not_complete/);
        await h.emit('turn_end', { message: { stopReason: 'toolUse' } });
        assert.equal(h.caps.at(-1), 4096); assert.equal(h.aborts(), 0);
      }
      {
        const h = harness(); await begin(h); await request(h);
        const call = { name: 'submit_result', id: 'one', input: { resultText: 'content' } };
        await h.emit('tool_call', { toolName: call.name, toolCallId: call.id, input: call.input });
        assert.equal((await h.emit('tool_call', { toolName: call.name, toolCallId: 'two', input: call.input })).block, true);
        await h.emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'toolCall', name: call.name, id: 'one' },
            { type: 'toolCall', name: call.name, id: 'two' }] } });
        await assert.rejects(h.tools.get('submit_result').execute('one', call.input), /result_submission_not_complete/);
        await h.emit('turn_end', { message: { stopReason: 'toolUse' } });
        assert.equal(h.caps.at(-1), 4096);
      }
      for (const actualBudget of [2048, undefined]) {
        const h = harness(); await begin(h);
        h.requests++;
        const payload = { tools: [{ type: 'function', function: { name: 'submit_result' } }] };
        if (actualBudget !== undefined) payload.max_completion_tokens = actualBudget;
        await h.emit('before_provider_request', { payload });
        const input = { resultText: 'correct' };
        await h.emit('tool_call', { toolName: 'submit_result', toolCallId: 'valid', input });
        await h.emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'valid', name: 'submit_result' }] } });
        await assert.rejects(h.tools.get('submit_result').execute('valid', input), /result_submission_not_complete/);
        await h.emit('turn_end', { message: { stopReason: 'toolUse' } });
        assert.equal(h.aborts(), 1); assert.deepEqual(h.caps, [4096, 2048]);
      }
      {
        const h = harness(); await begin(h);
        await h.emit('before_provider_request', { payload: { max_completion_tokens: 4096,
          tool_choice: { type: 'unknown' },
          tools: [{ type: 'function', function: { name: 'submit_result' } }] } });
        await reply(h, 'stop');
        assert.equal(h.aborts(), 1);
      }
      console.log('bounded correction / truncation / budget / admission cases passed');
    `;
    const child = runProgram({ dir, program, env: { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' } });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.match(child.stdout, /bounded correction/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh-mode snapshot does not permit legacy zero-argument submission', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-mode-snapshot-'));
  try {
    const program = `
      import assert from 'node:assert/strict';
      const { default: registerResultTool } = await import(${JSON.stringify(RESULT_TOOL_URL)});
      let tool;
      registerResultTool({ registerTool(value) { if (value.name === 'submit_result') tool = value; }, appendEntry() {}, on() {} });
      process.env.PI_RESUME_ACTIVE = 'true';
      await assert.rejects(tool.execute('early', {}),
        error => JSON.parse(error.message).code === 'result_submission_not_complete');
    `;
    const child = runProgram({ dir, program, env: { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' } });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restored and validation-repair surfaces cannot advertise missing begin_result_submission', () => {
  for (const modeEnv of [
    { PI_RESUME_ACTIVE: 'true', PI_VALIDATION_REPAIR: 'false' },
    { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'true' },
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-result-existing-mode-'));
    try {
      const program = `
        import assert from 'node:assert/strict';
        const { default: registerTool } = await import(${JSON.stringify(RESULT_TOOL_URL)});
        const { stageConfig } = await import(${JSON.stringify(new URL('../scripts/pi-common/stage-config.mjs', import.meta.url).href)});
        const { actionRequiredToolNames } = await import(${JSON.stringify(new URL('../scripts/pi-common/progress-controller.mjs', import.meta.url).href)});
        const inventory = new Map();
        registerTool({ registerTool(tool) { inventory.set(tool.name, tool); }, appendEntry() {}, on() {} });
        assert.deepEqual([...inventory.keys()], ['submit_result']);
        const config = stageConfig('implementer').productiveProgress;
        const exposed = actionRequiredToolNames([...inventory.keys()], config);
        assert.deepEqual(exposed, ['submit_result']);
        const codingTools = config.codingSessionTools.filter(name => inventory.has(name));
        assert.deepEqual(codingTools, ['submit_result']);
      `;
      const child = runProgram({ dir, program, env: modeEnv });
      assert.equal(child.status, 0, child.stderr + child.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('restored and validation-repair work derive changed files with empty submit_result payload', () => {
  for (const modeEnv of [
    { PI_RESUME_ACTIVE: 'true', PI_VALIDATION_REPAIR: 'false' },
    { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'true' },
  ]) {
    const result = runSuccessfulSubmit({
      modeEnv,
      params: {},
      files: { 'src/restored.txt': 'restored content\\n' },
    });
    assert.equal(result.metadata.outcome, 'changed');
    assert.deepEqual(result.metadata.files, ['src/restored.txt']);
    assert.deepEqual(result.metadata.changes, ['src/restored.txt']);
    assert.equal(result.metadata.scope_enforcement, 'predeclared');
  }

  runSuccessfulSubmit({
    modeEnv: { PI_RESUME_ACTIVE: 'true', PI_VALIDATION_REPAIR: 'false' },
    params: {},
    expectedError: /lacks trusted replay proof/,
  });
  runSuccessfulSubmit({
    modeEnv: { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'true' },
    params: {},
    expectedError: /lacks trusted replay proof/,
  });
  const proven = runSuccessfulSubmit({
    modeEnv: { PI_RESUME_ACTIVE: 'true', PI_VALIDATION_REPAIR: 'false' },
    params: {},
    upstreamFiles: { 'src/proven.txt': 'already integrated\\n' },
    savedUpstreamPatch: true,
  });
  assert.equal(proven.metadata.outcome, 'already_satisfied');
  assert.deepEqual(proven.metadata.files, []);
});

test('fresh already_satisfied and blocked result shapes still execute successfully', () => {
  const satisfied = runSuccessfulSubmit({
    modeEnv: { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' },
    params: { already_satisfied: true },
  });
  assert.equal(satisfied.metadata.already_satisfied, true);
  assert.equal(satisfied.metadata.outcome, 'already_satisfied');

  const blocked = runSuccessfulSubmit({
    modeEnv: { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' },
    params: { blocked_reason: 'Requirement A contradicts requirement B.' },
  });
  assert.equal(blocked.metadata.outcome, 'blocked');
  assert.equal(blocked.metadata.blocked_reason, 'Requirement A contradicts requirement B.');
});


test('#424 fresh submit_result exposes targeted mutation cleanup for accidental scratch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-mutation-cleanup-'));
  const work = cleanGitWorktree(root);
  const context = path.join(root, 'issue.json');
  const resultFile = path.join(root, 'result.json');
  const journalFile = path.join(root, 'mutation-journal.json');
  fs.writeFileSync(context, JSON.stringify({
    number: 424,
    title: 'Persist targeted mutation undo',
    body: 'Test context',
  }));

  try {
    const journalUrl = new URL('../scripts/pi-common/mutation-journal.mjs', import.meta.url).href;
    const snapshotUrl = new URL('../scripts/pi-common/mutation-snapshot.mjs', import.meta.url).href;
    const program = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      const { default: registerResultTool } = await import(${JSON.stringify(RESULT_TOOL_URL)});
      const journal = await import(${JSON.stringify(journalUrl)});
      const snapshots = await import(${JSON.stringify(snapshotUrl)});

      let tool;
      const pi = {
        registerTool(value) { if (value.name === 'submit_result') tool = value; },
        appendEntry() {},
        on() {},
      };
      registerResultTool(pi);
      const { registerMutationScope } = await import(${JSON.stringify(SCOPE_TOOL_URL)});
      registerMutationScope({ cwd: process.cwd(), paths: ['feature.py'], rationale: 'Feature output needed by issue' });

      fs.writeFileSync(path.join(process.cwd(), 'feature.py'), 'value = 1\\n');
      const before = snapshots.captureMutationSnapshot(process.cwd(), '.probe.txt');
      fs.writeFileSync(path.join(process.cwd(), '.probe.txt'), 'scratch\\n');
      const after = snapshots.captureMutationSnapshot(process.cwd(), '.probe.txt');
      const entry = journal.recordSuccessfulMutation({
        cwd: process.cwd(),
        before,
        after,
        tool: 'write',
        disposition: 'temporary',
        env: process.env,
      });

      await assert.rejects(
        tool.execute('submit', {}),
        error => {
          assert.match(error.message, /Targeted cleanup available/);
          assert.match(error.message, new RegExp(entry.id));
          assert.match(error.message, /undo_mutation/);
          assert.match(error.message, /expected_files:\\["feature.py"\\]/);
          return true;
        },
      );
    `;
    const child = runProgram({
      dir: root,
      cwd: work,
      program,
      env: {
        GITHUB_WORKSPACE: PROJECT_ROOT,
        PI_ISSUE: '424',
        PI_ISSUE_CONTEXT: context,
        PI_IMPLEMENTER_RESULT_FILE: resultFile,
        PI_MUTATION_JOURNAL_FILE: journalFile,
        PI_RESUME_ACTIVE: 'true',
        PI_VALIDATION_REPAIR: 'false',
      },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('#469 terminal result paths reject non-repository forms with INVALID_RESULT_PATH', () => {
  for (const value of [
    '/tmp/tests/test_x.py',
    'C:\\work\\tests\\test_x.py',
    'C:/work/tests/test_x.py',
    '../tests/test_x.py',
    'file:///work/tests/test_x.py',
    'https://example.invalid/test_x.py',
  ]) {
    assert.throws(
      () => normalizeImplementerFiles([value]),
      error => error?.code === 'INVALID_RESULT_PATH' && /INVALID_RESULT_PATH/.test(error.message),
      value,
    );
  }
  assert.deepEqual(
    normalizeImplementerFiles(['tests/test_x.py', 'src/x.py', 'tests/test_x.py']),
    ['src/x.py', 'tests/test_x.py'],
  );
});

test('#470 valid git filenames with colon or backslash survive result file-set validation', () => {
  const files = ['file:notes.txt', 'foo:bar.txt', 'dir\\literal.txt'];
  assert.deepEqual(normalizeImplementerFiles(files), ['dir\\literal.txt', 'file:notes.txt', 'foo:bar.txt']);
  assert.deepEqual(assertImplementerFileSet(files, files), ['dir\\literal.txt', 'file:notes.txt', 'foo:bar.txt']);
  assert.deepEqual(
    requiredCodingPytestTargets(['src/game.py', 'dir\\test_game.py']),
    [],
    'a literal backslash in a git filename is never reinterpreted as a directory separator for pytest coverage',
  );
});


test('#630 model-supplied files (including a JSON string) never control runtime publication', () => {
  const three = {
    'src/app.py': 'VALUE = 1\\n',
    'src/helper.py': 'VALUE = 2\\n',
    'tests/test_app.py': 'def test_ok():\\n    assert True\\n',
  };
  const params = { resultText: 'Use runtime-owned publication files.\\n\\n- Add feature and test.' };
  const allowed = runSuccessfulSubmit({
    modeEnv: {},
    params,
    files: three,
  });
  assert.deepEqual(allowed.metadata.files, Object.keys(three).sort());
  assert.deepEqual(allowed.metadata.changes, Object.keys(three).sort());
  assert.equal(allowed.metadata.accepted_scope.accepted.length, 3);

  const rejected = runSuccessfulSubmit({
    modeEnv: {},
    params,
    files: three,
    acceptedFiles: ['src/app.py', 'src/helper.py'],
    expectedError: /accepted_scope_violation/,
  });
  assert.match(rejected.output.error, /tests\/test_app.py/);

  runSuccessfulSubmit({
    modeEnv: {},
    params,
    expectedError: /at least one concrete change is required/,
  });
});

test('#630 latest dev changes do not leak into publication and committed checkpoints resume', () => {
  const result = runSuccessfulSubmit({
    modeEnv: { PI_RESUME_ACTIVE: 'true' },
    params: {},
    files: { 'src/from-checkpoint.txt': 'checkpoint output\\n' },
    checkpointCommit: true,
    upstreamFiles: { 'src/upstream-only.txt': 'from newer dev\\n' },
  });
  assert.equal(result.metadata.outcome, 'changed');
  assert.deepEqual(result.metadata.files, ['src/from-checkpoint.txt']);
  assert.deepEqual(result.metadata.changes, ['src/from-checkpoint.txt']);
});

test('#630 conflicting latest dev cannot write a partial publication file list', () => {
  runSuccessfulSubmit({
    modeEnv: {},
    params: { resultText: 'Test deterministic conflict recovery.' },
    files: { 'base.txt': 'local conflicting change\\n' },
    upstreamFiles: { 'base.txt': 'upstream conflicting change\\n' },
    expectedError: /Failed to merge latest dev[\s\S]*Your local changes[\s\S]*base\.txt/,
  });
});

test('#469 coding-session source plus pytest changes require a passing targeted pytest after latest mutation', () => {
  const env = { PI_CODING_SESSION: JSON.stringify({ sessionId: 'coding-469' }) };
  const changedFiles = [
    'src/social_mcp/diagnostics/smoke_connect_four.py',
    'tests/test_smoke_connect_four.py',
  ];
  assert.deepEqual(requiredCodingPytestTargets(changedFiles), ['tests/test_smoke_connect_four.py']);

  assert.throws(
    () => assertCodingBehavioralValidation({ changedFiles, env }),
    error => error?.code === 'TARGETED_BEHAVIORAL_VALIDATION_REQUIRED',
  );
  assert.equal(recordCodingBehavioralValidation({
    scope: { paths: ['src/game.py'] },
    result: { status: 'pass', kind: 'python_compile' },
    env,
  }), null);
  assert.throws(() => assertCodingBehavioralValidation({ changedFiles, env }), /TARGETED_BEHAVIORAL_VALIDATION_REQUIRED/);
  assert.equal(recordCodingBehavioralValidation({
    scope: { targets: ['tests/test_smoke_connect_four.py::test_smoke'] },
    result: { status: 'fail', kind: 'pytest' },
    env,
  }), null);
  assert.throws(() => assertCodingBehavioralValidation({ changedFiles, env }), /TARGETED_BEHAVIORAL_VALIDATION_REQUIRED/);

  const nodeState = recordCodingBehavioralValidation({
    scope: { targets: ['tests/test_smoke_connect_four.py::test_smoke'] },
    result: { status: 'pass', kind: 'pytest' },
    env,
  });
  assert.equal(nodeState, null, 'one pytest node does not validate the rest of a changed test file');
  assert.throws(
    () => assertCodingBehavioralValidation({ changedFiles, env }),
    /TARGETED_BEHAVIORAL_VALIDATION_REQUIRED/,
  );

  recordCodingBehavioralValidation({
    scope: { targets: ['tests/test_smoke_connect_four.py'] },
    result: { status: 'pass', kind: 'pytest' },
    env,
  });
  assert.doesNotThrow(() => assertCodingBehavioralValidation({ changedFiles, env }));

  const unrelatedFailureState = recordCodingBehavioralValidation({
    scope: { targets: ['tests/test_unrelated.py'] },
    result: { status: 'fail', kind: 'pytest' },
    env,
  });
  assert.deepEqual(unrelatedFailureState?.targets, ['tests/test_smoke_connect_four.py']);
  assert.doesNotThrow(
    () => assertCodingBehavioralValidation({ changedFiles, env }),
    'a failing unrelated pytest target must not erase coverage for the required changed test',
  );

  assert.equal(recordCodingBehavioralValidation({
    scope: { targets: ['tests/test_smoke_connect_four.py'] },
    result: { status: 'infra_error', kind: 'pytest' },
    env,
  }), null);
  assert.doesNotThrow(
    () => assertCodingBehavioralValidation({ changedFiles, env }),
    'pytest infrastructure errors carry no behavioral evidence and preserve prior passing coverage',
  );

  assert.equal(recordCodingBehavioralValidation({
    scope: { targets: ['tests/test_smoke_connect_four.py'] },
    result: { status: 'fail', kind: 'pytest' },
    env,
  }), null);
  assert.throws(() => assertCodingBehavioralValidation({ changedFiles, env }), /TARGETED_BEHAVIORAL_VALIDATION_REQUIRED/);

  recordCodingBehavioralValidation({
    scope: { targets: ['tests/test_smoke_connect_four.py'] },
    result: { status: 'pass', kind: 'pytest' },
    env,
  });
  assert.equal(invalidateCodingBehavioralValidation(env), true);
  assert.throws(() => assertCodingBehavioralValidation({ changedFiles, env }), /TARGETED_BEHAVIORAL_VALIDATION_REQUIRED/);
});

test('#470 repository fingerprint validation policy preserves read-only bash and fails closed on uncertainty', () => {
  assert.equal(repositoryFingerprintRequiresValidation('same', 'same'), false);
  assert.equal(repositoryFingerprintRequiresValidation('before', 'after'), true);
  assert.equal(repositoryFingerprintRequiresValidation(null, 'after'), true);
  assert.equal(repositoryFingerprintRequiresValidation('before', null), true);
  assert.equal(repositoryFingerprintRequiresValidation(null, null), true);

  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(runtime, /mutationChanged !== false/);
  assert.match(runtime, /repositoryFingerprintRequiresValidation\(\s*bashValidationFingerprintBefore,\s*bashValidationFingerprintAfter/);
  assert.doesNotMatch(runtime, /if \(!event\.isError && canonicalToolName === 'bash'\)/);
});


test('#470 coding pytest gate ignores deleted/non-test Python files and accepts broader passing scopes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-coding-pytest-scope-'));
  const env = { PI_CODING_SESSION: JSON.stringify({ sessionId: 'coding-scope-470' }) };
  const changedFiles = ['src/game.py', 'tests/test_game.py', 'tests/conftest.py', 'tests/__init__.py'];
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'game.py'), 'VALUE = 1\n');
    fs.writeFileSync(path.join(dir, 'tests', 'test_game.py'), 'def test_value():\n    assert True\n');
    fs.writeFileSync(path.join(dir, 'tests', 'conftest.py'), '# fixture config\n');
    fs.writeFileSync(path.join(dir, 'tests', '__init__.py'), '');

    assert.deepEqual(
      requiredCodingPytestTargets(changedFiles, { cwd: dir }),
      ['tests/test_game.py'],
    );

    recordCodingBehavioralValidation({
      scope: { targets: ['tests'] },
      result: { status: 'pass', kind: 'pytest' },
      env,
      cwd: dir,
    });
    assert.doesNotThrow(() => assertCodingBehavioralValidation({ changedFiles, env, cwd: dir }));

    invalidateCodingBehavioralValidation(env);
    recordCodingBehavioralValidation({
      scope: { profile: 'pytest_all' },
      result: { status: 'pass', kind: 'profile', profile: 'pytest_all' },
      env,
      cwd: dir,
    });
    assert.doesNotThrow(() => assertCodingBehavioralValidation({ changedFiles, env, cwd: dir }));

    invalidateCodingBehavioralValidation(env);
    fs.rmSync(path.join(dir, 'tests', 'test_game.py'));
    assert.deepEqual(
      requiredCodingPytestTargets(['src/game.py', 'tests/test_game.py'], { cwd: dir }),
      [],
      'deleted pytest files are not impossible required targets',
    );
    assert.doesNotThrow(() => assertCodingBehavioralValidation({
      changedFiles: ['src/game.py', 'tests/test_game.py'],
      env,
      cwd: dir,
    }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#470 changed coding submission keeps terminal outcomes reachable when prepared outputs are missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-prepared-output-'));
  const work = cleanGitWorktree(root);
  const context = path.join(root, 'issue.json');
  const resultFile = path.join(root, 'result.json');
  const preparedFile = path.join(root, 'prepared.json');
  fs.writeFileSync(context, JSON.stringify({ number: 470, title: 'Prepared output guard', body: 'Test context' }));
  fs.writeFileSync(preparedFile, JSON.stringify({
    version: 1,
    status: 'prepared',
    plan: ['Create src/required.py'],
    complexity: 'nontrivial',
    evidenceBudget: 0,
    largeMutation: false,
    reason: 'Required source output.',
    workspaceRoot: work,
    freshBaseCommit: '',
    baseRef: 'origin/dev',
    layoutHint: { sourceTarget: 'src/required.py' },
    plannerUsage: null,
    plannerDurationMs: 1,
  }));
  try {
    fs.writeFileSync(path.join(work, 'other.py'), 'VALUE = 1\n');
    const program = `
      const { default: registerResultTool } = await import(${JSON.stringify(RESULT_TOOL_URL)});
      let tool;
      const pi = { registerTool(value) { if (value.name === 'submit_result') tool = value; }, appendEntry() {}, on() {} };
      registerResultTool(pi);
      try {
        await tool.execute('changed', {
          title: 'Changed',
          summary: 'Changed another file.',
          changes: ['Change another file'],
          files: ['other.py'],
          security_notes: 'None.',
          limitations: 'None.',
        });
      } catch (error) {
        console.log('CHANGED_ERROR ' + error.message);
      }
    `;
    const child = runProgram({
      dir: root,
      cwd: work,
      program,
      env: {
        GITHUB_WORKSPACE: PROJECT_ROOT,
        PI_ISSUE: '470',
        PI_ISSUE_CONTEXT: context,
        PI_IMPLEMENTER_RESULT_FILE: resultFile,
        PI_CODING_SESSION: JSON.stringify({ sessionId: 'coding-470' }),
        PI_PREPARED_IMPLEMENTATION_FILE: preparedFile,
        PI_RESUME_ACTIVE: 'false',
        PI_VALIDATION_REPAIR: 'false',
      },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.match(child.stdout, /result_submission_not_complete/);

    const blocked = runSuccessfulSubmit({
      modeEnv: {
        PI_CODING_SESSION: JSON.stringify({ sessionId: 'coding-470-blocked' }),
        PI_PREPARED_IMPLEMENTATION_FILE: preparedFile,
      },
      params: { blocked_reason: 'The required output cannot be produced without contradictory requirements.' },
    });
    assert.equal(blocked.metadata.outcome, 'blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('#469 fresh coding session reports missing prepared outputs until they exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-coding-readiness-'));
  try {
    const prepared = {
      status: 'prepared',
      plan: [
        'Create src/connect_four.py and tests/test_connect_four.py.',
        'Run the targeted smoke test.',
      ],
      layoutHint: {
        sourceTarget: 'src/connect_four.py',
        testTarget: 'tests/test_connect_four.py',
        testTargetRequired: true,
      },
    };
    const blocked = codingSessionSubmissionReadiness({ prepared, cwd: dir, changedFiles: [] });
    assert.equal(blocked.ready, false);
    assert.deepEqual(blocked.missing_outputs, ['src/connect_four.py', 'tests/test_connect_four.py']);

    const unrelatedMutation = codingSessionSubmissionReadiness({
      prepared,
      cwd: dir,
      changedFiles: ['README.md'],
    });
    assert.equal(unrelatedMutation.ready, false);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'connect_four.py'), '# source\n');
    fs.writeFileSync(path.join(dir, 'tests', 'test_connect_four.py'), '# test\n');
    const completeCandidate = codingSessionSubmissionReadiness({
      prepared,
      cwd: dir,
      changedFiles: ['src/connect_four.py', 'tests/test_connect_four.py'],
    });
    assert.equal(completeCandidate.ready, true);

    const resumed = codingSessionSubmissionReadiness({
      prepared,
      cwd: dir,
      changedFiles: [],
      resumed: true,
    });
    assert.equal(resumed.ready, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('#470 inferred test targets are guidance, not mandatory prepared outputs', () => {
  const inferred = {
    status: 'prepared',
    layoutHint: {
      sourceTarget: 'src/widget.py',
      testTarget: 'tests/test_widget.py',
      testTargetRequired: false,
    },
  };
  assert.deepEqual(requiredPreparedOutputPaths(inferred), ['src/widget.py']);

  const explicit = {
    ...inferred,
    layoutHint: { ...inferred.layoutHint, testTargetRequired: true },
  };
  assert.deepEqual(requiredPreparedOutputPaths(explicit), ['src/widget.py', 'tests/test_widget.py']);
});


test('#470 prepared-output gate ignores planner prose and uses only structured layout targets', () => {
  const prepared = {
    status: 'prepared',
    plan: [
      'Delete src/old.py.',
      'Rename a/x.py to a/y.py.',
      'Do not touch docs/foo.md.',
      'Add tests/test_new.py based on https://example.com/a/b.html.',
      'Create src/new.py.',
    ],
    layoutHint: {
      sourceTarget: 'src/structured.py',
      testTarget: 'tests/test_structured.py',
      testTargetRequired: true,
    },
  };

  assert.deepEqual(
    requiredPreparedOutputPaths(prepared),
    ['src/structured.py', 'tests/test_structured.py'],
  );
});


test('#469 targeted pytest state survives coding fork return to parent without resurrecting stale parent env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-coding-validation-state-'));
  const terminal = path.join(dir, 'terminal.json');
  const changedFiles = ['src/game.py', 'tests/test_game.py'];
  const parentEnv = {
    PI_CODING_SESSION_USED: 'true',
    PI_TERMINAL_RESULT_FILE: terminal,
  };
  try {
    recordCodingBehavioralValidation({
      scope: { targets: ['tests/test_game.py'] },
      result: { status: 'pass', kind: 'pytest' },
      env: parentEnv,
    });
    assert.doesNotThrow(() => assertCodingBehavioralValidation({ changedFiles, env: parentEnv }));

    // A fork inherits the parent's env snapshot. Its mutation invalidates the shared file and only
    // its own env copy; the parent must treat the missing shared file as authoritative.
    const childEnv = {
      ...parentEnv,
      PI_CODING_SESSION: JSON.stringify({ sessionId: 'child-469' }),
    };
    assert.equal(invalidateCodingBehavioralValidation(childEnv), true);
    assert.ok(parentEnv.PI_CODING_TARGETED_PYTEST_STATE, 'parent still holds the inherited stale snapshot');
    assert.throws(
      () => assertCodingBehavioralValidation({ changedFiles, env: parentEnv }),
      /TARGETED_BEHAVIORAL_VALIDATION_REQUIRED/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('#469 targeted pytest passes accumulate across files until the next mutation', () => {
  const env = { PI_CODING_SESSION: JSON.stringify({ sessionId: 'coding-multi-469' }) };
  const changedFiles = ['src/game.py', 'tests/test_a.py', 'tests/test_b.py'];

  recordCodingBehavioralValidation({
    scope: { targets: ['tests/test_a.py'] },
    result: { status: 'pass', kind: 'pytest' },
    env,
  });
  assert.throws(
    () => assertCodingBehavioralValidation({ changedFiles, env }),
    error => error?.requiredTargets?.length === 1 && error.requiredTargets[0] === 'tests/test_b.py',
  );

  const state = recordCodingBehavioralValidation({
    scope: { targets: ['tests/test_b.py'] },
    result: { status: 'pass', kind: 'pytest' },
    env,
  });
  assert.deepEqual(state.targets, ['tests/test_a.py', 'tests/test_b.py']);
  assert.doesNotThrow(() => assertCodingBehavioralValidation({ changedFiles, env }));

  invalidateCodingBehavioralValidation(env);
  assert.throws(
    () => assertCodingBehavioralValidation({ changedFiles, env }),
    error => error?.requiredTargets?.length === 2,
  );
});
