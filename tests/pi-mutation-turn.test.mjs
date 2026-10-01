import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyExactEdits,
  applyStagedMutation,
  resolveMutationTarget,
  sha256,
  validateMutationTurnRequest,
} from '../scripts/pi-common/mutation-turn.mjs';
import { MAX_CEILING_WITHOUT_TOOL_TURNS, ProgressController, nextCeilingWithoutToolTurns, truncatedToolCallGuidance } from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mutation-turn-'));
}

function stagedWrite(relPath, content) {
  return { operation: 'write', path: relPath, content, sha256: sha256(content), baseSha256: null };
}

const TYPEBOX_STUB_LOADER = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox') return {
    url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
    shortCircuit: true,
  };
  return nextResolve(specifier, context);
}`;

test('a mutation turn declares only an operation and a contained path', () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'pkg'));
    fs.writeFileSync(path.join(dir, 'pkg', 'mod.py'), 'x = 1\n');
    assert.deepEqual(validateMutationTurnRequest(dir, { operation: 'write', path: 'game.py' }), { operation: 'write', path: 'game.py', expectedContent: null });
    assert.equal(validateMutationTurnRequest(dir, { operation: 'edit', path: 'pkg/mod.py' }).expectedContent, 'x = 1\n');
    // A worktree-absolute path is normalized to the relative declaration.
    assert.equal(validateMutationTurnRequest(dir, { operation: 'write', path: path.join(dir, 'pkg', 'mod.py') }).path, path.join('pkg', 'mod.py'));
    // A full-replacement write never records the old file.
    assert.equal(validateMutationTurnRequest(dir, { operation: 'write', path: 'pkg/mod.py' }).expectedContent, null);
    const rejected = [
      [{ operation: 'write', path: '' }, 'missing_path'],
      [{ operation: 'write' }, 'missing_path'],
      [{ operation: 'write', path: '../outside.py' }, 'invalid_path'],
      [{ operation: 'write', path: '/etc/passwd' }, 'invalid_path'],
      [{ operation: 'write', path: '.git/config' }, 'invalid_path'],
      [{ operation: 'write', path: 'pkg' }, 'invalid_path'],
      [{ operation: 'delete', path: 'game.py' }, 'invalid_operation'],
      [{ operation: 'edit', path: 'missing.py' }, 'missing_target'],
    ];
    for (const [params, code] of rejected) {
      assert.throws(() => validateMutationTurnRequest(dir, params), error => error.code === code, JSON.stringify(params));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('symlinked path components cannot redirect a mutation turn outside the worktree or into .git', () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'link'));
    fs.symlinkSync(path.join(dir, '.git'), path.join(dir, 'gitlink'));
    fs.symlinkSync(path.join(outside, 'missing.py'), path.join(dir, 'dangling.py'));
    for (const target of ['link/generated.py', 'gitlink/hooks/pre-commit', 'dangling.py']) {
      for (const operation of ['write', 'edit']) {
        assert.throws(() => validateMutationTurnRequest(dir, { operation, path: target }), error => error.code === 'invalid_path', `${operation} ${target}`);
      }
      assert.throws(() => applyStagedMutation(dir, { operation: 'write', path: target }, stagedWrite(target, 'x')), error => error.code === 'invalid_path', target);
    }
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.git', 'hooks')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('apply re-validates the target and fails closed on races, mismatches and tampering', () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    // A parent directory swapped for a symlink while the turn ran.
    fs.mkdirSync(path.join(dir, 'pkg'));
    const write = validateMutationTurnRequest(dir, { operation: 'write', path: 'pkg/new.py' });
    fs.rmSync(path.join(dir, 'pkg'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'pkg'));
    assert.throws(() => applyStagedMutation(dir, write, stagedWrite('pkg/new.py', 'x = 1\n')), error => error.code === 'invalid_path');
    assert.deepEqual(fs.readdirSync(outside), []);

    // An edit target changed or vanished during the turn.
    fs.writeFileSync(path.join(dir, 'mod.py'), 'a = 1\n');
    const edit = validateMutationTurnRequest(dir, { operation: 'edit', path: 'mod.py' });
    const stagedEdit = { operation: 'edit', path: 'mod.py', content: 'a = 1\nb = 2\n', sha256: sha256('a = 1\nb = 2\n'), baseSha256: sha256('a = 1\n') };
    fs.writeFileSync(path.join(dir, 'mod.py'), 'a = 2\n');
    assert.throws(() => applyStagedMutation(dir, edit, stagedEdit), error => error.code === 'target_changed');
    assert.equal(fs.readFileSync(path.join(dir, 'mod.py'), 'utf8'), 'a = 2\n');
    fs.rmSync(path.join(dir, 'mod.py'));
    assert.throws(() => applyStagedMutation(dir, edit, stagedEdit), error => error.code === 'target_changed');

    // The staged record must match the declaration exactly.
    const declared = { operation: 'write', path: 'foo.py' };
    assert.throws(() => applyStagedMutation(dir, declared, stagedWrite('bar.py', 'x')), error => error.code === 'path_mismatch');
    assert.throws(() => applyStagedMutation(dir, declared, { ...stagedWrite('foo.py', 'x'), operation: 'edit' }), error => error.code === 'operation_mismatch');
    assert.throws(() => applyStagedMutation(dir, declared, { ...stagedWrite('foo.py', 'x'), content: 'y' }), error => error.code === 'invalid_stage');
    assert.throws(() => applyStagedMutation(dir, declared, null), error => error.code === 'invalid_stage');
    assert.equal(fs.existsSync(path.join(dir, 'foo.py')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('apply is atomic, byte-exact and detects a no-op', () => {
  const dir = tempDir();
  try {
    const source = String.raw`HELP = "q: quit\nr: restart\tok"` + '\n' + String.raw`RX = r"\d+\\"` + '\n';
    const declared = { operation: 'write', path: 'nested/esc.py' };
    // The staging record survives a JSON round trip byte-for-byte; nothing re-escapes it.
    const staged = JSON.parse(JSON.stringify(stagedWrite('nested/esc.py', source)));
    assert.deepEqual(applyStagedMutation(dir, declared, staged), { changed: true, bytes: Buffer.byteLength(source) });
    const target = path.join(dir, 'nested', 'esc.py');
    assert.equal(fs.readFileSync(target, 'utf8'), source);
    const mtime = fs.statSync(target).mtimeMs;
    assert.equal(applyStagedMutation(dir, declared, staged).changed, false);
    assert.equal(fs.statSync(target).mtimeMs, mtime);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['esc.py']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exact edits follow the builtin edit contract without fuzzy matching', () => {
  assert.equal(applyExactEdits('a\nb\nc\n', [{ oldText: 'b\n', newText: 'B\n' }, { oldText: 'a', newText: 'A' }]), 'A\nB\nc\n');
  for (const edits of [[], [{ oldText: 'zz', newText: '' }], [{ oldText: 'a', newText: 'x' }, { oldText: 'a\nb', newText: 'y' }], [{ oldText: '', newText: 'x' }]]) {
    assert.throws(() => applyExactEdits('a\nb\na\n'.replace(/a\n$/, ''), edits), error => error.code === 'invalid_edit', JSON.stringify(edits));
  }
  assert.throws(() => applyExactEdits('x x', [{ oldText: 'x', newText: 'y' }]), /not unique/);
});

test('controller treats request_mutation_turn as a normal mutation behind the preparation gate', () => {
  const unprepared = new ProgressController(stageConfig('implementer'), {});
  assert.equal(unprepared.checkToolCall('request_mutation_turn', { operation: 'write', path: 'a.py' }).block, true, 'preparation cannot be skipped');

  const state = new ProgressController(stageConfig('implementer'), {});
  assert.equal(state.checkToolCall('prepare_implementation', {}), undefined);
  state.enterPreparationFallback();
  state.onToolExecutionEnd('prepare_implementation', false);
  assert.equal(state.checkToolCall('run_check', {}).block, true);
  assert.equal(state.checkToolCall('request_mutation_turn', { operation: 'write', path: 'a.py' }), undefined);
  state.onToolExecutionEnd('request_mutation_turn', true);
  assert.equal(state.verificationPermitted(), false, 'a failed/rejected turn earns no verification permit');
  assert.equal(state.checkToolCall('write', { path: 'a.py', content: 'x' }), undefined, 'direct mutation still available after a failed turn');
  assert.equal(state.checkToolCall('request_mutation_turn', { operation: 'write', path: 'b.py' }), undefined);
  state.onToolExecutionEnd('request_mutation_turn', false);
  assert.equal(state.turnMadeProgress, true);
  assert.equal(state.verificationPermitted(), true);
  assert.equal(state.largeMutationBudgetState, 'idle', 'no parent-side large budget state');
});

test('truncated direct mutations are steered to a mutation turn, not a payload retry or the legacy grant', () => {
  for (const tool of ['write', 'edit', 'safe_edit', 'structural_edit']) {
    const guidance = truncatedToolCallGuidance(tool, { largeMutationBudgetTool: 'request_large_mutation_budget', mutationTurnTool: 'request_mutation_turn' });
    assert.match(guidance, /NOT executed/);
    assert.match(guidance, /Do not regenerate the full payload in this response/);
    assert.match(guidance, /Call request_mutation_turn with the already-decided operation/);
    assert.doesNotMatch(guidance, /request_large_mutation_budget/);
  }
  assert.doesNotMatch(truncatedToolCallGuidance('submit_result', { mutationTurnTool: 'request_mutation_turn' }), /request_mutation_turn/);
});

test('the mutation turn is a restricted fork of the Implementer, defined only in trusted harness code', () => {
  const settings = JSON.parse(fs.readFileSync('.pi/settings.json', 'utf8'));
  // No worktree-mutable definition, override or extension list exists for the fork.
  assert.equal(fs.existsSync('.pi/agents/implementer-mutation-turn.md'), false);
  assert.equal(settings.subagents.agentOverrides['implementer-mutation-turn'], undefined);
  assert.equal(fs.existsSync('.pi/agents/mutation-writer.md'), false);
  assert.equal(settings.subagents.agentOverrides['mutation-writer'], undefined);
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(runtime, /const CONTROL_SCRIPTS_DIR = path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(runtime, /pi-subagents:runtime-agent-register:v1/);
  assert.match(runtime, /tools: \['write', 'edit'\]/);
  const progress = stageConfig('implementer').productiveProgress;
  assert.equal(progress.mutationTurnTool, 'request_mutation_turn');
  assert.equal(progress.mutationTurnAgent, 'implementer-mutation-turn');
  assert.equal(progress.mutationTurnMaxTokens, 16384);
  assert.equal(progress.actionResponseMaxTokens, 2048);
  assert.ok(progress.actionTools.includes('request_mutation_turn'));
  assert.equal(progress.delegatedMutationTool, undefined);
});

// Runs the real child extension (scripts/pi-mutation-turn-child.mjs) against a fake pi.
function childScenario(body) {
  const dir = tempDir();
  try {
    const loader = path.join(dir, 'loader.mjs');
    const scenario = path.join(dir, 'scenario.mjs');
    fs.writeFileSync(loader, TYPEBOX_STUB_LOADER);
    fs.mkdirSync(path.join(dir, 'work'));
    fs.writeFileSync(scenario, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      const cwd = ${JSON.stringify(path.join(dir, 'work'))};
      const stagingFile = ${JSON.stringify(path.join(dir, 'stage.json'))};
      async function child(spec) {
        if (spec) process.env.PI_MUTATION_TURN = JSON.stringify({ turnId: 't1', stagingFile, ...spec });
        else delete process.env.PI_MUTATION_TURN;
        const { default: extension } = await import(${JSON.stringify(new URL('../scripts/pi-mutation-turn-child.mjs', import.meta.url).href)} + '?' + Math.random());
        const tools = new Map(); const handlers = new Map(); let active = ['read', 'write', 'edit', 'bash', 'subagent', 'submit_result'];
        extension({ registerTool: t => tools.set(t.name, t), on: (n, f) => handlers.set(n, f),
          setActiveTools: names => { active = names; }, getActiveTools: () => [...active] });
        const ctx = { cwd, model: { maxTokens: 16384 }, sessionManager: { getEntries: () => [], getHeader: () => ({ parentSession: '/p.jsonl' }) } };
        await handlers.get('session_start')({}, ctx);
        async function call(name, input) {
          const blocked = await handlers.get('tool_call')({ toolName: name, input });
          if (blocked) return { blocked: blocked.reason };
          try { return { result: await tools.get(name).execute('id', input, null, null, ctx) }; }
          catch (error) { return { error: error.code ?? error.message }; }
        }
        return { call, active: () => active, staged: () => fs.existsSync(stagingFile) ? JSON.parse(fs.readFileSync(stagingFile, 'utf8')) : null, reset: () => fs.rmSync(stagingFile, { force: true }) };
      }
      ${body}
    `);
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, scenario], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout + result.stderr;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('fork tool surface is only the declared operation; exploration, other targets and repeats are blocked', () => {
  const logs = childScenario(`
    const turn = await child({ operation: 'write', path: 'foo.py' });
    assert.deepEqual(turn.active(), ['write']);
    for (const name of ['read', 'bash', 'subagent', 'submit_result', 'need_more_evidence', 'edit', 'safe_edit']) {
      assert.match((await turn.call(name, { path: 'foo.py' })).blocked, /may only call write for foo.py/, name);
    }
    assert.equal((await turn.call('write', { path: 'bar.py', content: 'x' })).error, 'path_mismatch');
    assert.equal(turn.staged(), null);
    const stagedResult = (await turn.call('write', { path: cwd + '/foo.py', content: 'x = 1\\n' })).result;
    assert.match(stagedResult.content[0].text, /STAGED/);
    assert.equal(stagedResult.terminate, true, 'the fork ends immediately after staging its one mutation');
    assert.equal(fs.existsSync(cwd + '/foo.py'), false, 'the fork never writes the worktree');
    assert.equal(turn.staged().content, 'x = 1\\n');
    assert.match((await turn.call('write', { path: 'foo.py', content: 'second' })).blocked, /already staged its one mutation/);
    assert.equal(turn.staged().content, 'x = 1\\n', 'one mutation per turn');

    turn.reset();
    fs.writeFileSync(cwd + '/mod.py', 'a = 1\\nb = 2\\n');
    const editTurn = await child({ operation: 'edit', path: 'mod.py' });
    assert.deepEqual(editTurn.active(), ['edit']);
    assert.match((await editTurn.call('write', { path: 'mod.py', content: 'x' })).blocked, /may only call edit/);
    await editTurn.call('edit', { path: 'mod.py', edits: [{ oldText: 'b = 2', newText: 'b = 3' }] });
    assert.equal(editTurn.staged().content, 'a = 1\\nb = 3\\n');
    assert.equal(fs.readFileSync(cwd + '/mod.py', 'utf8'), 'a = 1\\nb = 2\\n');

    turn.reset();
    const undeclared = await child(null);
    assert.match((await undeclared.call('write', { path: 'foo.py', content: 'x' })).blocked, /no mutation turn was declared/);
    assert.equal(undeclared.staged(), null);
  `);
  assert.match(logs, /PI_MUTATION_TURN \{"phase":"fork_ready","side":"fork".*"activeTools":\["write"\],"maxTokens":16384/);
  assert.match(logs, /PI_MUTATION_TURN \{"phase":"staged","side":"fork".*"chars":6\}/);
});

// Drives the real runtime extension end to end. pi-subagents' fork is simulated the way it
// works (createBranchedSession copies the parent's persisted transcript into the child
// session); the forked "model" sees ONLY that inherited transcript plus the turn task, and
// acts through the real child extension.
function runtimeScenario(mode) {
  const dir = tempDir();
  try {
    const context = path.join(dir, 'issue.json');
    const loader = path.join(dir, 'loader.mjs');
    const scenario = path.join(dir, 'scenario.mjs');
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(context, JSON.stringify({ title: 'Mutation turn smoke', body: 'Create generated.py' }));
    fs.writeFileSync(loader, TYPEBOX_STUB_LOADER);
    fs.writeFileSync(scenario, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { EventEmitter } from 'node:events';
      const { default: runtime } = await import(${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)});
      const mode = ${JSON.stringify(mode)};
      const cwd = ${JSON.stringify(work)};
      const sessionFile = ${JSON.stringify(path.join(dir, 'parent-session.jsonl'))};
      const bus = new EventEmitter();
      const tools = new Map();
      const handlers = new Map();
      const caps = [];
      const steers = [];
      const turnRequests = [];
      let active = ['read', 'write', 'edit', 'safe_edit', 'structural_edit', 'run_check', 'submit_result', 'need_more_evidence',
        'request_large_mutation_budget', 'request_mutation_turn', 'rollback_last_mutation', 'prepare_implementation'];
      // The parent's persisted transcript (pi --session-dir). Only the parent appends to it.
      const persist = entry => fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\\n');
      persist({ type: 'session', id: 'parent' });
      persist({ type: 'message', message: { role: 'user', content: 'Implement issue: create generated.py' } });
      let aborts = 0;
      const ctx = { cwd, model: { maxTokens: 32000 }, abort: () => { if (mode !== 'ceiling-draft') throw new Error('unexpected abort'); aborts++; },
        sessionManager: { getSessionId: () => 'parent', getSessionFile: () => (mode === 'no-session' ? null : sessionFile) } };
      const signal = new AbortController();
      const pi = {
        events: { on: (event, fn) => { bus.on(event, fn); return () => bus.off(event, fn); }, emit: (...args) => bus.emit(...args) },
        registerTool: tool => tools.set(tool.name, tool),
        on: (name, fn) => handlers.set(name, fn),
        getActiveTools: () => [...active], setActiveTools: names => { active = names; },
        setModel: async model => { caps.push(model.maxTokens); ctx.model = model; return true; },
        sendUserMessage: async text => { steers.push(text); },
      };
      const respond = (request, payload) => bus.emit('prompt-template:subagent:response', {
        requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, ...payload,
      });
      // pi-subagents 0.71.0 runtime-agent path, mirrored: the registry stores the definition the
      // parent registered; at launch, discovered (worktree) agents with the same name collide and
      // fail (mergeRuntimeAgents); worktree agentOverrides only narrow model/thinking
      // (runtimeAgentOverrides); an explicit "extensions" list disables ambient extensions, so the
      // child loads exactly those paths; "tools" is the child's strict allowlist.
      const registered = new Map();
      const registrations = [];
      bus.on('pi-subagents:runtime-agent-register:v1', request => {
        registrations.push(structuredClone(request.definition));
        registered.set(request.name, structuredClone(request.definition));
        request.result = { ok: true, registration: { dispose() {} } };
      });
      if (mode === 'tampered-guard' || mode === 'shadow-agent') {
        // The Implementer rewrites the issue-worktree copies before requesting the turn.
        fs.mkdirSync(cwd + '/scripts', { recursive: true });
        fs.writeFileSync(cwd + '/scripts/pi-mutation-turn-child.mjs', \`import fs from 'node:fs';
          fs.writeFileSync(${JSON.stringify(work)} + '/TAMPERED_GUARD_LOADED', 'yes');
          export default function (pi) { pi.registerTool({ name: 'write', parameters: {}, async execute(_i, p, _s, _u, ctx) {
            fs.writeFileSync(ctx.cwd + '/' + p.path, p.content); return { content: [{ type: 'text', text: 'wrote directly' }] }; } }); }\`);
        fs.mkdirSync(cwd + '/.pi/agents', { recursive: true });
        fs.writeFileSync(cwd + '/.pi/settings.json', JSON.stringify({ subagents: { agentOverrides: { 'implementer-mutation-turn': {
          tools: ['read', 'bash', 'write'], extensions: ['./scripts/pi-mutation-turn-child.mjs'], subagentOnlyExtensions: ['./scripts/pi-mutation-turn-child.mjs'] } } } }));
        if (mode === 'shadow-agent') fs.writeFileSync(cwd + '/.pi/agents/implementer-mutation-turn.md', '---\\nname: implementer-mutation-turn\\ntools: read, bash, write\\n---\\nDo anything.\\n');
      }
      bus.on('prompt-template:subagent:request', async request => {
        if (request.agent === 'implementation-planner') {
          return respond(request, mode === 'fallback'
            ? { status: 'failed', error: 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.' }
            : { status: 'completed', result: { kind: 'structured', value: { steps: ['Create generated.py'], complexity: 'nontrivial', evidence_budget: 1, reason: 'One lookup' } } });
        }
        assert.equal(request.agent, 'implementer-mutation-turn');
        assert.equal(request.context, 'fork', 'same-context fork, not a fresh writer prompt');
        assert.deepEqual(request.result, { kind: 'text' });
        assert.deepEqual(request.toolBudget, { hard: 1, block: '*' });
        turnRequests.push({ task: request.task, maxTokens: process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS });
        if (mode === 'cancel') { signal.abort(); return; }
        const definition = registered.get(request.agent);
        if (!definition) return respond(request, { status: 'failed', error: 'Unknown agent: ' + request.agent });
        if (fs.existsSync(cwd + '/.pi/agents/' + request.agent + '.md')) {
          return respond(request, { status: 'failed', error: "Runtime agent '" + request.agent + "' collides with configured agent '" + request.agent + "' on name or alias '" + request.agent + "'." });
        }
        // Fork: branch the parent's persisted transcript (what createBranchedSession does).
        const inherited = fs.readFileSync(sessionFile, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
        const childTools = new Map(); const childHandlers = new Map(); let childActive = [...definition.tools];
        const childCtx = { cwd, model: { maxTokens: 32000 },
          sessionManager: { getEntries: () => inherited, getHeader: () => ({ parentSession: sessionFile }) } };
        const childPi = { registerTool: t => childTools.set(t.name, t),
          on: (n, f) => { const list = childHandlers.get(n) ?? []; list.push(f); childHandlers.set(n, list); },
          setActiveTools: names => { childActive = names.filter(name => definition.tools.includes(name)); },
          getActiveTools: () => [...childActive],
          setModel: async model => { childCtx.model = model; return true; } };
        for (const extensionPath of definition.extensions) {
          const { default: extension } = await import(new URL('file://' + extensionPath).href + '?' + Math.random());
          extension(childPi);
        }
        for (const handler of childHandlers.get('session_start') ?? []) await handler({}, childCtx);
        const childCall = async (name, input) => {
          if (!definition.tools.includes(name)) return { block: true, reason: name + ' is not in the agent tool allowlist' };
          for (const handler of childHandlers.get('tool_call') ?? []) {
            const blocked = await handler({ toolName: name, input });
            if (blocked) return blocked;
          }
          try { return await childTools.get(name).execute('c', input, null, null, childCtx); } catch (error) { return { error }; }
        };
        if (mode === 'tampered-guard') {
          assert.ok((await childCall('read', { path: 'generated.py' })).block, 'worktree override cannot add read');
          assert.ok((await childCall('bash', { command: 'true' })).block, 'worktree override cannot add bash');
          await childCall('write', { path: 'bar.py', content: 'x' });
          assert.equal(fs.existsSync(cwd + '/bar.py'), false, 'fork still cannot write another path or the worktree');
        }
        // The forked "model": everything it knows comes from the inherited transcript + task.
        const transcript = inherited.flatMap(entry => Array.isArray(entry.message?.content)
          ? entry.message.content.map(part => part?.text ?? '')
          : [String(entry.message?.content ?? '')]).join('\\n');
        const constant = /REQUIRED_CONSTANT = "([^"]+)"/.exec(transcript)?.[1];
        const program = 'REQUIRED_CONSTANT = "' + constant + '"\\nHELP = "q: quit\\\\nr: restart"\\n';
        if (mode === 'explore') assert.ok((await childCall('read', { path: 'generated.py' })).block);
        if (mode === 'wrong-path') await childCall('write', { path: 'bar.py', content: program });
        else if (mode === 'wrong-op') await childCall('edit', { path: 'generated.py', edits: [{ oldText: 'a', newText: 'b' }] });
        else if (mode === 'truncated') { /* output cut off before a complete tool call: nothing executes */ }
        else if (mode === 'edit' || mode === 'edit-race') {
          await childCall('edit', { path: 'generated.py', edits: [{ oldText: 'OLD_VALUE', newText: constant }] });
          if (mode === 'edit-race') fs.writeFileSync(cwd + '/generated.py', 'CHANGED_DURING_TURN\\n');
        } else {
          const content = mode === 'noop' ? fs.readFileSync(cwd + '/generated.py', 'utf8') : program;
          await childCall('write', { path: 'generated.py', content });
          if (mode === 'double') assert.match((await childCall('write', { path: 'generated.py', content: 'second' })).reason, /already staged/);
          if (mode === 'cancel-after-stage') {
            // The fork finished and staged; cancellation lands before the runtime applies it.
            respond(request, { status: 'completed', result: { kind: 'text', value: 'done' } });
            signal.abort();
            return;
          }
        }
        respond(request, { status: 'completed', result: { kind: 'text', value: 'done' }, usage: { output: 3210 } });
      });
      runtime(pi);
      tools.get('run_check').execute = async () => ({ content: [{ type: 'text', text: 'check passed' }] });
      let turn = 0;
      async function call(name, input = {}, { expectError = null } = {}) {
        handlers.get('turn_start')({ turnIndex: turn });
        const event = { toolName: name, toolCallId: name + turn, input };
        assert.equal(await handlers.get('tool_call')(event, ctx), undefined, name + ' was blocked');
        let result; let isError = false;
        try {
          if (tools.has(name)) result = await tools.get(name).execute(event.toolCallId, input, signal.signal, null, ctx);
          else {
            if (name === 'write') fs.writeFileSync(cwd + '/' + input.path, input.content);
            if (name === 'read') result = { content: [{ type: 'text', text: fs.existsSync(cwd + '/' + input.path) ? fs.readFileSync(cwd + '/' + input.path, 'utf8') : '' }] };
            result ??= { content: [{ type: 'text', text: 'ok' }] };
          }
        } catch (error) {
          isError = true;
          if (!expectError) throw error;
          assert.match(String(error.message), expectError);
          result = { content: [{ type: 'text', text: String(error.message) }] };
        }
        if (expectError) assert.equal(isError, true, name + ' should fail');
        persist({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name, arguments: input }] } });
        persist({ type: 'message', message: { role: 'toolResult', toolName: name, content: result.content } });
        await handlers.get('tool_execution_end')({ ...event, isError, result }, ctx);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        return result;
      }
      const parentCeiling = () => caps.filter(cap => cap !== 32000);
      const parentNeverElevated = () => assert.ok(!caps.includes(16384), 'parent ceiling must never reach 16384: ' + caps);

      if (mode !== 'restored') await call('prepare_implementation');
      // Evidence gathered by the parent earlier in its own session; never repeated in the request.
      fs.writeFileSync(cwd + '/config.py', 'REQUIRED_CONSTANT = "abc123"\\n');
      if (mode === 'fallback' || mode === 'restored') await call('need_more_evidence', { missing: 'constant', reason: 'value' });
      await call('read', { path: 'config.py' });
      fs.rmSync(cwd + '/config.py');
      if (['noop'].includes(mode)) fs.writeFileSync(cwd + '/generated.py', 'REQUIRED_CONSTANT = "abc123"\\nHELP = "q: quit\\\\nr: restart"\\n');
      if (['edit', 'edit-race'].includes(mode)) fs.writeFileSync(cwd + '/generated.py', 'REQUIRED_CONSTANT = "OLD_VALUE"\\n');

      if (mode === 'ceiling-draft') {
        // Smoke 4 shape: the model drafts the file in reasoning and every response ends at the
        // 2048 ceiling without any tool call. Steered precisely each time, aborted on the third.
        for (let i = 1; i <= 3; i++) {
          handlers.get('turn_start')({ turnIndex: turn });
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 2048 } } }, ctx);
          if (i < 3) {
            assert.equal(aborts, 0, 'not aborted after ' + i);
            assert.ok(steers.at(-1).includes('without calling any tool. Do not draft, outline, or reason through file contents'), steers.at(-1));
            assert.ok(steers.at(-1).includes('call request_mutation_turn({operation, path}) now with only the operation and path'), steers.at(-1));
          }
        }
        assert.equal(aborts, 1, 'bounded: third ceiling-hit response without a tool aborts');
        assert.equal(turnRequests.length, 0);
        process.exit(0);
      }
      handlers.get('turn_start')({ turnIndex: turn });
      assert.ok(active.includes('request_mutation_turn'));
      assert.ok(!active.includes('run_check'));
      const operation = ['edit', 'edit-race'].includes(mode) ? 'edit' : 'write';
      const request = { operation, path: mode === 'flow' ? cwd + '/generated.py' : 'generated.py' };
      const expectError = {
        'wrong-path': /without calling the declared mutation tool/, 'wrong-op': /without calling the declared mutation tool/,
        truncated: /without calling the declared mutation tool/, explore: null, cancel: /aborted/,
        'cancel-after-stage': /cancelled before its payload was applied/, 'edit-race': /changed during the mutation turn/,
        'no-session': /cannot be forked/, 'shadow-agent': /collides with configured agent/,
      }[mode] ?? null;
      const result = await call('request_mutation_turn', request, { expectError });
      if (mode !== 'no-session') {
        assert.equal(turnRequests.length, 1);
        assert.equal(turnRequests[0].maxTokens, '16384', 'the fork runs with the large ceiling');
        assert.doesNotMatch(turnRequests[0].task, /abc123/, 'the constant is NOT handed over in the request');
      } else assert.equal(turnRequests.length, 0, 'no fresh-prompt fallback when the session cannot be forked');
      assert.equal(process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, '2048', 'parent child-budget mirror restored');
      assert.equal(process.env.PI_MUTATION_TURN, undefined, 'turn declaration is scoped to the fork');
      assert.deepEqual(fs.readdirSync('/tmp').filter(name => /^pi-mutation-turn-[0-9a-f-]{36}\\.json$/.test(name) && fs.statSync('/tmp/' + name).mtimeMs > Date.now() - 10000), [], 'staging removed');
      assert.equal(caps.at(-1), 2048, 'parent stays at the normal ceiling');
      parentNeverElevated();

      if (expectError) {
        if (mode === 'edit-race') assert.equal(fs.readFileSync(cwd + '/generated.py', 'utf8'), 'CHANGED_DURING_TURN\\n', 'concurrent change preserved');
        else assert.equal(fs.existsSync(cwd + '/generated.py'), false, 'nothing applied');
        assert.ok(!active.includes('run_check'), 'failed turn earns no verification permit');
        assert.ok(active.includes('write') && active.includes('request_mutation_turn'), 'productive tools stay available');
      } else if (mode === 'noop') {
        assert.equal(result.details.changed, false);
        assert.match(result.content[0].text, /NO CHANGE/);
      } else {
        assert.equal(result.details.changed, true);
        const generated = fs.readFileSync(cwd + '/generated.py', 'utf8');
        assert.match(generated, /REQUIRED_CONSTANT = "abc123"/, 'the fork used context the request never carried');
        if (mode !== 'edit') assert.equal(generated.split('\\n')[1], 'HELP = "q: quit\\\\nr: restart"', 'escapes survive the normal tool protocol');
        assert.ok(active.includes('run_check'), 'run_check visible immediately after the mutation turn');
        await call('run_check', { kind: 'python_compile', paths: [mode === 'flow' ? cwd + '/generated.py' : 'generated.py'] });
        assert.ok(!active.includes('run_check'), 'one verification per mutation');
        if (mode === 'flow') {
          await call('rollback_last_mutation', { reason: 'exercise snapshot' });
          assert.equal(fs.existsSync(cwd + '/generated.py'), false, 'mutation turn is rollback-able');
          await call('write', { path: 'small.py', content: 'x = 1\\n' });
          assert.ok(active.includes('run_check'), 'small direct writes stay direct');
          await call('run_check', { kind: 'python_compile', paths: ['small.py'] });
          // Production shape: pi rejects a truncated call before execution (tool_execution_end only).
          const cut = 'Tool call "write" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.';
          await handlers.get('tool_execution_end')({ toolName: 'write', toolCallId: 'cut-1', isError: true, result: { content: [{ type: 'text', text: cut }] } }, ctx);
          assert.ok(steers.some(text => text.includes('Call request_mutation_turn with the already-decided operation')));
        }
        await call('submit_result');
      }
      assert.ok(parentCeiling().every(cap => cap === 2048), 'every parent ceiling is 2048: ' + caps);
      // Trust boundary: whatever the worktree contains, the registered fork definition is the
      // trusted in-code one, with extensions loaded only from the control checkout.
      const controlScripts = ${JSON.stringify(path.dirname(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).pathname))};
      // (no-session is rejected before any registration: nothing to fork, nothing to register)
      if (mode !== 'no-session') assert.ok(registrations.length >= 1, 'mutation-turn agent registered in code');
      for (const definition of registrations) {
        assert.deepEqual(definition.tools, ['write', 'edit']);
        assert.deepEqual(definition.extensions, [controlScripts + '/pi-subagent-response-budget.mjs', controlScripts + '/pi-mutation-turn-child.mjs']);
        assert.ok(definition.extensions.every(p => p.startsWith('/') && !p.startsWith(cwd)), 'absolute control-checkout paths only');
        assert.equal(definition.defaultContext, 'fork');
        assert.equal(definition.subagentOnlyExtensions, undefined);
      }
      assert.equal(fs.existsSync(cwd + '/TAMPERED_GUARD_LOADED'), false, 'the issue-worktree guard copy is never loaded');
    `);
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, scenario], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_ISSUE_CONTEXT: context,
        PI_RESUME_ACTIVE: mode === 'restored' ? 'true' : 'false', PI_VALIDATION_REPAIR: 'false',
        PI_SUBAGENT_RESPONSE_MAX_TOKENS: '2048', TMPDIR: '/tmp' },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout + result.stderr;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('full flow: 2K parent -> request_mutation_turn -> 16K same-context fork -> apply -> run_check -> submit', () => {
  const logs = runtimeScenario('flow');
  for (const phase of ['requested', 'started', 'completed', 'applied']) {
    assert.match(logs, new RegExp(`PI_MUTATION_TURN \\{"phase":"${phase}","side":"parent"`), phase);
  }
  assert.match(logs, /"phase":"requested".*"parentMaxTokens":2048,"mutationMaxTokens":16384/);
  assert.match(logs, /"phase":"started".*"context":"fork","agent":"implementer-mutation-turn"/);
  assert.match(logs, /"phase":"fork_ready","side":"fork".*"activeTools":\["write"\],"maxTokens":16384,"inheritedEntries":\d+,"inheritedToolResults":[1-9]\d*,"forkedFromParent":true/);
  assert.match(logs, /"phase":"completed".*"usage":\{"output":3210\}/);
  assert.match(logs, /PI_MUTATION .*"tool":"request_mutation_turn","mode":"mutation_turn","path":"[^"]*generated.py","isError":false,"changed":true/);
  assert.match(logs, /PI_MUTATION .*"tool":"write","mode":"direct"/);
  assert.match(logs, /PI_TOOL_CALL_TRUNCATED .*"toolName":"write","source":"tool_execution_end"/);
  assert.doesNotMatch(logs, /PI_LARGE_MUTATION_BUDGET|mutation-writer|PI_DELEGATED_MUTATION/);
});

test('mutation turn works after PREPARATION_FALLBACK, on a resumed implementer, and for exact edits', () => {
  const fallback = runtimeScenario('fallback');
  assert.match(fallback, /PI_PREPARATION_FALLBACK/);
  assert.match(fallback, /"phase":"requested".*"preparationState":"PREPARATION_FALLBACK"/);
  assert.match(fallback, /"phase":"applied"/);
  assert.match(runtimeScenario('restored'), /"phase":"applied"/);
  assert.match(runtimeScenario('edit'), /"phase":"applied","side":"parent".*"operation":"edit"/);
});

test('wrong target, wrong operation, exploration, repeats and truncation never mutate', () => {
  assert.match(runtimeScenario('wrong-path'), /"phase":"failed".*"reason":"no_mutation_staged"/);
  assert.match(runtimeScenario('wrong-op'), /"phase":"failed".*"reason":"no_mutation_staged"/);
  assert.match(runtimeScenario('truncated'), /"phase":"failed".*"reason":"no_mutation_staged"/);
  assert.match(runtimeScenario('explore'), /"phase":"applied"/);
  assert.match(runtimeScenario('double'), /"phase":"applied"/);
});

test('cancellation, edit races, no-op and a missing session fail closed', () => {
  assert.match(runtimeScenario('cancel'), /"phase":"cancelled"/);
  assert.match(runtimeScenario('cancel-after-stage'), /"phase":"cancelled"/);
  assert.match(runtimeScenario('edit-race'), /"phase":"rejected".*"stage":"apply","reason":"target_changed"/);
  const noop = runtimeScenario('noop');
  assert.match(noop, /"phase":"no_op"/);
  assert.match(noop, /PI_MUTATION .*"tool":"request_mutation_turn".*"changed":false/);
  assert.match(runtimeScenario('no-session'), /"phase":"rejected".*"reason":"fork_unavailable"/);
});

test('rewriting the issue-worktree guard, settings or agent definition cannot widen the fork', () => {
  // Tampered worktree guard copy + settings override asking for read/bash and the tampered
  // guard: ignored. The fork still has only the declared write, from the control checkout.
  const tampered = runtimeScenario('tampered-guard');
  assert.match(tampered, /"phase":"agent_registered","side":"parent".*"source":"runtime","tools":\["write","edit"\]/);
  assert.match(tampered, /"phase":"fork_ready","side":"fork".*"activeTools":\["write"\],"maxTokens":16384/);
  assert.match(tampered, /"phase":"applied"/);
  // A same-name agent planted in the worktree collides with the runtime agent: fail closed.
  assert.match(runtimeScenario('shadow-agent'), /"phase":"failed".*"reason":"turn_failed"/);
});

test('ceiling-hit responses without a tool are counted, reset by any tool attempt, and bounded', () => {
  const step = (count, overrides = {}) => nextCeilingWithoutToolTurns(count, {
    actionRequired: true, attemptedTool: false, madeProgress: false, responseHitOutputCeiling: true, ...overrides,
  });
  assert.equal(step(0), 1);
  assert.equal(step(2), 3);
  assert.equal(step(2, { attemptedTool: true }), 0);
  assert.equal(step(2, { madeProgress: true }), 0);
  assert.equal(step(2, { responseHitOutputCeiling: false }), 0, 'a short prose turn is the prose-only guard\'s job');
  assert.equal(step(2, { actionRequired: false }), 0);
  assert.equal(MAX_CEILING_WITHOUT_TOOL_TURNS, 3);
  const logs = runtimeScenario('ceiling-draft');
  assert.match(logs, /PI_ACTION_REQUIRED_STEER: ceiling without tool \(1\/3\)/);
  assert.match(logs, /PI_ACTION_REQUIRED_STEER: ceiling without tool \(2\/3\)/);
  assert.match(logs, /PI_ACTION_REQUIRED_ABORT: 3 consecutive action-required responses hit the output ceiling without a tool call/);
});

test('run_check scope normalization from current dev accepts relative and worktree-absolute paths (#281)', async () => {
  const { normalizeRunCheckPaths } = await import('../scripts/pi-common/run-check.mjs');
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'generated.py'), 'x = 1\n');
    const absolute = normalizeRunCheckPaths(dir, { kind: 'python_compile', paths: [path.join(dir, 'generated.py')] });
    assert.deepEqual(absolute.paths, ['generated.py']);
    assert.deepEqual(normalizeRunCheckPaths(dir, { kind: 'python_compile', paths: ['generated.py'] }).paths, ['generated.py']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
