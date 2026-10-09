import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveMutationTarget } from '../scripts/pi-common/mutation-target.mjs';
import {
  MAX_CEILING_WITHOUT_TOOL_TURNS,
  PREPARATION_FALLBACK_EVIDENCE_BUDGET,
  ProgressController,
  nextCeilingWithoutToolTurns,
  truncatedToolCallGuidance,
} from '../scripts/pi-common/progress-controller.mjs';
import { agentContractPrompt, implementerCodingContractPrompt, stageConfig } from '../scripts/pi-common/stage-config.mjs';
import { summarizeUsage } from '../scripts/pi-common/usage-ledger.mjs';
import { classifyRuntimeFailureRecord } from '../scripts/pi-common/runtime-failure.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-coding-session-'));
}

const TYPEBOX_STUB_LOADER = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox') return {
    url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
    shortCircuit: true,
  };
  return nextResolve(specifier, context);
}`;

test('coding-session prompt is a compact canonical subset, not the startup Implementer overlay', () => {
  const env = { ...process.env, GITHUB_WORKSPACE: process.cwd() };
  const main = agentContractPrompt('implementer', env);
  const coding = implementerCodingContractPrompt(env);
  const count = (text, needle) => text.split(needle).length - 1;

  assert.equal(count(main, '<shared_agent_contract '), 1);
  assert.equal(count(main, '<role_contract '), 1);
  assert.match(main, /## Startup/);
  assert.match(main, /## Repository access routing/);
  assert.doesNotMatch(main, /## Coding-session contract/);

  assert.equal(count(coding, '<shared_agent_contract '), 1);
  assert.equal(count(coding, '<coding_role_contract '), 1);
  assert.match(coding, /## Hard boundaries/);
  assert.match(coding, /## Coding-session contract/);
  assert.match(coding, /## Engineering constraints/);
  assert.doesNotMatch(coding, /## Startup|### Available delegated agents|## Repository access routing|implementation-planner|begin_coding_session|request_large_mutation_budget|lsp_|Orbit/);
  assert.match(coding, /does \*\*not\*\* inherit the parent transcript/);
  assert.match(coding, /No generic or startup navigation policy is inherited into this phase/);
  assert.match(coding, /If one concrete fact blocks the next safe action/);
  assert.match(coding, /Tests should exercise public behavior and public APIs/);
});

test('coding-session prompt section extraction matches only level-2 headings at the start of a line', () => {
  const workspace = tempDir();
  try {
    fs.mkdirSync(path.join(workspace, 'agents', 'implementer'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'agents', 'AGENTS.md'), 'Shared contract.\n');
    fs.writeFileSync(path.join(workspace, 'agents', 'implementer', 'AGENTS.md'), `### Hard boundaries
FALSE_PREFIX_BOUNDARY
Inline mention: ## Coding-session contract
## Hard boundaries
REAL_BOUNDARY
## Coding-session contract
REAL_CODING_CONTRACT
## Engineering constraints
REAL_ENGINEERING_CONSTRAINTS
`);
    const coding = implementerCodingContractPrompt({ ...process.env, GITHUB_WORKSPACE: workspace });
    assert.match(coding, /REAL_BOUNDARY/);
    assert.match(coding, /REAL_CODING_CONTRACT/);
    assert.match(coding, /REAL_ENGINEERING_CONSTRAINTS/);
    assert.doesNotMatch(coding, /FALSE_PREFIX_BOUNDARY|Inline mention/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('coding-session runtime keeps repair forcing and bounded evidence semantics', () => {
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(runtime, /action-required: read is not exposed now/);
  assert.match(runtime, /request the one missing fact through \$\{blockerTool\}/);
  assert.match(runtime, /CODING_REPAIR_REASONING_MAX_TOKENS = 4096/);
});

test('#470 evidence-consumed notices are correlated to the exact tool call', () => {
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(runtime, /pendingEvidenceConsumptionNotices\.set\(event\.toolCallId, evidenceConsumptionNotice\)/);
  assert.match(runtime, /pendingEvidenceConsumptionNotices\.get\(event\.toolCallId\)/);
  assert.match(runtime, /pendingEvidenceConsumptionNotices\.delete\(event\.toolCallId\)/);
  assert.doesNotMatch(runtime, /const consumedEvidence = controller\.consumeEvidenceActionNotice\(\);/);
});


test('every file mutation target must be physically inside the worktree', () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'pkg'));
    fs.writeFileSync(path.join(dir, 'pkg', 'mod.py'), 'x = 1\n');
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'link'));
    fs.symlinkSync(path.join(dir, '.git'), path.join(dir, 'gitlink'));
    fs.symlinkSync(path.join(outside, 'missing.py'), path.join(dir, 'dangling.py'));
    assert.equal(resolveMutationTarget(dir, 'game.py').exists, false);
    assert.equal(resolveMutationTarget(dir, path.join(dir, 'pkg', 'mod.py')).relative, path.join('pkg', 'mod.py'));
    const rejected = [
      ['', 'missing_path'], [undefined, 'missing_path'], ['../outside.py', 'invalid_path'], ['/etc/passwd', 'invalid_path'],
      ['.git/config', 'invalid_path'], ['pkg', 'invalid_path'], ['link/generated.py', 'invalid_path'],
      ['gitlink/hooks/pre-commit', 'invalid_path'], ['dangling.py', 'invalid_path'],
    ];
    for (const [target, code] of rejected) {
      assert.throws(() => resolveMutationTarget(dir, target), error => error.code === code, String(target));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the coding session starts only once evidence is complete, never from an unprepared controller', () => {
  const unprepared = new ProgressController(stageConfig('implementer'), {});
  assert.equal(unprepared.checkToolCall('begin_coding_session', {}).block, true, 'preparation cannot be skipped');

  const exploring = new ProgressController(stageConfig('implementer'), {});
  exploring.applyPreparedImplementation({ status: 'prepared', plan: ['plan'], complexity: 'nontrivial', evidenceBudget: 2, largeMutation: false, reason: 'test' });
  assert.equal(exploring.productiveProgressState(), 'evidence_allowed');
  assert.match(exploring.checkToolCall('begin_coding_session', {}).reason, /only once evidence is complete/, 'no 16K during exploration');

  const ready = new ProgressController(stageConfig('implementer'), {});
  ready.applyPreparedImplementation({ status: 'fallback', failureClass: 'preparation_infrastructure_failure', reason: 'planner down' });
  assert.match(ready.checkToolCall('begin_coding_session', {}).reason, /only once evidence is complete/);
  for (let i = 0; i < PREPARATION_FALLBACK_EVIDENCE_BUDGET; i++) {
    assert.equal(ready.checkToolCall('read', { path: 'fallback-evidence-' + i }), undefined);
  }
  assert.equal(ready.checkToolCall('begin_coding_session', {}), undefined, 'available after fallback evidence is complete');
  ready.onToolExecutionEnd('begin_coding_session', true);
  assert.equal(ready.verificationPermitted(), false, 'a failed session earns no verification permit');
  assert.equal(ready.checkToolCall('begin_coding_session', {}), undefined);
  ready.onToolExecutionEnd('begin_coding_session', false);
  assert.equal(ready.turnMadeProgress, true);
  assert.equal(ready.verificationPermitted(), true);
  assert.equal(ready.largeMutationBudgetState, 'idle', 'no parent-side large budget state');
});

test('truncated direct mutations are steered into the coding session, not a payload retry or the legacy grant', () => {
  for (const tool of ['write', 'edit', 'safe_edit', 'structural_edit']) {
    const guidance = truncatedToolCallGuidance(tool, { largeMutationBudgetTool: 'request_large_mutation_budget', codingSessionTool: 'begin_coding_session' });
    assert.match(guidance, /NOT executed/);
    assert.match(guidance, /Do not regenerate the payload in this response/);
    assert.match(guidance, /Call begin_coding_session now/);
    assert.doesNotMatch(guidance, /request_large_mutation_budget/);
  }
});

test('ceiling-hit responses without a tool are counted, reset by any tool attempt, and bounded', () => {
  const step = (count, overrides = {}) => nextCeilingWithoutToolTurns(count, {
    actionRequired: true, attemptedTool: false, madeProgress: false, responseHitOutputCeiling: true, ...overrides,
  });
  assert.equal(step(0), 1);
  assert.equal(step(2), 3);
  assert.equal(step(2, { attemptedTool: true }), 0);
  assert.equal(step(2, { madeProgress: true }), 0);
  assert.equal(step(2, { responseHitOutputCeiling: false }), 0);
  assert.equal(step(2, { actionRequired: false }), 0);
  assert.equal(MAX_CEILING_WITHOUT_TOOL_TURNS, 3);
});

test('the coding session is the same Implementer runtime, defined only in trusted harness code', () => {
  const settings = JSON.parse(fs.readFileSync('.pi/settings.json', 'utf8'));
  for (const name of ['implementer-coding-session', 'implementer-mutation-turn', 'mutation-writer']) {
    assert.equal(fs.existsSync(`.pi/agents/${name}.md`), false, name);
    assert.equal(settings.subagents.agentOverrides[name], undefined, name);
  }
  assert.equal(fs.existsSync('scripts/pi-mutation-turn-child.mjs'), false);
  const progress = stageConfig('implementer').productiveProgress;
  assert.equal(progress.codingSessionTool, 'begin_coding_session');
  assert.equal(progress.codingSessionAgent, 'implementer-coding-session');
  assert.equal(progress.codingSessionMaxTokens, 16384);
  assert.equal(progress.actionResponseMaxTokens, 2048);
  assert.ok(progress.actionTools.includes('begin_coding_session'));
  for (const tool of ['write', 'edit', 'safe_edit', 'structural_edit', 'accept_mutation_scope', 'run_check', 'rollback_last_mutation', 'need_more_evidence', 'submit_result', 'read']) {
    assert.ok(progress.codingSessionTools.includes(tool), tool);
  }
  assert.ok(!progress.codingSessionTools.includes('bash'), 'raw shell is not a coding-session cleanup capability');
  for (const tool of ['begin_coding_session', 'request_large_mutation_budget', 'subagent', 'subagents_enable', 'grep', 'find', 'ls']) {
    assert.ok(!progress.codingSessionTools.includes(tool), tool);
  }
});

// Drives the real runtime end to end, in BOTH roles: the 2K parent, and (through the simulated
// pi-subagents host below) the isolated 16K coding session, which loads the registered extension
// paths and runs this same runtime in coding-session mode. pi-subagents 0.71.0 behavior is
// mirrored: runtime-agent registry; same-name configured (worktree) agents collide at launch;
// worktree agentOverrides only narrow model/thinking; an explicit "extensions" list disables
// ambient extensions; "tools" is the strict allowlist; context "fresh" excludes the parent's
// persisted transcript. pi-bash-timeout.mjs needs the pi package, so the host asserts its path
// but does not import it; run_check / submit_result executors are stubbed (their gates are real).
let lastMetrics = [];
// Pi invokes every extension hook in registration order. The scenario host used to
// replace the runtime hook when result-tool registered its own phase hooks.
function registerScenarioHook(map, name, fn) {
  const prior = map.get(name);
  if (!prior) { map.set(name, fn); return; }
  // Keep synchronous provider-request hooks synchronous; only tool calls and
  // terminal hooks that genuinely await a Promise should return a Promise.
  map.set(name, (event, ctx) => {
    const afterFirst = first => {
      if (name === 'tool_call' && first?.block) return first;
      // The next extension receives the payload transformed by the first.
      const nextEvent = name === 'before_provider_request' && first !== undefined
        ? { ...event, payload: first } : event;
      const second = fn(nextEvent, ctx);
      return second?.then
        ? second.then(value => value === undefined ? first : value)
        : second === undefined ? first : second;
    };
    const first = prior(event, ctx);
    return first?.then ? first.then(afterFirst) : afterFirst(first);
  });
}
function runtimeScenario(mode) {
  const dir = tempDir();
  try {
    const context = path.join(dir, 'issue.json');
    const loader = path.join(dir, 'loader.mjs');
    const scenario = path.join(dir, 'scenario.mjs');
    const work = path.join(dir, 'work');
    const terminal = path.join(dir, 'terminal.json');
    const preparedFile = path.join(dir, 'prepared-implementation.json');
    const preparedBase = {
      version: 1,
      workspaceRoot: dir,
      freshBaseCommit: '',
      baseRef: 'origin/dev',
      layoutHint: ['no-submit-recovery', 'no-submit-recovery-dead-end', 'no-submit-recovery-partial'].includes(mode)
        ? {
            sourceRoot: '.',
            sourceDirectory: '.',
            sourceTarget: mode === 'no-submit-recovery-partial' ? 'expected_generated.py' : 'generated.py',
            sourceConvention: null,
            testDirectory: '.',
            testTarget: mode === 'no-submit-recovery-partial' ? 'test_expected_generated.py' : 'test_generated.py',
            testTargetRequired: true,
            testConvention: null,
          }
        : null,
      plannerUsage: null,
      plannerDurationMs: 1,
    };
    fs.writeFileSync(preparedFile, JSON.stringify(mode === 'fallback'
      ? { ...preparedBase, status: 'fallback', failureClass: 'preparation_infrastructure_failure', reason: 'planner down' }
      : { ...preparedBase, status: 'prepared', plan: ['Create generated.py'], repositoryFacts: ['Planner fact marker'], complexity: 'nontrivial', evidenceBudget: mode === 'action-required-serial' ? 0 : 1, largeMutation: ['large-mutation-auto-force', 'large-mutation-prose-abort', 'large-mutation-length-retry-abort', 'large-mutation-provider-retry-abort', 'large-mutation-action-retry-abort', 'large-mutation-coding-argument-recovery', 'large-mutation-coding-argument-retry-abort'].includes(mode), reason: 'One lookup' }));
    const resultFile = path.join(dir, 'implementer-result.json');
    const scopeFile = path.join(dir, 'accepted-scope.json');
    const runtimeFailure = path.join(dir, 'runtime-failure.json');
    const validationLedger = path.join(dir, 'validation.jsonl');
    const remote = path.join(dir, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    fs.mkdirSync(work);
    execFileSync('git', ['init', '-q', work]);
    execFileSync('git', ['-C', work, 'config', 'user.name', 'Coding Session Test']);
    execFileSync('git', ['-C', work, 'config', 'user.email', 'coding@example.invalid']);
    fs.writeFileSync(path.join(work, 'unchanged_helper.py'), 'HELPER = 1\n');
    execFileSync('git', ['-C', work, 'add', 'unchanged_helper.py']);
    execFileSync('git', ['-C', work, 'commit', '--allow-empty', '-qm', 'base']);
    execFileSync('git', ['-C', work, 'remote', 'add', 'origin', remote]);
    execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:refs/heads/dev']);
    execFileSync('git', ['-C', work, 'update-ref', 'refs/remotes/origin/dev', 'HEAD']);
    fs.writeFileSync(context, JSON.stringify({ title: 'Coding session smoke', body: 'Create generated.py and its test' }));
    fs.writeFileSync(loader, TYPEBOX_STUB_LOADER);
    fs.writeFileSync(scenario, `
      ${registerScenarioHook.toString()}
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { EventEmitter } from 'node:events';
      const runtimeUrl = ${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)};
      const terminalReceiptUrl = ${JSON.stringify(new URL('../scripts/pi-common/terminal-receipt.mjs', import.meta.url).href)};
      const implementerResultUrl = ${JSON.stringify(new URL('../scripts/pi-common/implementer-result.mjs', import.meta.url).href)};
      const codingValidationUrl = ${JSON.stringify(new URL('../scripts/pi-common/coding-session-validation.mjs', import.meta.url).href)};
      const { default: runtime, providerErrorStatus, codingSessionArgumentValidation, implementerToolChoiceDecision } = await import(runtimeUrl);
      const { createSuccessfulTerminalReceipt, writeTerminalReceiptFile, assertSuccessfulTerminalReceipt } = await import(terminalReceiptUrl);
      const { writeImplementerResult } = await import(implementerResultUrl);
      const { assertCodingBehavioralValidation, recordCodingBehavioralValidation } = await import(codingValidationUrl);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: '400: {"message":"validation error","type":"Bad Request","code":400}' }), 400);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: '400 {"error":"bad request"}' }), 400);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: '400 status code (no body)' }), 400);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: 'BadRequestError: 422 tool_choice unsupported' }), 422);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: 'InternalServerError: 500 upstream failure' }), 500);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: 'hp-laguna API error (422): unsupported' }), 422);
      assert.equal(providerErrorStatus({ stopReason: 'error', status: 429, errorMessage: 'ignored' }), 429);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: 'Maximum context: 400 tokens' }), null);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: 'fetch failed: 422 something' }), null);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: '500 tokens exceeded' }), null);
      assert.equal(providerErrorStatus({ stopReason: 'error', errorMessage: '400abc' }), null);
      assert.equal(providerErrorStatus({ stopReason: 'stop', errorMessage: '400 nope' }), null);
      const mode = ${JSON.stringify(mode)};
      const fallbackEvidenceBudget = ${PREPARATION_FALLBACK_EVIDENCE_BUDGET};
      const cwd = ${JSON.stringify(work)};
      const terminal = ${JSON.stringify(terminal)};
      const resultFile = ${JSON.stringify(resultFile)};
      const scopeFile = ${JSON.stringify(scopeFile)};
      const runtimeFailure = ${JSON.stringify(runtimeFailure)};
      const controlScripts = ${JSON.stringify(path.dirname(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).pathname))};
      const sessionFile = ${JSON.stringify(path.join(dir, 'parent-session.jsonl'))};
      const bus = new EventEmitter();
      const tools = new Map();
      const handlers = new Map();
      const caps = [];
      const childCaps = [];
      const steers = [];
      const sessionRequests = [];
      const heldTerminalRequests = [];
      // Resolved from the actual delegation request event, not execute() timing.
      const terminalRequestBarriers = [0, 1].map(() => {
        let release;
        const promise = new Promise(resolve => { release = resolve; });
        return { promise, release };
      });
      const registrations = [];
      const registered = new Map();
      let aborts = 0;
      let active = ['read', 'write', 'edit', 'bash', 'safe_edit', 'structural_edit', 'accept_mutation_scope', 'run_check', 'begin_result_submission', 'submit_result', 'need_more_evidence',
        'request_large_mutation_budget', 'begin_coding_session', 'rollback_last_mutation', 'repo_search', 'indexed_repo_search', 'subagents_enable'];
      if (mode === 'no-submit-recovery-dead-end') {
        active = active.filter(name => name !== 'run_check');
      }
      const persist = entry => fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\\n');
      persist({ type: 'session', id: 'parent' });
      persist({ type: 'message', message: { role: 'user', content: 'Implement issue: create generated.py and its test' } });
      persist({ type: 'message', message: { role: 'assistant', content: 'PARENT_TRANSCRIPT_ONLY_MARKER' } });
      const ctx = { cwd, model: { maxTokens: 32000 }, abort: () => { if (!['ceiling-draft', 'action-prose-abort', 'action-repeat-abort', 'action-hidden-abort', 'tool-contract', 'parent-contract', 'parent-contract-reverse', 'deferred-capability', 'deferred-then-removed', 'evidence-missing-executor', 'no-submit-recovery-dead-end', 'large-mutation-prose-abort', 'large-mutation-length-retry-abort', 'large-mutation-provider-retry-abort', 'large-mutation-action-retry-abort', 'large-mutation-coding-argument-retry-abort', 'scope-prelude-cap', 'action-required-serial'].includes(mode)) throw new Error('unexpected abort'); aborts++; },
        sessionManager: { getSessionId: () => 'parent', getSessionFile: () => (mode === 'no-session' ? null : sessionFile) } };
      const signal = new AbortController();
      const pi = {
        events: { on: (event, fn) => { bus.on(event, fn); return () => bus.off(event, fn); }, emit: (...args) => bus.emit(...args) },
        registerTool: tool => tools.set(tool.name, tool),
        on: (name, fn) => registerScenarioHook(handlers, name, fn),
        appendEntry: () => {},
        getAllTools: () => [...new Set([...tools.keys(), 'read', 'write', 'edit', 'bash'])].filter(name => mode !== 'narrow-registry' || name !== 'bash').map(name => ({ name })),
        getActiveTools: () => [...active], setActiveTools: names => { active = names; },
        setModel: async model => { caps.push(model.maxTokens); ctx.model = model; return true; },
        sendUserMessage: async text => { steers.push(text); },
      };
      const respond = (request, payload) => bus.emit('prompt-template:subagent:response', {
        requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, ...payload,
      });
      bus.on('pi-subagents:runtime-agent-register:v1', request => {
        registrations.push(structuredClone(request.definition));
        registered.set(request.name, structuredClone(request.definition));
        request.result = { ok: true, registration: { dispose() {} } };
      });
      if (mode === 'tampered' || mode === 'shadow-agent') {
        // The Implementer rewrites issue-worktree copies before starting the coding session.
        fs.mkdirSync(cwd + '/scripts', { recursive: true });
        fs.writeFileSync(cwd + '/scripts/pi-agent-runtime.mjs', 'import fs from "node:fs"; fs.writeFileSync(' + JSON.stringify(cwd + '/TAMPERED_RUNTIME_LOADED') + ', "yes"); export default function () {}');
        fs.mkdirSync(cwd + '/.pi/agents', { recursive: true });
        fs.writeFileSync(cwd + '/.pi/settings.json', JSON.stringify({ subagents: { agentOverrides: { 'implementer-coding-session': {
          tools: ['read', 'bash', 'write', 'subagent'], extensions: ['./scripts/pi-agent-runtime.mjs'], thinking: 'high' } } } }));
        if (mode === 'shadow-agent') fs.writeFileSync(cwd + '/.pi/agents/implementer-coding-session.md', '---\\nname: implementer-coding-session\\ntools: read, bash, write, subagent\\n---\\nDo anything.\\n');
      }

      // ---- simulated pi-subagents host for the forked coding session ----
      async function runFork(request) {
        const definition = registered.get(request.agent);
        if (mode === 'narrow-registry') assert.ok(!definition.tools.includes('bash'), 'fork allowlist excludes unavailable registry tools');
        if (!definition) return respond(request, { status: 'failed', error: 'Unknown agent: ' + request.agent });
        if (fs.existsSync(cwd + '/.pi/agents/' + request.agent + '.md')) {
          return respond(request, { status: 'failed', error: "Runtime agent '" + request.agent + "' collides with configured agent '" + request.agent + "'." });
        }
        assert.deepEqual(definition.extensions, [controlScripts + '/pi-bash-timeout.mjs', controlScripts + '/pi-agent-runtime.mjs', controlScripts + '/pi-implementer-result-tool.mjs']);
        assert.equal(definition.systemPromptMode, 'replace');
        assert.equal(definition.inheritProjectContext, false);
        assert.equal(definition.inheritGlobalContext, false);
        assert.equal(definition.inheritSkills, false);
        assert.equal(definition.defaultContext, 'fresh');
        assert.match(definition.systemPrompt, /## Coding-session contract/);
        assert.doesNotMatch(definition.systemPrompt, /## Startup|Available delegated agents|## Repository access routing|implementation-planner|begin_coding_session|request_large_mutation_budget|lsp_|Orbit/);
        const inherited = [];
        const childTools = new Map(); const childHandlers = new Map();
        let childAborts = 0;
        const childCtx = { cwd, model: { maxTokens: 32000 }, abort: () => {
          if (!['tool-contract', 'repair-nonconvergent', 'repair-rewrite-limit', 'repair-reasoning-fallback-abort', 'repair-provider-errors'].includes(mode)) throw new Error('fork aborted');
          childAborts += 1;
        },
          sessionManager: { getSessionId: () => 'coding', getSessionFile: () => null, getEntries: () => inherited, getHeader: () => ({}) } };
        let childActive = [...definition.tools];
        const childPi = { events: new EventEmitter(), registerTool: t => childTools.set(t.name, t),
          on: (n, f) => registerScenarioHook(childHandlers, n, f),
          getActiveTools: () => [...childActive], setActiveTools: names => { childActive = names.filter(name => definition.tools.includes(name)); },
          setModel: async model => { childCaps.push(model.maxTokens); childCtx.model = model; return true; },
          sendUserMessage: async () => {} };
        // Load exactly the registered extensions (ambient extensions disabled).
        for (const extensionPath of definition.extensions) {
          if (extensionPath.endsWith('/pi-bash-timeout.mjs')) continue;
          const { default: extension } = await import(new URL('file://' + extensionPath).href);
          if (extensionPath.endsWith('/pi-implementer-result-tool.mjs')) {
            // This legacy runtime scenario stubs the terminal executor and verifies
            // coding/recovery gates, not the real result-phase protocol. Its hook
            // lifecycle is replayed separately by the dedicated submission test.
            const on = childPi.on;
            childPi.on = () => {};
            extension(childPi);
            childPi.on = on;
          } else {
            extension(childPi);
          }
        }
        // Thinking off on the wire, from the trusted runtime, whatever the settings say.
        const realProviderPatch = childHandlers.get('before_provider_request');
        assert.ok(realProviderPatch, 'coding-session runtime patches provider requests');
        let lastProviderToolNames = [];
        const providerPatch = (event, ctx) => {
          const next = realProviderPatch(event, ctx);
          if (Array.isArray(next?.tools)) {
            lastProviderToolNames = next.tools.map(tool => tool.function?.name ?? tool.name);
          }
          return next;
        };
        const patched = providerPatch({ payload: { model: 'm', messages: [], max_completion_tokens: 16384, chat_template_kwargs: { keep: 1, enable_thinking: true } } }, childCtx);
        assert.deepEqual(patched.chat_template_kwargs, { keep: 1, enable_thinking: false });
        assert.equal(patched.max_completion_tokens, 16384, 'the 16K ceiling is untouched');
        const other = { input: 'not a chat payload' };
        assert.equal(providerPatch({ payload: other }, childCtx), other, 'non-chat payloads are left alone');
        const firstActionPayload = {
          model: 'm',
          messages: [],
          tools: childActive.map(name => ({ type: 'function', function: { name } })),
        };
        const firstActionRequest = providerPatch({ payload: firstActionPayload }, childCtx);
        assert.equal(firstActionRequest.tool_choice, 'required', 'the first coding-session provider request is constrained immediately');
        const firstRequestTools = firstActionRequest.tools.map(tool => tool.function?.name ?? tool.name);
        assert.ok(firstRequestTools.includes('need_more_evidence'), 'bounded evidence transition remains reachable');
        assert.ok(!firstRequestTools.includes('read'), 'inherited parent read intent is not advertised on the first request');
        assert.ok(!firstRequestTools.includes('bash'), 'forbidden cleanup shell is not advertised on the first request');
      if (mode === 'incapable-repeat' || mode === 'incapable-transition') {
          // #396/#399: the fork was launched for cleanup that needs raw bash. The model omits
          // required_capability; the trusted surface still blocks bash inside the fork.
          childHandlers.get('turn_start')({ turnIndex: 0 });
          const blocked = await childHandlers.get('tool_call')({ toolName: 'bash', toolCallId: 'cleanup-bash', input: { command: 'rm -f stray.txt' } }, childCtx);
          assert.equal(blocked?.block, true, 'raw bash stays unavailable inside the coding session');
          if (mode === 'incapable-transition') await childHandlers.get('turn_end')({ turnIndex: 0, message: { usage: { input: 7, output: 1, totalTokens: 8 } } }, childCtx);
          return respond(request, { status: 'completed', result: { kind: 'text', value: 'cleanup needs bash' }, usage: { output: 100 } });
        }
        if (mode === 'malformed-contract') {
          const spec = JSON.parse(process.env.PI_CODING_SESSION);
          fs.writeFileSync(spec.failureFile, '{"failure_code":');
          return respond(request, { status: 'failed', error: 'original delegation failure' });
        }
        if (mode === 'fork-deferred-capability') {
          // #441: submit_result became active after this fork payload was assembled.
          const stale = childActive.filter(name => name !== 'submit_result');
          const assembled = providerPatch({ payload: { model: 'm', messages: [], tools: stale.map(name => ({ type: 'function', function: { name } })) } }, childCtx);
          assert.deepEqual(assembled.tools.map(tool => tool.function.name), stale, 'fork request does not advertise a late-active definition');
          const call = { toolName: 'submit_result', toolCallId: 'fork-deferred', isError: true, content: [{ type: 'text', text: 'Tool submit_result not found' }] };
          await childHandlers.get('tool_execution_end')({ ...call, result: { content: call.content } }, childCtx);
          const rewritten = await childHandlers.get('tool_result')(call, childCtx);
          assert.match(rewritten.content[0].text, /not executable in this response/);
          // The tool_call gate and Pi's later executor-not-found hooks may
          // observe the same unavailable call. The child sidecar must contain
          // exactly one logical entry for it, regardless of hook duplication.
          const ghostCall = { toolName: 'ghost_tool', toolCallId: 'fork-ghost-1', input: {} };
          const ghostBlocked = await childHandlers.get('tool_call')(ghostCall, childCtx);
          assert.equal(ghostBlocked?.block, true);
          const ghostResult = { ...ghostCall, isError: true, content: [{ type: 'text', text: 'Tool ghost_tool not found' }] };
          await childHandlers.get('tool_execution_end')({ ...ghostResult, result: { content: ghostResult.content } }, childCtx);
          await childHandlers.get('tool_result')(ghostResult, childCtx);
          const sidecar = JSON.parse(fs.readFileSync(JSON.parse(process.env.PI_CODING_SESSION).capabilityFile, 'utf8'));
          assert.deepEqual(sidecar.unavailable_tools, ['ghost_tool'], 'both missing-executor callbacks create only one unavailable-tool sidecar entry');
          console.log('FORK_UNAVAILABLE_SIDECAR_ONCE_OK');
          console.log('FORK_DEFERRED_CAPABILITY_OK');
        }
        if (mode === 'tool-contract') {
          // write is in the authoritative first-request snapshot, so a missing executor is a real contract failure.
          await childHandlers.get('tool_execution_end')({ toolName: 'write', isError: true, result: { content: [{ type: 'text', text: 'Tool write not found' }] } }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: 0, message: { usage: { input: 10, output: 2, totalTokens: 12 } } }, childCtx);
          return respond(request, { status: 'failed', error: 'nested executor unavailable', usage: { input: 50, output: 5, totalTokens: 55 } });
        }
        // Executors stubbed; the runtime's gates around them are real.
        const repairFailure = variant => {
          const volatile = variant === 'volatile-a' || variant === 'volatile-b';
          const semanticNumber = variant === 'semantic-42' || variant === 'semantic-43';
          const syntaxFailure = variant === 'syntax-initial' || variant === 'syntax-shrunk';
          const volatileMessage = variant === 'volatile-b'
            ? 'test_constant: mismatch at /tmp/pytest-987/result.txt after 84.75ms address 0xdeadbeef'
            : 'test_constant: mismatch at /tmp/pytest-123/result.txt after 12.50ms address 0xabc123';
          let diagnostics = syntaxFailure
            ? (variant === 'syntax-shrunk'
              ? [{ file: 'test_generated.py', line: 1, column: null, code: 'SyntaxError', message: 'invalid syntax near token A' }]
              : [
                  { file: 'test_generated.py', line: 1, column: null, code: 'SyntaxError', message: 'invalid syntax near token A' },
                  { file: 'test_generated.py', line: 2, column: null, code: 'SyntaxError', message: 'unexpected EOF while parsing' },
                ])
            : volatile
              ? [{ file: 'test_generated.py', line: 4, column: null, code: 'AssertionError', message: volatileMessage }]
              : semanticNumber
                ? [{ file: 'test_generated.py', line: 4, column: null, code: 'AssertionError', message: 'test_constant: expected ' + (variant === 'semantic-43' ? '43' : '42') }]
                : variant === 'shrunk'
                  ? [{ file: 'test_generated.py', line: 4, column: null, code: 'AssertionError', message: 'test_constant: expected required constant' }]
                  : [
                      { file: 'test_generated.py', line: 4, column: null, code: 'AssertionError', message: 'test_constant: expected required constant' },
                      { file: 'test_generated.py', line: 8, column: null, code: 'AssertionError', message: 'test_secondary: expected public restart behavior' },
                    ];
          if (mode === 'repair-evidence' && variant === 'initial') {
            diagnostics = diagnostics.map((diagnostic, index) => index === 1
              ? { ...diagnostic, message: 'test_secondary: assertion mentions unterminated input but is not a syntax diagnostic' }
              : diagnostic);
            diagnostics = [...diagnostics, {
              file: 'link-source.py',
              line: 1,
              column: null,
              code: 'AssertionError',
              message: 'symlinked source diagnostic',
            }];
          }
          return {
            status: 'fail',
            kind: 'pytest',
            exit_code: 1,
            duration_ms: 7,
            summary: variant === 'shrunk' || variant === 'syntax-shrunk' || volatile || semanticNumber ? '1 failed' : '2 failed',
            diagnostics,
            stdout_tail: '',
            stderr_tail: '',
            truncated: false,
          };
        };
        const repairPass = () => ({
          status: 'pass',
          kind: 'pytest',
          exit_code: 0,
          duration_ms: 5,
          summary: '1 passed',
          diagnostics: [],
          stdout_tail: '',
          stderr_tail: '',
          truncated: false,
        });
        const appendRepairRecord = (params, result) => {
          const records = fs.existsSync(process.env.PI_VALIDATION_LEDGER_FILE)
            ? fs.readFileSync(process.env.PI_VALIDATION_LEDGER_FILE, 'utf8').split('\\n').filter(Boolean)
            : [];
          fs.appendFileSync(process.env.PI_VALIDATION_LEDGER_FILE, JSON.stringify({
            seq: records.length,
            timestamp: new Date().toISOString(),
            kind: result.kind,
            scope: result.kind === 'pytest'
              ? { targets: params.targets }
              : result.kind === 'profile'
                ? { profile: params.profile }
                : { paths: params.paths },
            status: result.status,
            exit_code: result.exit_code,
            source: 'run_check',
            stage: 'implementer',
            backend: 'pi',
            run_id: process.env.PI_VALIDATION_RUN_ID,
            attempt_id: 'primary',
            diagnostics_count: result.diagnostics.length,
            summary: result.summary,
            infrastructure: null,
          }) + '\\n');
        };
        childTools.get('run_check').execute = async (_toolCallId, params) => {
          if (mode === 'repair-empty-scope' && params?.kind === 'profile') {
            const result = {
              status: 'fail',
              kind: 'profile',
              exit_code: 1,
              duration_ms: 3,
              summary: 'profile failed without structured diagnostics',
              diagnostics: [],
              stdout_tail: '',
              stderr_tail: '',
              truncated: false,
            };
            appendRepairRecord(params, result);
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
          }
          if (['repair-evidence', 'repair-nonconvergent', 'repair-pass-reset', 'repair-volatile-message', 'repair-semantic-number', 'repair-iserror-details', 'repair-rewrite-limit', 'repair-reasoning-fallback', 'repair-reasoning-fallback-abort', 'repair-reasoning-prose-fallback', 'repair-retryable-provider-error', 'repair-provider-errors'].includes(mode) && params?.kind === 'pytest') {
            const variant = mode === 'repair-volatile-message'
              ? 'volatile-a'
              : mode === 'repair-semantic-number'
                ? 'semantic-42'
                : mode === 'repair-rewrite-limit'
                  ? 'syntax-initial'
                  : 'initial';
            const result = repairFailure(variant);
            appendRepairRecord(params, result);
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
          }
          if (mode === 'no-submit-recovery-partial' && params?.kind === 'pytest') {
            const result = repairFailure('initial');
            appendRepairRecord(params, result);
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
          }
          if (['no-submit-recovery', 'no-submit-recovery-dead-end'].includes(mode) && params?.kind === 'pytest') {
            fs.appendFileSync(process.env.PI_VALIDATION_LEDGER_FILE, JSON.stringify({
              seq: 0,
              timestamp: new Date().toISOString(),
              kind: 'pytest',
              scope: { targets: params.targets },
              status: 'infra_error',
              exit_code: null,
              source: 'run_check',
              stage: 'implementer',
              backend: 'pi',
              run_id: process.env.PI_VALIDATION_RUN_ID,
              attempt_id: 'primary',
              diagnostics_count: 0,
              summary: 'unsupported check environment key: PI_TRUSTED_ACCEPTANCE_TARGETS',
              infrastructure: { component: 'sandbox', code: 'CHECK_ENV', command: 'trusted-run-check-executor' },
            }) + '\\n');
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'infra_error', infrastructure: { code: 'CHECK_ENV' } }) }] };
          }
          if (params?.kind === 'pytest') {
            recordCodingBehavioralValidation({
              scope: { targets: params.targets },
              result: { status: 'pass', kind: 'pytest' },
              env: process.env,
            });
          }
          return { content: [{ type: 'text', text: 'check passed' }] };
        };
        childTools.get('submit_result').execute = async () => {
          writeImplementerResult(resultFile, mode === 'blocked' ? {
            title: 'Blocked task',
            summary: 'The issue cannot be implemented under the supplied constraints.',
            outcome: 'blocked',
            changes: [],
            files: [],
            blocked_reason: 'A required behavior conflicts with a stated constraint.',
          } : {
            title: 't', summary: 's', changes: ['c'], files: ['generated.py', 'test_generated.py'],
            security_notes: 'n', limitations: 'n',
          });
          const receiptEnv = { ...process.env, PI_TERMINAL_RESULT_FILE: terminal };
          writeTerminalReceiptFile(
            terminal,
            createSuccessfulTerminalReceipt({ cwd, resultFile, env: receiptEnv }),
          );
          return { content: [{ type: 'text', text: 'submitted' }] };
        };
        let turn = 0;
        if (mode === 'fork-prose-force') {
          // Simulate the provider ignoring the first request's required tool choice.
          childHandlers.get('turn_start')({ turnIndex: turn });
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, childCtx);
          const actionPayload = {
            model: 'm',
            messages: [],
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          const forced = providerPatch({ payload: actionPayload }, childCtx);
          assert.equal(forced.tool_choice, 'required', 'coding-session action_required uses the same forced-tool rule');
        }
        const childCall = async (name, input) => {
          childHandlers.get('turn_start')({ turnIndex: turn });
          if (!definition.tools.includes(name)) { turn++; return { block: true, reason: name + ' is not in the agent tool allowlist' }; }
          // A new simulated model turn rebuilds the provider request only when
          // the desired active tool was NOT in the preceding serialized request.
          // Redundant requests would consume the one-shot reasoning/fallback
          // phase and change the very repair state these tests exercise.
          if (childActive.includes(name) && !lastProviderToolNames.includes(name)) {
            providerPatch({ payload: {
              model: 'm', messages: [], tools: childActive.map(toolName => ({ type: 'function', function: { name: toolName } })),
            } }, childCtx);
          }
          const event = { toolName: name, toolCallId: 'c' + turn, input };
          const blocked = await childHandlers.get('tool_call')(event, childCtx);
          if (blocked) { await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 400 } } }, childCtx); return blocked; }
          let result; let isError = false;
          try {
            if (childTools.has(name)) result = await childTools.get(name).execute(event.toolCallId, input, null, null, childCtx);
            else { if (name === 'write') fs.writeFileSync(cwd + '/' + input.path, input.content); result = { content: [{ type: 'text', text: 'ok' }] }; }
          } catch (error) { isError = true; result = { content: [{ type: 'text', text: String(error.message) }] }; }
          if (
            mode === 'repair-iserror-details' &&
            name === 'run_check' &&
            input?.kind === 'pytest' &&
            result?.details?.status === 'fail'
          ) {
            isError = true;
          }
          await childHandlers.get('tool_execution_end')({ ...event, isError, result }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 3000 } } }, childCtx);
          return result;
        };
        const settleRepairRetry = async variant => {
          childHandlers.get('turn_start')({ turnIndex: turn });
          if (!lastProviderToolNames.includes('retry_last_failed_check')) {
            providerPatch({ payload: {
              model: 'm', messages: [], tools: childActive.map(toolName => ({ type: 'function', function: { name: toolName } })),
            } }, childCtx);
          }
          const event = { toolName: 'retry_last_failed_check', toolCallId: 'repair-retry-' + turn, input: {} };
          const blocked = await childHandlers.get('tool_call')(event, childCtx);
          assert.equal(blocked, undefined, 'exact retry passes the real runtime gate');
          const result = variant === 'pass' ? repairPass() : repairFailure(variant);
          appendRepairRecord({ targets: ['test_generated.py'] }, result);
          await childHandlers.get('tool_execution_end')({ ...event, isError: false, result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
          } }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 800 } } }, childCtx);
          return result;
        };
        const settleSyntheticDifferentScopePass = async () => {
          childHandlers.get('turn_start')({ turnIndex: turn });
          const event = {
            toolName: 'run_check',
            toolCallId: 'different-scope-pass-' + turn,
            input: { kind: 'python_compile', paths: ['generated.py'] },
          };
          const result = {
            status: 'pass',
            kind: 'python_compile',
            exit_code: 0,
            duration_ms: 2,
            summary: 'Compiled cleanly',
            diagnostics: [],
            stdout_tail: '',
            stderr_tail: '',
            truncated: false,
          };
          appendRepairRecord({ paths: ['generated.py'] }, result);
          await childHandlers.get('tool_execution_end')({ ...event, isError: false, result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
          } }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, childCtx);
        };
        const settleSyntheticBroaderScopePass = async () => {
          childHandlers.get('turn_start')({ turnIndex: turn });
          const event = {
            toolName: 'run_check',
            toolCallId: 'broader-scope-pass-' + turn,
            input: { kind: 'pytest', targets: ['test_generated.py', 'test_other.py'] },
          };
          const result = repairPass();
          appendRepairRecord(event.input, result);
          await childHandlers.get('tool_execution_end')({ ...event, isError: false, result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
          } }, childCtx);
          await childHandlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, childCtx);
        };
        if (mode === 'blocked') {
          await childCall('submit_result', { blocked_reason: 'A required behavior conflicts with a stated constraint.' });
          respond(request, { status: 'completed', result: { kind: 'text', value: 'blocked' }, usage: { output: 100 } });
          return;
        }
        // The coding "model" gets only the compact task handoff; parent transcript is absent.
        assert.equal(inherited.length, 0, 'fresh coding child has no inherited parent entries');
        assert.doesNotMatch(request.task, /PARENT_TRANSCRIPT_ONLY_MARKER/);
        const constant = request.task.includes('abc123') ? 'abc123' : undefined;
        if (mode === 'tampered') {
          assert.ok((await childCall('subagent', {})).block, 'worktree override cannot add subagent');
          assert.ok((await childCall('begin_coding_session', {})).block, 'no nested coding session');
        }
        if (mode === 'containment') {
          fs.symlinkSync('/tmp', cwd + '/link');
          assert.match((await childCall('write', { path: 'link/escape.py', content: 'x' })).reason, /symbolic links/);
          assert.match((await childCall('write', { path: '.git/hooks/pre-commit', content: 'x' })).reason, /cannot target .git/);
        }
        await childCall('accept_mutation_scope', {
          paths: ['generated.py', 'test_generated.py'],
          disposition: 'publishable',
          rationale: 'Issue requires the implementation module and its focused regression test.',
        });
        await childCall('write', { path: 'generated.py', content: 'REQUIRED_CONSTANT = "' + constant + '"\\nHELP = "q: quit\\\\nr: restart"\\n' });
        if (mode === 'fork-prose-force') {
          const actionPayload = {
            model: 'm',
            messages: [],
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          assert.equal(providerPatch({ payload: actionPayload }, childCtx).tool_choice, 'required', 'successful fork tools do not clear productive forcing');
        }
        await childCall('run_check', { kind: 'python_compile', paths: [cwd + '/generated.py'] });
        const testSource = mode === 'repair-evidence'
          ? 'from generated import REQUIRED_CONSTANT\\nfrom unchanged_helper import HELPER\\n\\ndef test_constant():\\n    assert REQUIRED_CONSTANT == "' + constant + '"\\n'
          : 'from generated import REQUIRED_CONSTANT\\n\\ndef test_constant():\\n    assert REQUIRED_CONSTANT == "' + constant + '"\\n';
        await childCall('write', { path: 'test_generated.py', content: testSource });
        if (mode === 'repair-evidence') {
          const outside = cwd + '/../repair-outside-' + process.pid + '.py';
          fs.writeFileSync(outside, 'OUTSIDE = true\\n');
          fs.symlinkSync(outside, cwd + '/link-source.py');
        }
        if (mode === 'repair-empty-scope') {
          const hiddenGit = cwd + '/.git-hidden-repair-empty';
          fs.renameSync(cwd + '/.git', hiddenGit);
          try {
            await childCall('run_check', { kind: 'profile', profile: 'repair-empty' });
          } finally {
            fs.renameSync(hiddenGit, cwd + '/.git');
          }
        } else {
          await childCall('run_check', { kind: 'pytest', targets: ['test_generated.py'] });
        }
        if (['repair-reasoning-fallback', 'repair-reasoning-fallback-abort', 'repair-reasoning-prose-fallback', 'repair-retryable-provider-error', 'repair-provider-errors'].includes(mode)) {
          const repairPayload = {
            model: 'm',
            messages: [],
            max_completion_tokens: 16384,
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          const evidenceRequest = providerPatch({ payload: repairPayload }, childCtx);
          assert.deepEqual(
            evidenceRequest.tools.map(tool => tool.function?.name ?? tool.name),
            ['read'],
            'repair still starts with one bounded read',
          );
          await childCall('read', { path: 'test_generated.py' });

          childHandlers.get('turn_start')({ turnIndex: turn });
          const reasoningRequest = providerPatch({ payload: repairPayload }, childCtx);
          const reasoningTools = reasoningRequest.tools.map(tool => tool.function?.name ?? tool.name);
          assert.equal(reasoningRequest.chat_template_kwargs.enable_thinking, true);
          assert.equal(reasoningRequest.max_completion_tokens, 4096);
          assert.equal(reasoningRequest.tool_choice, 'required');
          assert.ok(reasoningTools.includes('safe_edit'));
          assert.ok(reasoningTools.includes('structural_edit'));
          assert.ok(reasoningTools.includes('submit_result'));
          assert.ok(!reasoningTools.includes('read'));
          assert.ok(!reasoningTools.includes('accept_mutation_scope'));
          assert.ok(!reasoningTools.includes('run_check'));

          if (mode === 'repair-retryable-provider-error') {
            await childHandlers.get('turn_end')({
              turnIndex: turn++,
              message: { stopReason: 'error', errorMessage: '429: {"error":"rate limited"}', usage: { input: 10, output: 0, totalTokens: 10 } },
            }, childCtx);
            assert.equal(childAborts, 0);
            childHandlers.get('turn_start')({ turnIndex: turn });
            const retriedReasoning = providerPatch({ payload: repairPayload }, childCtx);
            assert.equal(retriedReasoning.chat_template_kwargs.enable_thinking, true, 'retryable provider error re-arms the same reasoning phase');
            assert.equal(retriedReasoning.max_completion_tokens, 4096);
            assert.equal(retriedReasoning.tool_choice, 'required');
            await childCall('safe_edit', {
              path: 'test_generated.py',
              operation: 'insert_after',
              start_line: 4,
              text: '# provider retry repair\\n',
            });
            console.log('CODING_REPAIR_PROVIDER_RETRY_OK');
            return respond(request, { status: 'failed', error: 'simulated stop after provider retry proof', usage: { output: 500 } });
          }

          if (mode === 'repair-provider-errors') {
            await childHandlers.get('turn_end')({
              turnIndex: turn++,
              message: { stopReason: 'error', errorMessage: '422: {"error":"rejected"}', usage: { input: 10, output: 0, totalTokens: 10 } },
            }, childCtx);
          } else {
            await childHandlers.get('turn_end')({
              turnIndex: turn++,
              message: mode === 'repair-reasoning-prose-fallback'
                ? { usage: { input: 20, output: 64, totalTokens: 84 } }
                : { stopReason: 'length', usage: { input: 20, output: 4095, totalTokens: 4115 } },
            }, childCtx);
          }

          childHandlers.get('turn_start')({ turnIndex: turn });
          const fallbackRequest = providerPatch({ payload: repairPayload }, childCtx);
          const fallbackTools = fallbackRequest.tools.map(tool => tool.function?.name ?? tool.name);
          assert.equal(fallbackRequest.chat_template_kwargs.enable_thinking, false, 'fallback is low-overhead');
          assert.equal(fallbackRequest.tool_choice, 'required', 'fallback remains provider action-forced');
          assert.ok(fallbackTools.includes('safe_edit'));
          assert.ok(fallbackTools.includes('submit_result'));
          assert.ok(!fallbackTools.includes('read'), 'repair evidence cannot reopen before mutation');
          assert.ok(!fallbackTools.includes('accept_mutation_scope'));
          assert.ok(!fallbackTools.includes('run_check'));

          if (mode === 'repair-provider-errors') {
            await childHandlers.get('turn_end')({
              turnIndex: turn++,
              message: { stopReason: 'error', errorMessage: '422: {"error":"rejected"}', usage: { input: 10, output: 0, totalTokens: 10 } },
            }, childCtx);
            assert.equal(childAborts, 1, 'non-retryable fallback provider rejection aborts deterministically');
            console.log('CODING_REPAIR_PROVIDER_ERROR_ABORT_OK');
            return respond(request, { status: 'failed', error: 'PI_CODING_REPAIR_ACTION_FALLBACK_FAILED', usage: { output: 100 } });
          }

          if (mode === 'repair-reasoning-fallback-abort') {
            await childHandlers.get('turn_end')({
              turnIndex: turn++,
              message: { usage: { input: 10, output: 64, totalTokens: 74 } },
            }, childCtx);
            assert.equal(childAborts, 1, 'one empty cheap fallback aborts deterministically');
            console.log('CODING_REPAIR_FALLBACK_ABORT_OK');
            return respond(request, { status: 'failed', error: 'PI_CODING_REPAIR_ACTION_FALLBACK_FAILED', usage: { output: 4200 } });
          }

          const fallbackMutation = await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 4,
            text: '# repair fallback mutation\\n',
          });
          assert.equal(fallbackMutation.block, undefined, 'fallback action executes');
          assert.ok(childActive.includes('retry_last_failed_check'));

          if (mode === 'repair-reasoning-prose-fallback') {
            console.log('CODING_REPAIR_PROSE_FALLBACK_OK');
            return respond(request, { status: 'failed', error: 'simulated stop after prose fallback proof', usage: { output: 500 } });
          }

          const postMutationRequest = providerPatch({ payload: repairPayload }, childCtx);
          assert.equal(postMutationRequest.chat_template_kwargs.enable_thinking, false, 'successful mutation clears fallback obligation');
          assert.ok(!postMutationRequest.tools.some(tool => (tool.function?.name ?? tool.name) === 'read'), 'read stays closed until authoritative validation changes state');

          await settleRepairRetry('shrunk');
          const nextEvidence = providerPatch({ payload: repairPayload }, childCtx);
          assert.deepEqual(nextEvidence.tools.map(tool => tool.function?.name ?? tool.name), ['read'], 'new validation failure re-arms one bounded read');
          await childCall('read', { path: 'test_generated.py' });
          const nextReasoning = providerPatch({ payload: repairPayload }, childCtx);
          assert.equal(nextReasoning.chat_template_kwargs.enable_thinking, true, 'new validation state re-arms reasoning');
          assert.equal(nextReasoning.tool_choice, 'required', 'new validation state re-arms action forcing');
          assert.equal(nextReasoning.max_completion_tokens, 4096);

          console.log('CODING_REPAIR_REASONING_FALLBACK_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after fallback proof', usage: { output: 5000 } });
        }

        if (mode === 'repair-evidence') {
          const repairPayload = {
            model: 'm',
            messages: [],
            max_completion_tokens: 16384,
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          const evidenceRequest = providerPatch({ payload: repairPayload }, childCtx);
          const evidenceTools = evidenceRequest.tools.map(tool => tool.function?.name ?? tool.name);
          assert.equal(evidenceRequest.tool_choice, 'required', 'failed validation requires a concrete repair action');
          assert.equal(evidenceRequest.chat_template_kwargs.enable_thinking, false, 'repair evidence read stays low-overhead');
          assert.equal(evidenceRequest.max_completion_tokens, 16384, 'repair evidence read does not consume the reasoning cap');
          assert.deepEqual(evidenceTools, ['read'], 'first provider request after a failed check is evidence-only when a trusted repair path exists');

          const unrelated = await childCall('read', { path: 'README.md' });
          assert.equal(unrelated.block, true);
          assert.match(unrelated.reason, /repair read is limited to the authoritative failing\\/changed paths/);

          const symlinkEscape = await childCall('read', { path: 'link-source.py' });
          assert.equal(symlinkEscape.block, true, 'diagnostic symlink escaping the worktree is never authorized');
          assert.ok(!symlinkEscape.reason.includes('link-source.py'), 'symlink escape is removed from the trusted repair path set');

          const boundedRead = await childCall('read', { path: 'test_generated.py' });
          assert.equal(boundedRead.block, undefined, 'failing test file can be read directly');

          const reasoningRequest = providerPatch({ payload: repairPayload }, childCtx);
          const reasoningTools = reasoningRequest.tools.map(tool => tool.function?.name ?? tool.name);
          assert.equal(reasoningRequest.tool_choice, 'required', 'repair reasoning itself is action-forced after the read consumes the generic forcing flag');
          assert.equal(reasoningRequest.chat_template_kwargs.enable_thinking, true, 'thinking is reserved for the mutation decision after repair evidence');
          assert.equal(reasoningRequest.max_completion_tokens, 4096, 'repair reasoning has a small output ceiling');
          assert.ok(!reasoningTools.includes('read'), 'the reasoning request cannot spend itself on another read');
          assert.ok(reasoningTools.includes('safe_edit'), 'localized mutation remains provider-visible in repair');
          assert.ok(reasoningTools.includes('structural_edit'), 'structural localized mutation remains provider-visible in repair');
          assert.ok(!reasoningTools.includes('repo_search'), 'repair does not reopen repository discovery');
          assert.ok(!reasoningTools.includes('need_more_evidence'), 'repair does not spend the generic evidence unlock');

          const noCapFailure = repairFailure('initial');
          await childHandlers.get('tool_execution_end')({
            toolName: 'run_check', toolCallId: 'repair-no-cap-reset', input: { kind: 'pytest', targets: ['test_generated.py'] }, isError: false,
            result: { content: [{ type: 'text', text: JSON.stringify(noCapFailure) }], details: noCapFailure },
          }, childCtx);
          const noCapEvidence = providerPatch({ payload: { model: 'm', messages: [], tools: childActive.map(name => ({ type: 'function', function: { name } })) } }, childCtx);
          assert.equal(noCapEvidence.chat_template_kwargs.enable_thinking, false);
          await childCall('read', { path: 'test_generated.py' });
          const noCapReasoning = providerPatch({ payload: { model: 'm', messages: [], tools: childActive.map(name => ({ type: 'function', function: { name } })) } }, childCtx);
          assert.equal(noCapReasoning.chat_template_kwargs.enable_thinking, true);
          assert.equal(noCapReasoning.max_completion_tokens, 4096, 'repair reasoning installs a 4K ceiling even when the provider payload had no token field');

          const blockedRewrite = await childCall('write', {
            path: 'test_generated.py',
            content: testSource + '# wasteful whole-file regeneration\\n',
          });
          assert.equal(blockedRewrite.block, true, 'ordinary assertion repair cannot regenerate an existing file');
          assert.match(blockedRewrite.reason, /does not justify a broad repair/);
          assert.equal(childAborts, 0, 'first broad attempt redirects to localized repair instead of aborting the fork');

          const nestedBroadEdit = await childCall('edit', {
            path: 'test_generated.py',
            edits: [{ oldText: 'x', newText: 'x'.repeat(13001) }],
          });
          assert.equal(nestedBroadEdit.block, true, 'nested edits[] payloads are classified as broad without assuming the built-in edit schema');
          assert.match(nestedBroadEdit.reason, /does not justify a broad repair/);
          assert.equal(childAborts, 0);

          await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 5,
            text: '# targeted repair\\n',
          });
          assert.ok(childActive.includes('retry_last_failed_check'), 'targeted repair re-enables exact retry');
          await settleRepairRetry('shrunk');
          assert.equal(childAborts, 0, 'a shrinking failure set remains repairable');
          console.log('CODING_REPAIR_EVIDENCE_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after shrinking repair proof', usage: { output: 3000 } });
        }
        if (mode === 'repair-rewrite-limit') {
          const repairPayload = {
            model: 'm',
            messages: [],
            max_completion_tokens: 16384,
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          const evidenceRequest = providerPatch({ payload: repairPayload }, childCtx);
          assert.equal(evidenceRequest.chat_template_kwargs.enable_thinking, false, 'syntax repair still gathers bounded evidence before reasoning');
          assert.deepEqual(evidenceRequest.tools.map(tool => tool.function?.name ?? tool.name), ['read']);
          await childCall('read', { path: 'test_generated.py' });
          const firstRepairRequest = providerPatch({ payload: repairPayload }, childCtx);
          assert.equal(firstRepairRequest.chat_template_kwargs.enable_thinking, true, 'syntax failure gets one repair reasoning request after evidence');
          assert.equal(firstRepairRequest.tool_choice, 'required', 'successful repair reasoning is action-forced');
          assert.equal(firstRepairRequest.max_completion_tokens, 4096, 'syntax repair reasoning is bounded');
          assert.ok(!firstRepairRequest.tools.some(tool => (tool.function?.name ?? tool.name) === 'read'));
          const firstRewrite = await childCall('write', {
            path: 'test_generated.py',
            content: testSource + '# syntax-corruption full replacement\\n',
          });
          assert.equal(firstRewrite.block, undefined, 'syntax/parse corruption may use one bounded broad mutation');
          assert.ok(childActive.includes('retry_last_failed_check'));
          await settleRepairRetry('syntax-shrunk');

          const secondEvidenceRequest = providerPatch({ payload: repairPayload }, childCtx);
          assert.equal(secondEvidenceRequest.chat_template_kwargs.enable_thinking, false, 'new failure starts with evidence again');
          await childCall('read', { path: 'test_generated.py' });
          const secondRepairRequest = providerPatch({ payload: { model: 'm', messages: [], tools: childActive.map(name => ({ type: 'function', function: { name } })) } }, childCtx);
          assert.equal(secondRepairRequest.chat_template_kwargs.enable_thinking, true, 'new authoritative failure re-arms one bounded repair reasoning request');
          assert.equal(secondRepairRequest.tool_choice, 'required', 'new validation state re-arms action forcing with reasoning');
          assert.equal(secondRepairRequest.max_completion_tokens, 4096, 'missing provider token field is capped explicitly');

          const secondRewrite = await childCall('write', {
            path: 'test_generated.py',
            content: testSource + '# repeated full replacement\\n',
          });
          assert.equal(secondRewrite.block, true, 'strictly shrinking diagnostics do not reset the cross-tool broad-mutation counter');
          assert.match(secondRewrite.reason, /broad-mutation limit reached/);
          assert.equal(childAborts, 0, 'first blocked broad retry redirects instead of killing the session');

          const broadSafeEdit = await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'replace',
            start_line: 1,
            end_line: 120,
            text: 'x'.repeat(13001),
          });
          assert.equal(broadSafeEdit.block, true, 'safe_edit cannot bypass the consumed broad-mutation budget');
          assert.equal(childAborts, 0);

          const broadNestedEdit = await childCall('edit', {
            path: 'test_generated.py',
            edits: [{ old_text: 'x', new_text: 'y'.repeat(13001) }],
          });
          assert.equal(broadNestedEdit.block, true, 'nested built-in edit payload cannot bypass the broad-mutation budget');
          assert.equal(childAborts, 1, 'third blocked broad attempt aborts deterministically with the worktree preserved');
          console.log('CODING_REPAIR_BROAD_MUTATION_LIMIT_OK');
          return respond(request, { status: 'failed', error: 'PI_CODING_REPAIR_BROAD_MUTATION_LIMIT', usage: { output: 3000 } });
        }
        if (mode === 'repair-nonconvergent') {
          const flipFlop = [
            ['shrunk', 'a strict reduction resets the non-improving count'],
            ['initial', 'expanding back to a seen failure set is non-improving but still below the bound'],
            ['shrunk', 'returning to the prior best set is not a new strict reduction'],
            ['initial', 'another expansion remains bounded but does not yet abort'],
            ['shrunk', 'the fifth non-improving failure reaches the bounded repair ceiling'],
          ];
          for (let index = 0; index < flipFlop.length; index++) {
            await settleSyntheticDifferentScopePass();
            // Each new failed-check scope reopens an evidence-only provider turn.
            // Read the authoritative test before the next mutation turn.
            if (childActive.includes('read')) await childCall('read', { path: 'test_generated.py' });
            await childCall('safe_edit', {
              path: 'test_generated.py',
              operation: 'insert_after',
              start_line: 4 + index,
              text: '# targeted repair round ' + (index + 1) + '\\n',
            });
            assert.ok(childActive.includes('retry_last_failed_check'));
            await settleRepairRetry(flipFlop[index][0]);
            assert.equal(
              childAborts,
              index === flipFlop.length - 1 ? 1 : 0,
              flipFlop[index][1],
            );
          }
          console.log('CODING_REPAIR_NONCONVERGENT_OK');
          return respond(request, { status: 'failed', error: 'PI_CODING_VALIDATION_NON_CONVERGENT', usage: { output: 5000 } });
        }

        if (mode === 'repair-volatile-message') {
          // Repair evidence must precede a new request containing mutation tools.
          if (childActive.includes('read')) await childCall('read', { path: 'test_generated.py' });
          await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 4,
            text: '# volatile diagnostic retry\\n',
          });
          assert.ok(childActive.includes('retry_last_failed_check'));
          await settleRepairRetry('volatile-b');
          assert.equal(childAborts, 0, 'volatile diagnostic values stay one semantic failure identity');
          console.log('CODING_REPAIR_VOLATILE_MESSAGE_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after volatile identity proof', usage: { output: 3000 } });
        }

        if (mode === 'repair-semantic-number') {
          // Evidence-only and mutation-only provider phases are distinct requests.
          if (childActive.includes('read')) await childCall('read', { path: 'test_generated.py' });
          await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 4,
            text: '# semantic number retry\\n',
          });
          assert.ok(childActive.includes('retry_last_failed_check'));
          await settleRepairRetry('semantic-43');
          assert.equal(childAborts, 0);
          console.log('CODING_REPAIR_SEMANTIC_NUMBER_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after semantic-number identity proof', usage: { output: 3000 } });
        }

        if (mode === 'repair-iserror-details') {
          assert.ok(childActive.includes('read'), 'structured fail details open repair evidence even when transport marks the tool errored');
          const readAfterErroredFail = await childCall('read', { path: 'test_generated.py' });
          assert.equal(readAfterErroredFail.block, undefined);
          console.log('CODING_REPAIR_ISERROR_DETAILS_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after isError repair proof', usage: { output: 3000 } });
        }

        if (mode === 'repair-empty-scope') {
          const repairPayload = {
            model: 'm',
            messages: [],
            max_completion_tokens: 16384,
            tools: childActive.map(name => ({ type: 'function', function: { name } })),
          };
          const repairRequest = providerPatch({ payload: repairPayload }, childCtx);
          const repairTools = repairRequest.tools.map(tool => tool.function?.name ?? tool.name);
          assert.ok(!repairTools.includes('read'), 'an empty trusted repair scope does not expose a read that can only dead-end');
          const repairEdit = await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 4,
            text: '# repair without bounded evidence path\\n',
          });
          assert.equal(repairEdit.block, undefined, 'empty repair evidence releases the read-before-mutation gate');
          console.log('CODING_REPAIR_EMPTY_SCOPE_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after empty-scope recovery proof', usage: { output: 3000 } });
        }

        if (mode === 'repair-pass-reset') {
          // An authoritative failed check exposes read before a scoped fix.
          if (childActive.includes('read')) await childCall('read', { path: 'test_generated.py' });
          await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 4,
            text: '# pass reset\\n',
          });
          assert.ok(childActive.includes('retry_last_failed_check'));
          await settleSyntheticBroaderScopePass();
          assert.equal(childAborts, 0);

          const afterGreenPayload = providerPatch({ payload: { model: 'm', messages: [], tools: childActive.map(name => ({ type: 'function', function: { name } })) } }, childCtx);
          assert.equal(afterGreenPayload.chat_template_kwargs.enable_thinking, false, 'green validation returns the coding session to low-overhead thinking');
          await childCall('safe_edit', {
            path: 'test_generated.py',
            operation: 'insert_after',
            start_line: 5,
            text: '# fail again after covering pass\\n',
          });
          await childCall('run_check', { kind: 'pytest', targets: ['test_generated.py'] });
          assert.equal(childAborts, 0, 'provably covering same-kind pass clears prior convergence history');
          console.log('CODING_REPAIR_PASS_RESET_OK');
          return respond(request, { status: 'failed', error: 'simulated stop after covering-scope reset proof', usage: { output: 3000 } });
        }

        if (!['no-submit', 'no-submit-parent-submit', 'no-submit-recovery', 'no-submit-recovery-dead-end', 'no-submit-recovery-partial'].includes(mode)) await childCall('submit_result', { title: 't', summary: 's', changes: ['c'], files: ['generated.py', 'test_generated.py'], security_notes: 'n', limitations: 'n' });
        if (['no-submit-recovery', 'no-submit-recovery-dead-end', 'no-submit-recovery-partial'].includes(mode)) {
          respond(request, {
            status: 'failed',
            error: 'PI_ACTION_REQUIRED_ABORT: simulated child abort after deterministic CHECK_ENV',
            usage: { output: 9000 },
          });
        } else {
          respond(request, { status: 'completed', result: { kind: 'text', value: 'done' }, usage: { output: 9000 } });
        }
      }
      bus.on('prompt-template:subagent:request', async request => {
        assert.notEqual(request.agent, 'implementation-planner', 'planning runs in the bootstrap session, never in the main one');
        assert.equal(request.agent, 'implementer-coding-session');
        assert.equal(request.context, 'fresh', 'coding runs from a clean context, not the parent transcript');
        assert.deepEqual(request.result, { kind: 'text' });
        assert.equal(request.toolBudget, undefined, 'no artificial tool budget on the coding session');
        // Request-level thinking: pi-subagents 0.71.0 resolves thinkingOverride ?? agent.thinking
        // (replaceExisting suffix), so it wins over worktree agentOverrides.thinking / defaults.
        assert.equal(request.thinking, 'off', 'coding session requested with thinking off');
        assert.match(request.task, /<untrusted_task_input>/);
        assert.match(request.task, /<prepared_implementation>/);
        assert.match(request.task, /<parent_execution_handoff>/);
        assert.match(request.task, /<runtime_state>/);
        if (mode === 'fallback') assert.doesNotMatch(request.task, /Planner fact marker/);
        else assert.equal(request.task.match(/Planner fact marker/g)?.length, 1, 'prepared repository facts are handed off exactly once');
        assert.doesNotMatch(request.task, /## Startup|Available delegated agents|Repository access routing|PARENT_TRANSCRIPT_ONLY_MARKER/);
        sessionRequests.push({ requestId: request.requestId, task: request.task, maxTokens: process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, spec: JSON.parse(process.env.PI_CODING_SESSION) });
        if (mode.startsWith('terminal-binding-')) {
          heldTerminalRequests.push(request);
          terminalRequestBarriers[heldTerminalRequests.length - 1]?.release(request);
          return;
        }
        if (mode === 'cancel') { signal.abort(); return; }
        await runFork(request);
      });

      runtime(pi);
      // The parent also carries the real implementer result tool (and its submit nudge).
      const { default: parentResultTool } = await import(${JSON.stringify(new URL('../scripts/pi-implementer-result-tool.mjs', import.meta.url).href)});
      parentResultTool(pi);
      assert.equal(handlers.has('before_provider_request'), true, 'the parent installs the provider constraint hook');
      assert.equal(handlers.has('turn_end'), true, 'the parent installs provider error recovery on the authoritative turn boundary');
      if (mode === 'bash-error-mutates' || mode === 'bash-error-unknown') {
        process.env.PI_CODING_SESSION_USED = 'true';
        const changedFiles = ['src/game.py', 'tests/test_game.py'];
        recordCodingBehavioralValidation({
          scope: { targets: ['tests/test_game.py'] },
          result: { status: 'pass', kind: 'pytest' },
          env: process.env,
          cwd,
        });
        assert.doesNotThrow(() => assertCodingBehavioralValidation({ changedFiles, env: process.env }));

        handlers.get('turn_start')({ turnIndex: 0 });
        const bashEvent = {
          toolName: 'bash',
          toolCallId: 'failed-bash-validation',
          input: { command: 'git status --short -- generated.py' },
        };
        assert.equal(await handlers.get('tool_call')(bashEvent, ctx), undefined, 'bounded bash reaches execution');
        let hiddenGit = null;
        if (mode === 'bash-error-mutates') {
          fs.writeFileSync(cwd + '/bash-mutated.txt', 'changed\\n');
        } else {
          hiddenGit = cwd + '/.git-hidden-for-test';
          fs.renameSync(cwd + '/.git', hiddenGit);
        }
        try {
          await handlers.get('tool_execution_end')({
            ...bashEvent,
            isError: true,
            result: { content: [{ type: 'text', text: 'command failed after execution' }] },
          }, ctx);
        } finally {
          if (hiddenGit && fs.existsSync(hiddenGit)) fs.renameSync(hiddenGit, cwd + '/.git');
        }
        assert.throws(
          () => assertCodingBehavioralValidation({ changedFiles, env: process.env }),
          /TARGETED_BEHAVIORAL_VALIDATION_REQUIRED/,
          'failed bash must invalidate stale pytest evidence when the worktree changed or fingerprint is unknown',
        );
        console.log(mode === 'bash-error-mutates' ? 'FAILED_BASH_MUTATION_INVALIDATED' : 'FAILED_BASH_UNKNOWN_INVALIDATED');
        process.exit(0);
      }

      if (mode === 'parent-contract' || mode === 'parent-contract-reverse') {
        const resultEvent = { toolCallId: 'missing-bash', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'Tool bash not found' }] };
        const executionEvent = { ...resultEvent, result: { content: resultEvent.content } };
        const hooks = mode === 'parent-contract' ? ['tool_result', 'tool_execution_end'] : ['tool_execution_end', 'tool_result'];
        for (const hook of hooks) await handlers.get(hook)(hook === 'tool_result' ? resultEvent : executionEvent, ctx);
        assert.equal(aborts, 1);
        const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
        assert.equal(failure.failure_class, 'infrastructure');
        assert.equal(failure.failure_code, 'PI_TOOL_CONTRACT_FAILURE');
        assert.equal(sessionRequests.length, 0);
        process.exit(0);
      }
      // pi assembles the payload from the active surface; the runtime's own sync may only shrink it here.
      const unarmedPayload = { model: 'm', messages: [], tools: active.filter(name => name !== 'run_check').map(name => ({ type: 'function', function: { name } })) };
      const firstParentRequest = handlers.get('before_provider_request')({ payload: unarmedPayload }, ctx);
      if (mode === 'restored' || mode === 'action-required-serial') {
        assert.equal(firstParentRequest.tool_choice, 'required', 'prepared action_required startup constrains the first parent request');
      } else {
        assert.equal(firstParentRequest, unarmedPayload, 'preparation-phase parent request is unchanged');
      }
      if (mode === 'action-required-serial') {
        const payload = () => ({
          model: 'm', messages: [],
          tools: active.map(name => ({ type: 'function', function: { name } })),
        });
        const wire = () => handlers.get('before_provider_request')({ payload: payload() }, ctx);
        const named = implementerToolChoiceDecision({ ...payload(), tool_choice: { type: 'function', function: { name: 'write' } } }, { productiveState: 'action_required' });
        assert.deepEqual(named.toolChoice, { type: 'function', function: { name: 'write' } }, 'preserve named recovery');
        assert.equal(implementerToolChoiceDecision({ tools: [] }, { productiveState: 'action_required' }).toolChoice, 'none');
        assert.equal(implementerToolChoiceDecision(payload(), { productiveState: 'evidence_allowed' }).toolChoice, 'auto');
        assert.equal(implementerToolChoiceDecision({ tools: [{ type: 'function', function: { name: 'read' } }] }, { productiveState: 'action_required' }).payload.tools.length, 1, 'a deferred write cannot be advertised');
        const first = wire();
        assert.equal(first.tool_choice, 'required', 'prepared Main starts action-forced');
        handlers.get('turn_start')({ turnIndex: 0 });
        const accepted = { toolName: 'subagents_enable', toolCallId: 'successful-control', input: {} };
        assert.equal(await handlers.get('tool_call')(accepted, ctx), undefined);
        await handlers.get('tool_execution_end')({
          ...accepted, isError: false, result: { content: [{ type: 'text', text: 'ok' }] },
        }, ctx);
        await handlers.get('turn_end')({ turnIndex: 0, message: { stopReason: 'toolUse', usage: { output: 100 } } }, ctx);
        const second = wire();
        assert.equal(second.tool_choice, 'required', 'successful tool did not disarm action_required');
        handlers.get('turn_start')({ turnIndex: 1 });
        const failed = { toolName: 'read', toolCallId: 'failed-read', input: { path: 'missing.py' } };
        assert.equal(await handlers.get('tool_call')(failed, ctx), undefined);
        await handlers.get('tool_execution_end')({
          ...failed, isError: true, result: { content: [{ type: 'text', text: 'file unavailable' }] },
        }, ctx);
        await handlers.get('turn_end')({ turnIndex: 1, message: { stopReason: 'toolUse', usage: { output: 100 } } }, ctx);
        const third = wire();
        assert.equal(third.tool_choice, 'required', 'locally failed tool did not disarm action_required');
        assert.ok([first, second, third].every(req => req.tools.some(t => t.function.name === 'write')));
        // A successful provider stop without a tool under required must be diagnosed
        // but must not be counted as a successful action or an output-ceiling event.
        handlers.get('turn_start')({ turnIndex: 2 });
        await handlers.get('turn_end')({ turnIndex: 2, message: {
          stopReason: 'stop', usage: { output: 100 }, content: [{ type: 'text', text: 'prose' }],
        } }, ctx);
        assert.equal(aborts, 0, 'first contract violation receives one retry');
        assert.equal(wire().tool_choice, 'required', 'second prose attempt also forced');
        handlers.get('turn_start')({ turnIndex: 3 });
        await handlers.get('turn_end')({ turnIndex: 3, message: {
          stopReason: 'stop', usage: { output: 100 }, content: [{ type: 'text', text: 'prose again' }],
        } }, ctx);
        assert.equal(aborts, 1, 'second violation triggers the bounded watchdog');
        assert.equal(JSON.parse(fs.readFileSync(runtimeFailure, 'utf8')).failure_code, 'PI_ACTION_REQUIRED_ABORT');
        assert.equal(fs.existsSync(resultFile), false, 'no terminal result published');
        console.log('ACTION_REQUIRED_SERIAL_OK');
        process.exit(0);
      }
      const filteredPayload = handlers.get('before_provider_request')({ payload: { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'invented_tool' } }] } }, ctx);
      assert.deepEqual(filteredPayload.tools, [], 'provider never advertises a non-active tool');
      // That deliberately malformed provider probe is NOT the subsequent model
      // response. Serialize the actual active definitions before replaying tool calls:
      // a zero-tool request must never gain permissions from getActiveTools().
      handlers.get('before_provider_request')({
        payload: { model: 'm', messages: [], tools: active.map(name => ({ type: 'function', function: { name } })) },
      }, ctx);
      if (mode === 'deferred-capability' || mode === 'deferred-then-removed') {
        // #441: submit_result became active after pi assembled this payload.
        handlers.get('turn_start')({ turnIndex: 0 });
        const stale = active.filter(name => name !== 'submit_result');
        const assembled = handlers.get('before_provider_request')({ payload: { model: 'm', messages: [], tools: stale.map(name => ({ type: 'function', function: { name } })) } }, ctx);
        assert.deepEqual(assembled.tools.map(tool => tool.function.name), stale, 'a late-active definition is not added to the assembled request');
        assert.ok(active.includes('submit_result'), 'the live surface keeps the expansion for the next request');

        // The model calls the deferred tool anyway; pi resolves calls against this turn's context.
        const deferredCall = { toolName: 'submit_result', toolCallId: 'deferred-call', isError: true, content: [{ type: 'text', text: 'Tool submit_result not found' }] };
        await handlers.get('tool_execution_end')({ ...deferredCall, result: { content: deferredCall.content } }, ctx);
        const deferredResult = await handlers.get('tool_result')(deferredCall, ctx);
        assert.equal(aborts, 0, 'a deferred tool call is a lifecycle mismatch, not an infrastructure failure');
        assert.equal(fs.existsSync(runtimeFailure), false);
        assert.match(deferredResult.content[0].text, /became active after provider request \\d+ was built.*Do not retry it in this response.*call it only if that request exposes it/s);
        assert.doesNotMatch(deferredResult.content[0].text.split('CURRENTLY EXPOSED TOOLS')[1], /submit_result/, 'guidance names only this request surface');
        const lifecycleSteers = steers.filter(text => /submit_result became active after provider request/.test(text));
        assert.equal(lifecycleSteers.length, 1, 'one lifecycle steer reaches the next request even though pi skips tool_result');
        assert.match(lifecycleSteers[0], /Do not retry it in this response.*call it only if that request exposes it/s, 'the steer is conditional on the next request snapshot');
        assert.doesNotMatch(lifecycleSteers[0], /executable from|onward/, 'the steer does not promise the next request surface');

        if (mode === 'deferred-then-removed') {
          // Another tool in the same response changes state and removes the deferred tool again.
          pi.setActiveTools(active.filter(name => name !== 'submit_result'));
          handlers.get('turn_start')({ turnIndex: 1 });
          const next = handlers.get('before_provider_request')({ payload: { model: 'm', messages: [], tools: active.map(name => ({ type: 'function', function: { name } })) } }, ctx);
          assert.ok(!next.tools.some(tool => tool.function.name === 'submit_result'), 'the next request does not expose the removed tool');
          // The model follows the old deferral anyway: neither executable nor deferred now.
          const stale = { toolName: 'submit_result', toolCallId: 'stale-deferred', isError: true, content: [{ type: 'text', text: 'Tool submit_result not found' }] };
          const staleResult = await handlers.get('tool_result')(stale, ctx);
          assert.equal(aborts, 0, 'a call that follows stale deferral is not an infrastructure failure');
          assert.match(staleResult.content[0].text, /BLOCKED: submit_result is not exposed/);
          assert.doesNotMatch(staleResult.content[0].text.split('CURRENTLY EXPOSED TOOLS')[1], /submit_result/);
          assert.equal(steers.filter(text => /submit_result became active/.test(text)).length, 1, 'no new lifecycle promise for a tool that is no longer deferred');
          console.log('DEFERRED_THEN_REMOVED_OK');
          process.exit(0);
        }

        // Neither executable nor deferred: an ordinary unavailable-tool attempt.
        const ghost = { toolName: 'ghost_tool', toolCallId: 'ghost', isError: true, content: [{ type: 'text', text: 'Tool ghost_tool not found' }] };
        const ghostResult = await handlers.get('tool_result')(ghost, ctx);
        assert.equal(aborts, 0);
        assert.match(ghostResult.content[0].text, /BLOCKED: ghost_tool is not exposed/);

        // Next request boundary: pi's rebuilt turn context carries the tool.
        handlers.get('turn_start')({ turnIndex: 1 });
        const next = handlers.get('before_provider_request')({ payload: { model: 'm', messages: [], tools: active.map(name => ({ type: 'function', function: { name } })) } }, ctx);
        assert.ok(next.tools.some(tool => tool.function.name === 'submit_result'), 'deferred tool is executable from the next request');

        // An advertised tool that pi cannot execute remains a hard contract failure.
        await handlers.get('tool_result')({ toolName: 'submit_result', toolCallId: 'advertised-missing', isError: true, content: [{ type: 'text', text: 'Tool submit_result not found' }] }, ctx);
        assert.equal(aborts, 1, 'advertised-but-non-executable tool still aborts as infrastructure');
        const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
        assert.equal(failure.failure_code, 'PI_TOOL_CONTRACT_FAILURE');
        assert.equal(failure.tool, 'submit_result');
        console.log('DEFERRED_CAPABILITY_OK');
        process.exit(0);
      }
      tools.get('run_check').execute = async () => ({ content: [{ type: 'text', text: 'check passed' }] });
      let turn = 0;
      async function call(name, input = {}, { expectError = null, usePreparedRequest = false } = {}) {
        handlers.get('turn_start')({ turnIndex: turn });
        // Every helper invocation stands in for a model turn. New tools enter
        // only through a provider boundary. A prepared resultText submission
        // already has a separate serialized request with a verified 4K ceiling;
        // do not overwrite that snapshot with the generic test fixture.
        if (!usePreparedRequest) {
          handlers.get('before_provider_request')({
            payload: { model: 'm', messages: [], tools: active.map(toolName => ({ type: 'function', function: { name: toolName } })) },
          }, ctx);
        }
        const event = { toolName: name, toolCallId: name + turn, input };
        assert.equal(await handlers.get('tool_call')(event, ctx), undefined, name + ' was blocked');
        // Pi completes the provider assistant message before executing its tool calls.
        // The result admission gate checks this completed message and the same toolCallId.
        if (name === 'submit_result' && input?.resultText) {
          await handlers.get('message_end')?.({ message: { role: 'assistant',
            stopReason: 'toolUse', content: [{ type: 'toolCall', id: event.toolCallId, name }] } }, ctx);
        }
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
        if (name === 'begin_result_submission') {
          await handlers.get('message_end')?.({ message: { role: 'assistant',
            stopReason: 'toolUse', content: [{ type: 'toolCall', id: event.toolCallId, name }] } }, ctx);
        }
        await handlers.get('tool_execution_end')({ ...event, isError, result }, ctx);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        return result;
      }

      if (mode !== 'restored') {
        // Born prepared from the bootstrap artifact: no preparation tool call exists.
        assert.equal(tools.has('prepare_implementation'), false);
        if (mode !== 'fallback') {
          const early = await handlers.get('tool_call')({ toolName: 'begin_coding_session', toolCallId: 'early', input: {} }, ctx);
          assert.match(early.reason, /only once evidence is complete/, 'no 16K during exploration');
        }
      }
      // Evidence gathered by the parent earlier in its own session; never repeated in the request.
      fs.writeFileSync(cwd + '/config.py', 'REQUIRED_CONSTANT = "abc123"\\n');
      if (mode === 'fallback') {
        for (let i = 1; i < fallbackEvidenceBudget; i++) {
          fs.writeFileSync(cwd + '/fallback-layout-' + i + '.txt', 'layout evidence ' + i + '\\n');
          await call('read', { path: 'fallback-layout-' + i + '.txt' });
        }
        await call('read', { path: 'config.py' });
      } else {
        if (mode === 'restored') await call('need_more_evidence', { missing: 'constant', reason: 'value' });
        await call('read', { path: 'config.py' });
      }
      fs.rmSync(cwd + '/config.py');
      for (let i = 1; i < fallbackEvidenceBudget; i++) fs.rmSync(cwd + '/fallback-layout-' + i + '.txt', { force: true });

      if (mode === 'evidence-missing-executor') {
        await call('need_more_evidence', {
          missing: 'Exact import anchor required for the next edit.',
          reason: 'One source lookup is required before mutating.',
        });

        handlers.get('turn_start')({ turnIndex: turn });
        const providerPayload = {
          model: 'm',
          messages: [],
          tools: active.map(name => ({ type: 'function', function: { name } })),
        };
        const request = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
        assert.ok(request.tools.some(tool => tool.function.name === 'read'), 'the unlocked evidence request advertises read');

        const failedRead = { toolName: 'read', toolCallId: 'missing-evidence-read', input: { path: 'src/missing.py' } };
        assert.equal(await handlers.get('tool_call')(failedRead, ctx), undefined, 'evidence read is accepted before executor failure');
        await handlers.get('tool_execution_end')({
          ...failedRead,
          isError: true,
          result: { content: [{ type: 'text', text: 'Tool read not found' }] },
        }, ctx);
        assert.equal(aborts, 1, 'advertised missing executor remains an infrastructure abort');

        handlers.get('turn_start')({ turnIndex: turn + 1 });
        const retryPayload = {
          model: 'm',
          messages: [],
          tools: active.map(name => ({ type: 'function', function: { name } })),
        };
        const retryRequest = handlers.get('before_provider_request')({ payload: retryPayload }, ctx);
        assert.ok(retryRequest.tools.some(tool => tool.function.name === 'read'), 'runtime restored the same evidence permit after executor rejection');
        assert.equal(
          await handlers.get('tool_call')({ toolName: 'read', toolCallId: 'retry-evidence-read', input: { path: 'src/missing.py' } }, ctx),
          undefined,
          'restored evidence action is executable without a second need_more_evidence call',
        );
        console.log('EVIDENCE_MISSING_EXECUTOR_PERMIT_RESTORED');
        process.exit(0);
      }

      if (['large-mutation-auto-force', 'large-mutation-prose-abort', 'large-mutation-length-retry-abort', 'large-mutation-provider-retry-abort', 'large-mutation-action-retry-abort', 'large-mutation-coding-argument-recovery', 'large-mutation-coding-argument-retry-abort'].includes(mode)) {
        assert.equal(caps.at(-1), 16384, 'planner largeMutation=true applies the one-shot 16K ceiling after evidence closes');

        const largeProviderRequest = () => {
          const request = handlers.get('before_provider_request')({
            payload: {
              model: 'm',
              messages: [],
              max_completion_tokens: 16384,
              tools: active.map(name => ({ type: 'function', function: { name } })),
            },
          }, ctx);
          const names = request.tools.map(tool => tool.function?.name ?? tool.name);
          assert.equal(request.max_completion_tokens, 16384, 'the direct large payload keeps the full ceiling');
          assert.equal(request.tool_choice, 'required', 'every active 16K request is provider action-forced');
          assert.ok(names.includes('write'), 'direct file creation remains exposed');
          assert.ok(names.includes('accept_mutation_scope'), 'new publishable paths can still be authorized');
          assert.ok(names.includes('submit_result'), 'terminal resolution remains exposed');
          assert.ok(!names.includes('read'), 'ordinary evidence is excluded from the elevated request');
          assert.ok(!names.includes('need_more_evidence'), 'evidence unlock cannot consume the elevated request');
          assert.ok(!names.includes('run_check'), 'verification cannot consume the elevated request');
          assert.ok(!names.includes('repo_search'), 'repository exploration cannot consume the elevated request');
          return request;
        };

        const executeElevated = async (name, input, id) => {
          const event = { toolName: name, toolCallId: id, input };
          const blocked = await handlers.get('tool_call')(event, ctx);
          if (blocked) return { blocked, event };
          let result;
          if (tools.has(name)) {
            result = await tools.get(name).execute(event.toolCallId, input, signal.signal, null, ctx);
          } else if (name === 'write') {
            fs.writeFileSync(cwd + '/' + input.path, input.content);
            result = { content: [{ type: 'text', text: 'ok' }] };
          } else {
            result = { content: [{ type: 'text', text: 'ok' }] };
          }
          await handlers.get('tool_execution_end')({ ...event, isError: false, result }, ctx);
          return { blocked: null, event, result };
        };

        if (mode === 'large-mutation-coding-argument-recovery' || mode === 'large-mutation-coding-argument-retry-abort') {
          assert.equal(codingSessionArgumentValidation({ handoff: 'x'.repeat(1200) }), null, 'exactly 1200 characters remains valid');
          const oversized = codingSessionArgumentValidation({ handoff: 'x'.repeat(1201) });
          assert.deepEqual(oversized.errors, ['handoff: must not have more than 1200 characters']);
          assert.match(oversized.diagnostic, /Validation failed for tool "begin_coding_session":/);
          console.log('CODING_SESSION_ARGUMENT_BOUNDARY_OK');

          const invalidTurn = () => ({
            stopReason: 'stop',
            content: [{
              type: 'toolCall',
              name: 'begin_coding_session',
              arguments: { reason: 'Need the isolated coding child', handoff: 'x'.repeat(1201) },
            }],
            usage: { input: 20, output: 128, totalTokens: 148 },
          });

          handlers.get('turn_start')({ turnIndex: turn });
          const firstRequest = largeProviderRequest();
          assert.ok(firstRequest.tools.some(tool => (tool.function?.name ?? tool.name) === 'begin_coding_session'));
          await handlers.get('turn_end')({ turnIndex: turn++, message: invalidTurn() }, ctx);
          assert.equal(aborts, 0, 'the first invalid launch is recoverable');
          assert.equal(fs.existsSync(runtimeFailure), false, 'recoverable validation does not publish terminal runtime failure metadata');
          assert.equal(caps.at(-1), 16384, 'invalid launch preserves the elevated ceiling');
          assert.match(steers.at(-1), /handoff: must not have more than 1200 characters/);
          assert.match(steers.at(-1), /only new concrete facts or implementation decisions/);

          // Real Pi emits a local synthetic error turn for the schema rejection after the
          // provider response. It is not another provider failure and must not consume the
          // elevated provider-retry allowance.
          handlers.get('turn_start')({ turnIndex: turn });
          await handlers.get('turn_end')({
            turnIndex: turn++,
            message: {
              stopReason: 'error',
              errorMessage: 'Validation failed for tool "begin_coding_session": handoff too long',
              usage: { input: 0, output: 0, totalTokens: 0 },
            },
          }, ctx);
          assert.equal(aborts, 0, 'the local validation error turn does not abort the stage');
          assert.equal(caps.at(-1), 16384, 'the local validation error turn leaves the elevated grant untouched');

          handlers.get('turn_start')({ turnIndex: turn });
          const correctionRequest = handlers.get('before_provider_request')({
            payload: {
              model: 'm',
              messages: [],
              max_completion_tokens: 16384,
              tools: active.map(name => ({ type: 'function', function: { name } })),
            },
          }, ctx);
          assert.equal(correctionRequest.tool_choice, 'required', 'the correction remains action-forced');
          assert.deepEqual(
            correctionRequest.tools.map(tool => tool.function?.name ?? tool.name),
            ['begin_coding_session'],
            'the correction request exposes only the launch action and cannot reopen exploration',
          );
          assert.equal(correctionRequest.max_completion_tokens, 16384, 'the correction keeps the original elevated grant');

          if (mode === 'large-mutation-coding-argument-retry-abort') {
            await handlers.get('turn_end')({ turnIndex: turn++, message: invalidTurn() }, ctx);
            assert.equal(aborts, 1, 'a second invalid launch exhausts the bounded correction');
            const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
            assert.equal(failure.failure_class, 'model_execution_abort');
            assert.equal(failure.failure_code, 'PI_CODING_SESSION_ARGUMENT_RETRY_EXHAUSTED');
            assert.equal(failure.retry_limit, 1);
            assert.equal(failure.attempts, 2);
            assert.equal(failure.checkpoint.worktree_preserved, true);
            console.log('CODING_SESSION_ARGUMENT_RETRY_ABORT_OK');
            process.exit(0);
          }

          const corrected = await executeElevated(
            'begin_coding_session',
            { reason: 'Need the isolated coding child', handoff: 'x'.repeat(1200) },
            'corrected-coding-session',
          );
          assert.equal(corrected.blocked, null);
          await handlers.get('turn_end')({
            turnIndex: turn++,
            message: { stopReason: 'stop', usage: { input: 20, output: 96, totalTokens: 116 } },
          }, ctx);
          assert.equal(aborts, 0, 'the corrected launch completes normally');
          assert.equal(sessionRequests.length, 1, 'the corrected launch starts exactly one coding child');
          assert.equal(sessionRequests[0].maxTokens, '16384', 'the child keeps the normal coding-session ceiling');
          assert.equal(fs.existsSync(runtimeFailure), false, 'no false large-mutation abort is emitted after correction');
          console.log('CODING_SESSION_ARGUMENT_CORRECTION_OK');
          process.exit(0);
        }

        if (mode === 'large-mutation-prose-abort') {
          handlers.get('turn_start')({ turnIndex: turn });
          largeProviderRequest();
          await handlers.get('turn_end')({
            turnIndex: turn++,
            message: { stopReason: 'stop', usage: { input: 20, output: 64, totalTokens: 84 } },
          }, ctx);
          assert.equal(aborts, 1, 'a completed prose-only elevated response fails closed immediately');
          assert.equal(caps.filter(value => value === 16384).length, 1, 'no second elevated turn is granted after completed prose');
          const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
          assert.equal(failure.failure_code, 'PI_LARGE_MUTATION_ACTION_REQUIRED');
          assert.equal(failure.checkpoint.worktree_preserved, true);
          console.log('LARGE_MUTATION_PROSE_ABORT_OK');
          process.exit(0);
        }

        if (mode === 'large-mutation-length-retry-abort') {
          handlers.get('turn_start')({ turnIndex: turn });
          largeProviderRequest();
          await handlers.get('turn_end')({
            turnIndex: turn++,
            message: { stopReason: 'length', usage: { input: 20, output: 16384, totalTokens: 16404 } },
          }, ctx);
          assert.equal(aborts, 0, 'the first elevated ceiling hit gets one bounded truncation retry');
          assert.equal(caps.at(-1), 16384, 'the bounded truncation retry keeps the 16K ceiling');

          handlers.get('turn_start')({ turnIndex: turn });
          const retry = largeProviderRequest();
          assert.equal(retry.tool_choice, 'required', 'the truncation retry remains provider action-forced');
          await handlers.get('turn_end')({
            turnIndex: turn++,
            message: { stopReason: 'length', usage: { input: 20, output: 16384, totalTokens: 16404 } },
          }, ctx);
          assert.equal(aborts, 1, 'a second elevated ceiling hit exhausts the single truncation retry');
          const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
          assert.equal(failure.failure_code, 'PI_LARGE_MUTATION_TRUNCATION_RETRY_EXHAUSTED');
          assert.equal(failure.retry_limit, 1);
          assert.equal(failure.checkpoint.worktree_preserved, true);
          console.log('LARGE_MUTATION_LENGTH_RETRY_ABORT_OK');
          process.exit(0);
        }

        if (mode === 'large-mutation-provider-retry-abort') {
          handlers.get('turn_start')({ turnIndex: turn });
          largeProviderRequest();
          await handlers.get('turn_end')({
            turnIndex: turn++,
            message: {
              stopReason: 'error',
              status: 429,
              errorMessage: '429: rate limited',
              usage: { input: 10, output: 0, totalTokens: 10 },
            },
          }, ctx);
          assert.equal(aborts, 0, 'one retryable provider failure preserves the elevated grant');
          assert.equal(caps.at(-1), 16384, 'provider retry preserves the elevated cap');

          handlers.get('turn_start')({ turnIndex: turn });
          const retry = largeProviderRequest();
          assert.equal(retry.tool_choice, 'required', 'provider retry remains required-tool');
          await handlers.get('turn_end')({
            turnIndex: turn++,
            message: {
              stopReason: 'error',
              status: 503,
              errorMessage: '503: upstream unavailable',
              usage: { input: 10, output: 0, totalTokens: 10 },
            },
          }, ctx);
          assert.equal(aborts, 1, 'a second retryable provider failure exhausts the bounded elevated retry');
          const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
          assert.equal(failure.failure_code, 'PI_LARGE_MUTATION_PROVIDER_RETRY_EXHAUSTED');
          assert.equal(failure.retry_limit, 1);
          assert.equal(failure.checkpoint.worktree_preserved, true);
          console.log('LARGE_MUTATION_PROVIDER_RETRY_ABORT_OK');
          process.exit(0);
        }

        if (mode === 'large-mutation-action-retry-abort') {
          handlers.get('turn_start')({ turnIndex: turn });
          largeProviderRequest();
          const first = await executeElevated(
            'write',
            { path: 'unaccepted-large.py', content: 'VALUE = 1\\n' },
            'large-failed-1',
          );
          assert.equal(first.blocked?.block, true, 'unaccepted large mutation is rejected locally');
          assert.match(first.blocked.reason, /scope|accept_mutation_scope/i);
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 128 } } }, ctx);
          assert.equal(aborts, 0, 'the first failed required action preserves one bounded retry');

          handlers.get('turn_start')({ turnIndex: turn });
          largeProviderRequest();
          const second = await executeElevated(
            'write',
            { path: 'unaccepted-large.py', content: 'VALUE = 2\\n' },
            'large-failed-2',
          );
          assert.equal(second.blocked?.block, true, 'the bounded retry is still subject to scope policy');
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 128 } } }, ctx);
          assert.equal(aborts, 1, 'a second failed elevated action exhausts the bounded retry');
          const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
          assert.equal(failure.failure_code, 'PI_LARGE_MUTATION_ACTION_RETRY_EXHAUSTED');
          assert.equal(failure.checkpoint.worktree_preserved, true);
          console.log('LARGE_MUTATION_ACTION_RETRY_ABORT_OK');
          process.exit(0);
        }

        handlers.get('turn_start')({ turnIndex: turn });
        largeProviderRequest();
        const scope = await executeElevated(
          'accept_mutation_scope',
          {
            paths: ['large_generated.py'],
            disposition: 'publishable',
            rationale: 'The issue requires one large generated module.',
          },
          'large-scope',
        );
        assert.equal(scope.blocked, null);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 64 } } }, ctx);
        assert.equal(caps.at(-1), 16384, 'one successful scope prelude preserves the elevated ceiling');

        handlers.get('turn_start')({ turnIndex: turn });
        largeProviderRequest();
        const largeContent = Array.from({ length: 400 }, (_, index) => 'VALUE_' + index + ' = ' + index + '\\n').join('');
        const write = await executeElevated(
          'write',
          { path: 'large_generated.py', content: largeContent },
          'large-write',
        );
        assert.equal(write.blocked, null);
        await handlers.get('turn_end')({
          turnIndex: turn++,
          message: { usage: { input: 50, output: 16000, totalTokens: 16050 } },
        }, ctx);
        assert.equal(fs.readFileSync(cwd + '/large_generated.py', 'utf8'), largeContent, 'the complete large payload is written in one call');
        assert.equal(fs.readFileSync(cwd + '/large_generated.py', 'utf8').trim().split('\\n').length, 400, 'the initial file is not truncated');
        assert.equal(caps.at(-1), 2048, 'successful mutation consumes the one-shot grant and returns to the normal action cap');

        handlers.get('turn_start')({ turnIndex: turn });
        const normal = handlers.get('before_provider_request')({
          payload: {
            model: 'm',
            messages: [],
            max_completion_tokens: 2048,
            tools: active.map(name => ({ type: 'function', function: { name } })),
          },
        }, ctx);
        assert.equal(normal.tool_choice, 'required', 'post-grant productive 2K turns remain forced');
        console.log('LARGE_MUTATION_AUTO_FORCE_OK');
        process.exit(0);
      }

      if (mode === 'scope-prelude-cap') {
        await call('request_large_mutation_budget', { reason: 'large generated module' });
        assert.equal(caps.at(-1), 16384, 'large mutation grant raises the next response cap');
        await call('accept_mutation_scope', {
          paths: ['first-large.py'],
          disposition: 'publishable',
          rationale: 'Issue requires the large generated implementation file.',
        });
        assert.equal(caps.at(-1), 16384, 'one scope prelude preserves the elevated cap');

        handlers.get('turn_start')({ turnIndex: turn });
        const secondPrelude = await handlers.get('tool_call')({
          toolName: 'accept_mutation_scope',
          toolCallId: 'scope-repeat-' + turn,
          input: {
            paths: ['second-large.py'],
            disposition: 'publishable',
            rationale: 'Attempt a second declaration under the same elevated grant.',
          },
        }, ctx);
        assert.equal(secondPrelude.block, true);
        assert.match(secondPrelude.reason, /already used its one accept_mutation_scope prelude/);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        assert.equal(aborts, 0, 'one blocked repeated scope declaration gets the single bounded action retry');

        handlers.get('turn_start')({ turnIndex: turn });
        const thirdPrelude = await handlers.get('tool_call')({
          toolName: 'accept_mutation_scope',
          toolCallId: 'scope-repeat-final-' + turn,
          input: {
            paths: ['third-large.py'],
            disposition: 'publishable',
            rationale: 'Prove repeated scope-only turns terminate under the bounded retry.',
          },
        }, ctx);
        assert.equal(thirdPrelude.block, true);
        assert.match(thirdPrelude.reason, /already used its one accept_mutation_scope prelude/);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        assert.equal(aborts, 1, 'a second blocked repeated scope declaration exhausts the bounded retry');
        const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
        assert.equal(failure.failure_code, 'PI_LARGE_MUTATION_ACTION_RETRY_EXHAUSTED');
        assert.equal(failure.retry_limit, 1);
        console.log('SCOPE_PRELUDE_CAP_OK');
        process.exit(0);
      }

      if (['prose-force-direct', 'prose-force-provider-statuses', 'action-prose-abort', 'action-repeat-abort', 'action-hidden-abort'].includes(mode)) {
        // First action_required response is prose only: the runtime arms provider-level
        // required-tool forcing and keeps it armed until a real exposed tool is attempted.
        handlers.get('turn_start')({ turnIndex: turn });
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        const exposedBeforeForce = [...active];
        for (const name of ['write', 'begin_coding_session', 'submit_result', 'need_more_evidence']) {
          assert.ok(exposedBeforeForce.includes(name), name + ' remains an available model choice');
        }
        const providerPayload = {
          model: 'm',
          messages: [],
          tools: exposedBeforeForce.map(name => ({ type: 'function', function: { name } })),
        };
        const nonActionPayload = { model: 'm', messages: [] };
        assert.equal(
          handlers.get('before_provider_request')({ payload: nonActionPayload }, ctx),
          nonActionPayload,
          'non-action provider requests without tools are not forced',
        );
        if (mode === 'prose-force-provider-statuses') {
          for (const [status, errorMessage] of [
            [408, '408 status code (no body)'],
            [429, '429 {"error":"rate limit"}'],
          ]) {
            handlers.get('turn_start')({ turnIndex: turn });
            const retry = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
            assert.equal(retry.tool_choice, 'required', 'provider status ' + status + ' keeps tool forcing armed');
            const boundary = await handlers.get('turn_end')({
              turnIndex: turn++,
              message: {
                stopReason: 'error',
                errorMessage,
                usage: { output: 0 },
              },
            }, ctx);
            assert.equal(boundary, undefined, 'provider error turn is ignored by model-progress accounting');
          }

          handlers.get('turn_start')({ turnIndex: turn });
          const rejected = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(rejected.tool_choice, 'required');
          const boundary = await handlers.get('turn_end')({
            turnIndex: turn++,
            message: {
              stopReason: 'error',
              errorMessage: '422: {"error":"tool_choice required is unsupported"}',
              usage: { output: 0 },
            },
          }, ctx);
          assert.equal(boundary, undefined, 'turn_end return value is not the continuation mechanism');

          handlers.get('turn_start')({ turnIndex: turn });
          const fallback = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(fallback.tool_choice, 'auto', '422 gets one compatibility request');
          assert.equal(handlers.get('before_provider_request')({ payload: providerPayload }, ctx).tool_choice, 'required', 'state-based forcing resumes after the single fallback');
          assert.match(steers.at(-1), /provider rejected the provider-level required-tool request/);
          assert.match(steers.at(-1), /CURRENTLY EXPOSED TOOLS/);
          assert.match(steers.at(-1), /submit_result with blocked_reason/);
          process.exit(0);
        }

        const constrained = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
        assert.equal(constrained.tool_choice, 'required');
        assert.deepEqual(constrained.tools, providerPayload.tools, 'tool forcing does not choose or remove an exposed tool');

        if (mode === 'action-repeat-abort') {
          // One genuine completion of a one-shot control transition, in its own turn, so its repeat is a no-op.
          handlers.get('turn_start')({ turnIndex: turn });
          const firstEnable = { toolName: 'subagents_enable', toolCallId: 'first-' + turn, input: {} };
          assert.equal(await handlers.get('tool_call')(firstEnable, ctx), undefined);
          await handlers.get('tool_execution_end')({ ...firstEnable, isError: false, result: { content: [{ type: 'text', text: 'ok' }] } }, ctx);
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
          handlers.get('turn_start')({ turnIndex: turn });
          const repeated = await handlers.get('tool_call')({
            toolName: 'subagents_enable',
            toolCallId: 'repeat-' + turn,
            input: {},
          }, ctx);
          assert.ok(repeated?.alreadySatisfied || /already/i.test(String(repeated?.reason ?? '')), 'repeat is rejected as already completed');
          assert.match(String(repeated.reason), /CURRENTLY EXPOSED TOOLS/);
          const afterRepeat = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(afterRepeat.tool_choice, 'required', 'policy-rejected call does not clear state forcing');
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
          assert.equal(aborts, 0, 'one no-op repeat is a single strike');
          handlers.get('turn_start')({ turnIndex: turn });
          const again = await handlers.get('tool_call')({ toolName: 'subagents_enable', toolCallId: 'repeat-again-' + turn, input: {} }, ctx);
          assert.equal(again.block, true);
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
          assert.equal(aborts, 0, 'an unexposed repeated tool gets one bounded request-local correction');
          assert.match(steers.at(-1), /RUNTIME UNAVAILABLE CAPABILITY CORRECTION/);
          // The next provider request remains without the removed one-shot tool.
          const correction = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.ok(!correction.tools.some(tool => tool.function?.name === 'subagents_enable'));
          handlers.get('turn_start')({ turnIndex: turn });
          const exhausted = await handlers.get('tool_call')({ toolName: 'subagents_enable', toolCallId: 'repeat-exhausted-' + turn, input: {} }, ctx);
          assert.equal(exhausted.block, true);
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
          assert.equal(aborts, 1, 'repeated unavailable one-shot tool exhausts the bounded correction');
          assert.equal(JSON.parse(fs.readFileSync(runtimeFailure, 'utf8')).failure_code, 'PI_UNAVAILABLE_CAPABILITY_ABORT');
          process.exit(0);
        }

        if (mode === 'action-hidden-abort') {
          // #469/#540 lifecycle: one blocker opens one bounded evidence action. After it is
          // consumed, repeated need_more_evidence disappears, while fresh Main direct read remains.
          fs.writeFileSync(cwd + '/evidence.txt', 'exact import anchor\\n');
          await call('need_more_evidence', {
            missing: 'Read evidence.txt to obtain the exact import anchor needed for the edit.',
            reason: 'The exact import anchor is the only unresolved implementation fact.',
          });
          await call('read', { path: 'evidence.txt' });
          fs.rmSync(cwd + '/evidence.txt');

          const consumedSteer = steers.findLast(text => /RUNTIME EVIDENCE PERMIT CONSUMED/.test(text));
          assert.ok(consumedSteer, 'runtime emits an explicit consumed-permit steer');
          assert.ok(consumedSteer.includes('Repeated need_more_evidence is unavailable'));
          assert.ok(consumedSteer.includes('Direct repository tools remain governed by the authoritative current surface'));
          assert.ok(active.includes('read'), 'fresh Main direct read remains available after the bounded evidence action');
          assert.ok(!active.includes('need_more_evidence'), 'blocker is removed until productive progress');

          const staleAttempts = [
            { toolName: 'grep', input: { pattern: 'evidence' }, kind: 'unavailable', expectCorrection: true },
            {
              toolName: 'need_more_evidence',
              input: {
                missing: 'Read evidence.txt for another fact.',
                reason: 'Attempt a second evidence unlock without productive progress.',
              },
              kind: 'stale',
            },
            { toolName: 'grep', input: { pattern: 'evidence' }, kind: 'unavailable', expectCorrection: true, assertForcedCorrection: true },
            { toolName: 'grep', input: { pattern: 'evidence' }, kind: 'unavailable', expectAbort: true },
          ];
          for (let index = 0; index < staleAttempts.length; index += 1) {
            const attempt = staleAttempts[index];
            handlers.get('turn_start')({ turnIndex: turn });
            const hidden = await handlers.get('tool_call')({
              toolName: attempt.toolName,
              input: attempt.input,
              toolCallId: 'hidden-' + attempt.toolName + '-' + turn,
            }, ctx);
            assert.equal(hidden.block, true);
            if (attempt.kind === 'unavailable') {
              assert.match(hidden.reason, /not currently exposed/);
            } else {
              assert.match(hidden.reason, /capability lifecycle changed/);
              assert.match(hidden.reason, /Do not retry the stale call/);
            }
            assert.match(hidden.reason, /CURRENTLY EXPOSED TOOLS/);
            await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
            if (attempt.assertForcedCorrection) {
              const correctionRequest = handlers.get('before_provider_request')({
                payload: { model: 'm', messages: [], tools: active.map(name => ({ type: 'function', function: { name } })) },
              }, ctx);
              assert.equal(correctionRequest.tool_choice, 'required', 'the bounded wrong-tool correction is provider-forced');
            }
            if (attempt.expectCorrection) {
              assert.match(steers.at(-1), /RUNTIME UNAVAILABLE CAPABILITY CORRECTION/);
            }
            assert.equal(
              aborts,
              attempt.expectAbort ? 1 : 0,
              'stale lifecycle races reset the strike streak; only an unavailable attempt beyond the correction limit aborts',
            );
          }

          const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
          assert.equal(failure.failure_class, 'model_execution_abort');
          assert.equal(failure.failure_code, 'PI_UNAVAILABLE_CAPABILITY_ABORT');
          assert.ok(failure.reason.includes('unavailable capability'));
          console.log('UNAVAILABLE_CAPABILITY_FAILURE ' + JSON.stringify(failure));
          process.exit(0);
        }

        if (mode === 'prose-force-direct') {
          // A forced response that still hits the output ceiling without a tool must not consume
          // the requirement. The following provider request remains constrained.
          handlers.get('turn_start')({ turnIndex: turn });
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 2048 } } }, ctx);
          const afterCeiling = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(afterCeiling.tool_choice, 'required', 'ceiling-hit response does not consume tool forcing');

          await call('accept_mutation_scope', {
            paths: ['small.txt'],
            disposition: 'publishable',
            rationale: 'Direct forced-tool test requires one small implementation file.',
          });
          await call('write', { path: 'small.txt', content: 'small change\\n' });
          assert.equal(fs.readFileSync(cwd + '/small.txt', 'utf8'), 'small change\\n');
          const afterTool = handlers.get('before_provider_request')({ payload: providerPayload }, ctx);
          assert.equal(afterTool.tool_choice, 'required', 'successful tool attempts do not disable action-required provider forcing');
          process.exit(0);
        }

        // Deliberately simulate a non-compliant provider/model that returned prose even though
        // tool_choice was required. The existing second-strike watchdog must still terminate.
        handlers.get('turn_start')({ turnIndex: turn });
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        assert.equal(aborts, 1);
        const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
        assert.equal(failure.failure_class, 'model_execution_abort');
        assert.equal(failure.failure_code, 'PI_ACTION_REQUIRED_ABORT');
        assert.match(failure.reason, /second consecutive prose-only/);
        console.log('RUNTIME_FAILURE_RECORD ' + JSON.stringify(failure));
        process.exit(0);
      }

      if (mode === 'ceiling-draft') {
        for (let i = 1; i <= 3; i++) {
          handlers.get('turn_start')({ turnIndex: turn });
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 2048 } } }, ctx);
          if (i < 3) assert.ok(steers.at(-1).includes('call begin_coding_session now'), steers.at(-1));
        }
        assert.equal(aborts, 1, 'third ceiling-hit response without a tool aborts');
        process.exit(0);
      }
      if (mode === 'direct-containment') {
        const blocked = await handlers.get('tool_call')({ toolName: 'write', toolCallId: 'w', input: { path: '.git/config', content: 'x' } }, ctx);
        assert.match(blocked.reason, /cannot target .git/);
        process.exit(0);
      }

      handlers.get('turn_start')({ turnIndex: turn });
      assert.ok(active.includes('begin_coding_session'));

      if (mode.startsWith('terminal-binding-')) {
        // Registered tool.execute, real runStructuredSubagent request/response event path,
        // real receipt checker and module-global production lease. No test delegate().
        const key = 'PI_IMPLEMENTER_SUBAGENT_TERMINAL_SESSION_ID';
        const previous = process.env[key];
        if (mode === 'terminal-binding-overlap') process.env[key] = 'outer-terminal-id';
        else delete process.env[key];
        const expectedPrevious = process.env[key];
        const originalSetTimeout = globalThis.setTimeout;
        let deadlineTimersIntercepted = 0;
        let deadlineCallbackInvoked = false;
        let unrelatedTimerFired = false;
        let unrelatedTimer = null;
        const executions = [];
        const executeCoding = (callId, controller) => {
          const invoke = () => tools.get('begin_coding_session').execute(
            callId, { reason: 'Verify terminal session lifetime' }, controller.signal, null, ctx,
          );
          // Exercise an asynchronous launch boundary in the overlap scenario:
          // neither request observation nor lease assertions may rely on execute()
          // delegating synchronously.
          const running = mode === 'terminal-binding-overlap'
            ? Promise.resolve().then(invoke) : invoke();
          executions.push(running);
          return running;
        };
        function completeWithBoundReceipt(request) {
          assert.ok(request, 'a real delegation request is required for the terminal receipt');
          const recorded = sessionRequests.find(entry => entry.requestId === request.requestId);
          assert.ok(recorded, 'the receipt must match this emitted delegation request');
          writeImplementerResult(resultFile, {
            title: 'Already satisfied', summary: 'No repository change needed',
            outcome: 'already_satisfied', changes: [], files: [],
          });
          const receipt = createSuccessfulTerminalReceipt({ cwd, resultFile, env: process.env });
          assert.equal(receipt.session_id, recorded.spec.sessionId, 'receipt belongs to this specific request');
          assert.equal(receipt.session_id, process.env[key], 'receipt belongs to active lease');
          writeTerminalReceiptFile(terminal, receipt);
          respond(request, { status: 'completed', result: { kind: 'text', value: 'submitted' }, usage: { output: 4 } });
          return receipt;
        }
        try {
          const controller = new AbortController();
          // Only accelerate the known Implementer delegation deadline (90 minutes
          // plus the structured-subagent 5-second grace); keep all other timers intact.
          // The production callback still owns timeout rejection and cleanup.
          if (mode === 'terminal-binding-timeout') {
            const deadlineDelayMs = 5400000 + 5000;
            globalThis.setTimeout = (callback, ms, ...args) => {
              if (ms === deadlineDelayMs && typeof callback === 'function'
                  && String(callback).includes('did not return within')
                  && String(callback).includes('timed_out')) {
                deadlineTimersIntercepted++;
                return originalSetTimeout((...timerArgs) => {
                  deadlineCallbackInvoked = true;
                  callback(...timerArgs);
                }, 5, ...args);
              }
              return originalSetTimeout(callback, ms, ...args);
            };
            unrelatedTimer = setTimeout(() => {
              unrelatedTimerFired = true;
            }, deadlineDelayMs + 1000);
          }
          const first = executeCoding('first', controller);
          if (mode === 'terminal-binding-overlap') {
            assert.equal(heldTerminalRequests.length, 0, 'launch intentionally crosses a microtask boundary');
          }
          await terminalRequestBarriers[0].promise;
          assert.equal(heldTerminalRequests.length, 1, 'first registered execute launched one delegation');
          const bound = sessionRequests[0].spec.sessionId;
          assert.equal(process.env[key], bound, 'active ID bound before delegation');
          if (mode === 'terminal-binding-overlap') {
            await assert.rejects(
              executeCoding('overlap', new AbortController()),
              error => error.code === 'PI_IMPLEMENTER_TERMINAL_SESSION_OVERLAP',
            );
            assert.equal(heldTerminalRequests.length, 1, 'overlap cannot launch a fork');
            assert.equal(process.env[key], bound, 'overlap did not clobber active binding');
            // Rejected overlap must not consume maxSessions or write a receipt.
            writeImplementerResult(resultFile, {
              title: 'Already satisfied', summary: 'No repository change needed',
              outcome: 'already_satisfied', changes: [], files: [],
            });
            const good = createSuccessfulTerminalReceipt({ cwd, resultFile, env: process.env });
            writeTerminalReceiptFile(terminal, { ...good, session_id: 'foreign-session' });
            assert.throws(
              () => assertSuccessfulTerminalReceipt({
                cwd, resultFile, env: process.env, expectedSessionId: bound,
              }),
              /terminal_receipt_foreign_session/,
              'current session rejects a receipt for a different fork',
            );
            completeWithBoundReceipt(heldTerminalRequests[0]);
            const finished = await first;
            assert.equal(finished.terminate, true, 'valid receipt ends the real runtime path');
            assert.equal(finished.details.successful_final_submission, true);
          } else if (mode === 'terminal-binding-abort') {
            controller.abort('cancellation test');
            await assert.rejects(first, /delegation was aborted/, 'real AbortSignal rejects pending delegation');
          } else {
            await assert.rejects(first, /did not return within/, 'real delegation deadline rejects pending call');
            assert.equal(deadlineTimersIntercepted, 1, 'only the expected delegation deadline is accelerated');
            assert.equal(deadlineCallbackInvoked, true, 'production deadline callback actually ran');
            assert.equal(unrelatedTimerFired, false, 'unrelated long timer was not accelerated');
          }
          assert.equal(process.env[key], expectedPrevious, 'completed/failed path restores exact prior binding');
          assert.equal(Object.hasOwn(process.env, key), mode === 'terminal-binding-overlap');
          globalThis.setTimeout = originalSetTimeout;
          const second = executeCoding('independent', new AbortController());
          await terminalRequestBarriers[1].promise;
          assert.equal(heldTerminalRequests.length, 2, 'a later independent fork is permitted');
          assert.equal(process.env[key], sessionRequests[1].spec.sessionId);
          assert.notEqual(sessionRequests[1].spec.sessionId, bound);
          completeWithBoundReceipt(heldTerminalRequests[1]);
          const again = await second;
          assert.equal(again.terminate, true, 'later fork validates its own receipt');
          assert.equal(process.env[key], expectedPrevious, 'second lease restores initial binding');
          await assert.rejects(executeCoding('over-limit', new AbortController()), error => error.code === 'max_sessions');
          assert.equal(heldTerminalRequests.length, 2, 'rejected overlap did not use a session slot');
          console.log('TERMINAL_BINDING_' + mode.toUpperCase().replaceAll('-', '_') + '_OK');
        } finally {
          globalThis.setTimeout = originalSetTimeout;
          if (unrelatedTimer) clearTimeout(unrelatedTimer);
          // Teardown unblocks all pending requests even when an assertion fails.
          for (const request of heldTerminalRequests) {
            respond(request, { status: 'completed', result: { kind: 'text', value: 'teardown' }, usage: { output: 1 } });
          }
          await Promise.allSettled(executions);
          if (previous === undefined) delete process.env[key];
          else process.env[key] = previous;
        }
        process.exit(0);
      }
      if (mode === 'forbidden-capability') {
        await assert.rejects(
          () => tools.get('begin_coding_session').execute('forbidden-capability', {
            reason: 'Need shell cleanup',
            required_capability: 'bash',
          }, signal.signal, null, ctx),
          /cannot expose required capability "bash"/,
        );
        assert.equal(sessionRequests.length, 0, 'incapable fork is rejected before launch');
        process.exit(0);
      }
      if (mode === 'handoff-missing' || mode === 'handoff-malformed') {
        if (mode === 'handoff-missing') {
          delete process.env.PI_ISSUE_CONTEXT;
        } else {
          fs.writeFileSync(process.env.PI_ISSUE_CONTEXT, '{broken json');
        }
        await assert.rejects(
          () => tools.get('begin_coding_session').execute('handoff-unavailable', {
            reason: 'Implement generated.py and its test',
          }, signal.signal, null, ctx),
          error => {
            assert.equal(error.code, 'handoff_unavailable');
            assert.match(error.message, /Implement with direct edits/);
            return true;
          },
        );
        assert.equal(sessionRequests.length, 0, 'handoff failure rejects before launching the coding child');
        console.log('HANDOFF_UNAVAILABLE_OK');
        process.exit(0);
      }
      if (mode === 'incapable-repeat' || mode === 'incapable-transition') {
        const first = await call('begin_coding_session', { reason: 'Clean up the stray file' });
        assert.match(first.content[0].text, /ended without submit_result/);
        assert.equal(fs.existsSync(sessionRequests[0].spec.capabilityFile), false, 'capability sidecar is consumed');
        // An arbitrary worktree change is not a material transition: bash is still unreachable.
        fs.writeFileSync(cwd + '/stray.txt', 'accidental\\n');
        if (mode === 'incapable-transition') {
          // A successful trusted recovery transition resolves the cleanup the fork needed bash for.
          active = [...active, 'recover_worktree'];
          process.env.PI_VALIDATION_LEDGER_FILE = sessionFile + '.ledger.jsonl';
          // Run-start baseline (#438): stray.txt appeared after it, so ownership is provable.
          process.env.PI_WORKTREE_BASELINE_FILE = sessionFile + '.baseline.json';
          fs.writeFileSync(process.env.PI_WORKTREE_BASELINE_FILE, JSON.stringify({ schema_version: 2, untracked: [], tracked_dirty: [] }));
          await call('recover_worktree', { action: 'delete_untracked', path: 'stray.txt', expected_files: [], reason: 'Remove the accidental file without a shell' });
          assert.equal(fs.existsSync(cwd + '/stray.txt'), false);
          await tools.get('begin_coding_session').execute('after-transition', { reason: 'Retry after recovery' }, signal.signal, null, ctx);
          assert.equal(sessionRequests.length, 2, 'fork launches again after a trusted recovery transition');
          console.log('INCAPABLE_FORK_TRANSITION_OK');
          process.exit(0);
        }
        await assert.rejects(
          () => tools.get('begin_coding_session').execute('repeat', { reason: 'Try the cleanup again' }, signal.signal, null, ctx),
          /attempting bash, which the coding session can never expose.*An equivalent session was not launched/s,
        );
        assert.equal(sessionRequests.length, 1, 'equivalent incapable fork is rejected before launch, even after an unrelated file write');
        assert.ok(!registered.get('implementer-coding-session').tools.includes('bash'), 'no unrestricted shell is added to the fork');
        console.log('INCAPABLE_FORK_REPEAT_REJECTED_OK');
        process.exit(0);
      }
      const expectError = { cancel: /aborted/, 'shadow-agent': /collides with configured agent/, 'tool-contract': /PI_TOOL_CONTRACT_FAILURE/, 'malformed-contract': /original delegation failure/ }[mode] ?? null;
      const result = await call('begin_coding_session', {
        reason: 'Implement generated.py and its test',
        handoff: mode === 'handoff-truncation'
          ? 'Current evidence established REQUIRED_CONSTANT = "abc123". ' + 'a'.repeat(1140) + '🚀tail'
          : mode === 'handoff-trailing-space-truncation'
            ? 'Current evidence established REQUIRED_CONSTANT = "abc123". ' + 'a'.repeat(1140) + ' tail'
            : '  Current evidence established REQUIRED_CONSTANT = "abc123". café 🚀  ',
      }, { expectError });
      if (mode === 'malformed-contract') {
        assert.equal(aborts, 0);
        assert.equal(sessionRequests.length, 1);
        assert.equal(fs.existsSync(sessionRequests[0].spec.failureFile), false);
        assert.equal(fs.existsSync(runtimeFailure), false);
        process.exit(0);
      }
      if (mode === 'tool-contract') {
        assert.equal(aborts, 1, 'nested contract failure aborts the parent immediately');
        const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
        assert.equal(failure.failure_class, 'infrastructure');
        assert.equal(failure.failure_code, 'PI_TOOL_CONTRACT_FAILURE');
        assert.equal(failure.tool, 'write');
        assert.equal(sessionRequests.length, 1, 'no additional coding session burned on an unavailable executor');
        assert.equal(fs.existsSync(terminal), false, 'a contract failure never submits');
        process.exit(0);
      }
      assert.equal(process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS, '2048', 'parent child-budget mirror restored');
      assert.ok(!process.env.PI_CODING_SESSION, 'coding-session mode is scoped to the fork');
      if (sessionRequests.length) {
        assert.equal(process.env.PI_CODING_SESSION_USED, 'true', 'parent retains the durable coding-lifecycle validation marker');
      }
      if (mode === 'blocked') {
        assert.equal(result.terminate, true, 'a valid blocked terminal receipt ends the parent coding action');
        assert.equal(result.details.outcome, 'blocked');
        assert.equal(result.details.successful_final_submission, false);
        assert.match(result.content[0].text, /blocked outcome/);
        assert.match(result.content[0].text, /implementation was not completed/);
        assert.doesNotMatch(result.content[0].text, /work is done/i);
        assert.match(fs.readFileSync(resultFile, 'utf8'), /"outcome": "blocked"/);
        process.exit(0);
      }
      assert.ok(caps.filter(cap => cap !== 32000).every(cap => cap === 2048), 'parent stays at 2048: ' + caps);
      assert.equal(sessionRequests.length, 1);
      assert.equal(sessionRequests[0].maxTokens, '16384');
      assert.equal(sessionRequests[0].spec.maxTokens, 16384);
      assert.match(sessionRequests[0].task, /abc123/, 'new execution evidence is carried by the compact handoff');
      if (['flow', 'fallback', 'restored', 'tampered', 'containment', 'no-session', 'no-submit', 'no-submit-parent-submit'].includes(mode)) {
        assert.ok(childCaps.length > 0 && childCaps.every(cap => cap === 16384), 'every coding-session response is 16384: ' + childCaps);
        assert.match(fs.readFileSync(cwd + '/generated.py', 'utf8'), /REQUIRED_CONSTANT = "abc123"/, 'the coding child used the compact handoff without parent transcript inheritance');
        assert.equal(fs.readFileSync(cwd + '/generated.py', 'utf8').split('\\n')[1], 'HELP = "q: quit\\\\nr: restart"');
        assert.ok(fs.existsSync(cwd + '/test_generated.py'), 'the session wrote tests too');
      }
      if (['flow', 'fallback', 'restored', 'tampered', 'containment'].includes(mode)) {
        assert.equal(result.terminate, true, 'parent ends after the fork submitted');
        assert.ok(fs.existsSync(terminal));
        // Smoke #285: the parent's own submit flag is false (the fork submitted), so the nudge
        // must honor the run-wide terminal marker instead of restarting the parent.
        assert.equal(handlers.get('agent_before_settle')(), undefined, 'no submit nudge after the fork submitted');
      }
      if (['no-submit-recovery', 'no-submit-recovery-partial'].includes(mode)) {
        const partialRecovery = mode === 'no-submit-recovery-partial';
        assert.notEqual(result.terminate, true);
        assert.deepEqual(result.details.recovery_receipt, {
          coding_session_status: 'aborted',
          changed_publishable_paths: ['generated.py', 'test_generated.py'],
          prepared_outputs_present: partialRecovery ? { source: false, test: false } : { source: true, test: true },
          last_validation: partialRecovery
            ? { kind: 'pytest', status: 'fail', infrastructure_code: null }
            : { kind: 'pytest', status: 'infra_error', infrastructure_code: 'CHECK_ENV' },
          remaining_terminal_obligation: partialRecovery ? 'prepared_outputs' : 'validation',
        });
        assert.match(result.content[0].text, /Trusted recovery receipt/);
        assert.match(result.content[0].text, /do not discard or blindly regenerate preserved child changes/);
        assert.doesNotMatch(result.content[0].text, /You may call begin_coding_session once more/);
        assert.ok(active.includes('read'), 'parent exposes one direct bounded recovery read');
        assert.ok(!active.includes('need_more_evidence'), 'generic evidence unlock stays closed during coding recovery');
        assert.ok(!active.includes('begin_coding_session'), 'parent cannot blindly launch a second fork while child work is protected');
        assert.ok(!active.includes('write'), 'parent cannot mutate before inspecting preserved child work');
        assert.ok(!active.includes('bash'), 'raw shell never becomes a recovery capability');
        assert.ok(!active.includes('repo_search'), 'broad discovery stays closed during recovery');
        assert.ok(!active.includes('indexed_repo_search'), 'indexed discovery stays closed during recovery');
        if (partialRecovery) {
          assert.ok(active.includes('retry_last_failed_check'), 'authoritative failed validation exposes its exact retry');
          const accepted = JSON.parse(fs.readFileSync(scopeFile, 'utf8')).accepted.map(entry => entry.path).sort();
          assert.deepEqual(accepted, ['generated.py', 'test_generated.py'], 'accepted mutation scope survives the child abort');
        }
        assert.equal(sessionRequests.length, 1, 'recovery does not blindly launch another coding session');

        const recoveryRequest = handlers.get('before_provider_request')({
          payload: { model: 'm', messages: [], tools: active.map(name => ({ type: 'function', function: { name } })) },
        }, ctx);
        assert.equal(recoveryRequest.tool_choice, 'required', 'guarded action-required recovery stays provider-forced');
        assert.ok(recoveryRequest.tools.some(tool => tool.function.name === 'read'));
        assert.ok(!recoveryRequest.tools.some(tool => ['bash', 'repo_search', 'begin_coding_session'].includes(tool.function.name)));

        handlers.get('turn_start')({ turnIndex: turn });
        const unavailableRecoveryTool = partialRecovery ? 'bash' : 'begin_coding_session';
        const unavailableRecoveryAttempt = await handlers.get('tool_call')({
          toolName: unavailableRecoveryTool,
          toolCallId: 'unavailable-recovery-tool-' + turn,
          input: {},
        }, ctx);
        assert.equal(unavailableRecoveryAttempt.block, true);
        assert.match(unavailableRecoveryAttempt.reason, /not currently exposed|capability lifecycle changed/);
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        assert.equal(aborts, 0, 'first unavailable recovery tool gets a bounded correction instead of a prose abort');
        assert.match(steers.at(-1), /RUNTIME UNAVAILABLE CAPABILITY CORRECTION/);
        assert.match(steers.at(-1), new RegExp(unavailableRecoveryTool));

        const correctedRequest = handlers.get('before_provider_request')({
          payload: { model: 'm', messages: [], tools: active.map(name => ({ type: 'function', function: { name } })) },
        }, ctx);
        assert.equal(correctedRequest.tool_choice, 'required', 'wrong-tool correction keeps provider action forcing');

        handlers.get('turn_start')({ turnIndex: turn });
        const unrelatedRead = await handlers.get('tool_call')({
          toolName: 'read',
          toolCallId: 'unrelated-recovery-read-' + turn,
          input: { path: 'README.md' },
        }, ctx);
        assert.equal(unrelatedRead.block, true);
        assert.match(unrelatedRead.reason, /recovery read is limited to preserved changed publishable paths/);
        console.log('CODING_RECOVERY_WRONG_PATH_BLOCKED_OK');
        await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
        assert.equal(aborts, 0, 'wrong-path read is rejected without consuming the preserved recovery state');

        const recovered = await call('read', { path: 'generated.py' });
        assert.match(recovered.content[0].text, /REQUIRED_CONSTANT/);
        assert.ok(active.includes('safe_edit') || active.includes('edit'), 'bounded inspection opens local accepted-scope repair');
        assert.ok(!active.includes('begin_coding_session'), 'inspection does not reopen a second coding fork');
        assert.ok(!active.includes('bash'), 'inspection does not reopen raw shell');
        assert.ok(!active.includes('need_more_evidence'), 'inspection does not reopen broad evidence');
        if (partialRecovery) {
          assert.ok(active.includes('retry_last_failed_check'), 'exact failed-check retry remains available after inspection');
          assert.ok(active.includes('write'), 'inspection reopens ordinary mutation tools under accepted-scope enforcement');
          const mutationRequest = handlers.get('before_provider_request')({
            payload: { model: 'm', messages: [], tools: active.map(name => ({ type: 'function', function: { name } })) },
          }, ctx);
          assert.ok(mutationRequest.tools.some(tool => tool.function?.name === 'write'), 'inspected recovery publishes mutation tools on a new request');
          handlers.get('turn_start')({ turnIndex: turn });
          const outsideWrite = await handlers.get('tool_call')({
            toolName: 'write',
            toolCallId: 'outside-scope-recovery-write-' + turn,
            input: { path: 'outside_recovery.py', content: 'SHOULD_NOT_EXIST = true\\n' },
          }, ctx);
          assert.equal(outsideWrite.block, true, 'recovery cannot mutate a path outside the accepted scope');
          assert.match(outsideWrite.reason, /mutation_scope_required/);
          assert.equal(fs.existsSync(cwd + '/outside_recovery.py'), false);
          await handlers.get('turn_end')({ turnIndex: turn++, message: { usage: { output: 100 } } }, ctx);
          assert.equal(aborts, 0, 'scope rejection does not destroy the guarded recovery state');
          console.log('CODING_RECOVERY_OUTSIDE_SCOPE_BLOCKED_OK');

          const localRepair = await call('safe_edit', {
            path: 'generated.py',
            operation: 'insert_after',
            start_line: 1,
            text: '# parent recovery repair\\n',
          });
          assert.equal(localRepair.block, undefined, 'parent can mutate an accepted preserved path after bounded inspection');
          assert.equal(aborts, 0, 'local parent repair remains recoverable');
          assert.ok(active.includes('retry_last_failed_check'), 'successful local repair preserves the exact failed-check retry path');

          const validationRequest = handlers.get('before_provider_request')({
            payload: { model: 'm', messages: [], tools: active.map(name => ({ type: 'function', function: { name } })) },
          }, ctx);
          assert.ok(validationRequest.tools.some(tool => tool.function?.name === 'retry_last_failed_check'), 'exact retry is serialized after the new mutation');
          handlers.get('turn_start')({ turnIndex: turn });
          const retryCall = await handlers.get('tool_call')({
            toolName: 'retry_last_failed_check',
            toolCallId: 'parent-recovery-retry-' + turn,
            input: {},
          }, ctx);
          assert.equal(retryCall, undefined, 'parent accepts the exact failed-check retry after local recovery repair');
          console.log('CODING_RECOVERY_RETRY_ACCEPTED_OK');
        }
        console.log('CODING_RECOVERY_RECEIPT_OK ' + JSON.stringify(result.details.recovery_receipt));
        console.log(partialRecovery ? 'CODING_RECOVERY_PARTIAL_OK' : 'CODING_RECOVERY_BOUNDED_INSPECTION_OK');
      }
      if (mode === 'no-submit-recovery-dead-end') {
        assert.notEqual(result.terminate, true);
        assert.deepEqual(result.details.recovery_receipt, {
          coding_session_status: 'aborted',
          changed_publishable_paths: ['generated.py', 'test_generated.py'],
          prepared_outputs_present: { source: true, test: true },
          last_validation: { kind: 'pytest', status: 'infra_error', infrastructure_code: 'CHECK_ENV' },
          remaining_terminal_obligation: 'validation',
        });
        assert.ok(active.includes('read'), 'guard initially exposes the bounded read while preserved paths still exist');
        assert.ok(!active.includes('run_check'), 'the dead-end fixture removes parent validation capability');
        fs.rmSync(cwd + '/generated.py');
        fs.rmSync(cwd + '/test_generated.py');

        handlers.get('turn_start')({ turnIndex: turn });
        const staleRead = await handlers.get('tool_call')({
          toolName: 'read',
          toolCallId: 'dead-end-recovery-read-' + turn,
          input: { path: 'generated.py' },
        }, ctx);
        assert.equal(staleRead.block, true);
        assert.match(staleRead.reason, /no readable preserved changed path/);
        assert.equal(aborts, 1, 'unreadable preserved paths plus no validation route fail closed immediately');
        const failure = JSON.parse(fs.readFileSync(runtimeFailure, 'utf8'));
        assert.equal(failure.failure_code, 'PI_CODING_RECOVERY_BLOCKED');
        assert.equal(failure.checkpoint.worktree_preserved, true);
        assert.deepEqual(failure.recovery_receipt.changed_publishable_paths, ['generated.py', 'test_generated.py']);
        console.log('CODING_RECOVERY_FAIL_CLOSED_OK ' + JSON.stringify(failure));
      }
      if (mode === 'no-submit-parent-submit') {
        assert.notEqual(result.terminate, true);
        assert.match(result.content[0].text, /ended without submit_result/);
        // Production launches pi-run-stage from the issue worktree. This scenario
        // normally stays in the control checkout so it can exercise trusted
        // runtime modules, but the real parent submit_result uses process.cwd()
        // for integrateLatestDev()/git publication checks. Match production here.
        process.chdir(cwd);
        assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(cwd));
        // #631: the trusted submit_result protocol now requires one explicit
        // submission prelude and an accepted resultText tool call after Pi's
        // final assistant toolUse message, on a verified-budget request.
        await call('begin_result_submission', {});
        const resultOnly = handlers.get('before_provider_request')({ payload: {
          model: 'm', messages: [], max_completion_tokens: 4096,
          tools: [{ type: 'function', function: { name: 'submit_result' } }],
        } }, ctx);
        assert.deepEqual(resultOnly.tools.map(tool => tool.function.name), ['submit_result']);
        await call('submit_result', { resultText: 'Publish coding-session changes from the parent.' },
          { usePreparedRequest: true });
        const metadata = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        assert.equal(metadata.scope_enforcement, 'predeclared');
        assert.deepEqual(metadata.accepted_scope.accepted.map(entry => entry.path), ['generated.py', 'test_generated.py']);
        console.log('PARENT_SUBMIT_AFTER_FORK_OK');
      }
      if (mode === 'no-submit') {
        assert.notEqual(result.terminate, true);
        assert.equal(handlers.get('agent_before_settle')()?.continue, true, 'without a submission the nudge still fires');
        assert.match(result.content[0].text, /ended without submit_result/);
        await call('begin_coding_session', { handoff: 'Current evidence established REQUIRED_CONSTANT = "abc123".' });
        // The per-run limit (2) is enforced when the third session is requested.
        await call('begin_coding_session', { handoff: 'Current evidence established REQUIRED_CONSTANT = "abc123".' }, { expectError: /coding session limit .2. for this run is reached/ });
      }
      if (mode === 'tampered' || mode === 'shadow-agent') {
        assert.equal(fs.existsSync(cwd + '/TAMPERED_RUNTIME_LOADED'), false, 'the issue-worktree runtime copy is never loaded');
        for (const definition of registrations) {
          assert.equal(definition.thinking, 'off');
          assert.ok(definition.extensions.every(p => p.startsWith(controlScripts + '/') && !p.startsWith(cwd)), 'absolute control-checkout paths only');
          assert.ok(!definition.tools.includes('subagent'));
        }
      }
    `);
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, scenario], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_ISSUE_CONTEXT: context, PI_TERMINAL_RESULT_FILE: terminal,
        PI_IMPLEMENTER_RESULT_FILE: resultFile, PI_ACCEPTED_MUTATION_SCOPE_FILE: scopeFile,
        PI_RESUME_ACTIVE: mode === 'restored' ? 'true' : 'false', PI_VALIDATION_REPAIR: 'false',
        PI_PREPARED_IMPLEMENTATION_FILE: preparedFile,
        PI_VALIDATION_LEDGER_FILE: validationLedger, PI_VALIDATION_RUN_ID: 'issue-481-run',
        PI_SUBAGENT_RESPONSE_MAX_TOKENS: '2048', PI_CODING_SESSION: '', PI_RUNTIME_FAILURE_FILE: runtimeFailure,
        PI_METRICS_FILE: path.join(dir, 'metrics.jsonl'), PI_ISSUE: '7', PI_PHASE: 'implementation' },
    });
    const metricsFile = path.join(dir, 'metrics.jsonl');
    lastMetrics = fs.existsSync(metricsFile)
      ? fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout + result.stderr;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


test('#652 registered coding execute rejects overlap before env/session mutation, validates session-bound receipts and allows next call', () => {
  assert.match(runtimeScenario('terminal-binding-overlap'), /TERMINAL_BINDING_TERMINAL_BINDING_OVERLAP_OK/);
});

test('#652 real AbortSignal cancellation releases coding terminal binding', () => {
  assert.match(runtimeScenario('terminal-binding-abort'), /TERMINAL_BINDING_TERMINAL_BINDING_ABORT_OK/);
});

test('#652 real delegation timer expiry releases coding terminal binding', () => {
  assert.match(runtimeScenario('terminal-binding-timeout'), /TERMINAL_BINDING_TERMINAL_BINDING_TIMEOUT_OK/);
});

test('2K parent -> begin_coding_session -> isolated 16K coding child writes code + tests, checks, submits; parent ends', () => {
  const logs = runtimeScenario('flow');
  assert.match(logs, /PI_CODING_SESSION \{"phase":"agent_registered".*"source":"runtime","thinking":"off"/);
  assert.match(logs, /\[PI\]\[coding\] phase=agent_registered/);
  assert.match(logs, /"phase":"requested".*"parentMaxTokens":2048,"codingMaxTokens":16384/);
  assert.match(logs, /"phase":"started".*"context":"fresh","agent":"implementer-coding-session"/);
  assert.match(logs, /"phase":"started"[^\n]*"handoffBytes":\d+,"parentHandoffBytes":69/);
  assert.doesNotMatch(logs, /Current evidence established REQUIRED_CONSTANT/);
  assert.match(logs, /"phase":"completed".*"submitted":true/);
  assert.match(logs, /PI_CODING_SESSION \{"phase":"thinking_policy","side":"fork".*"policy":"normal_low_overhead".*"enableThinking":false,"maxTokens":16384/);
  assert.match(logs, /PI_CODING_SESSION \{"phase":"first_tool_call","side":"fork".*"tool":"accept_mutation_scope"/);
  assert.match(logs, /PI_CODING_SESSION \{"phase":"first_response","side":"fork".*"attemptedTool":true/);
  assert.equal(logs.match(/PI_MUTATION \{"stage":"implementer","tool":"write","mode":"coding_session"[^\n]*"shape":"creation"[^\n]*"changed":true/g)?.length, 2, 'initial large creation stays direct and is classified separately from repair rewrites');
  assert.match(logs, /PI_RUN_CHECK|check passed|"phase":"completed"/);
  assert.doesNotMatch(logs, /PI_LARGE_MUTATION_BUDGET|mutation-writer|PI_MUTATION_TURN/);
});

test('parent handoff truncation is code-point safe, bounded and re-trimmed', () => {
  const unicodeLogs = runtimeScenario('handoff-truncation');
  assert.match(unicodeLogs, /"phase":"started"[^\n]*"parentHandoffBytes":1203/);
  assert.doesNotMatch(unicodeLogs, /🚀tail|Current evidence established REQUIRED_CONSTANT/);

  const trailingSpaceLogs = runtimeScenario('handoff-trailing-space-truncation');
  assert.match(trailingSpaceLogs, /"phase":"started"[^\n]*"parentHandoffBytes":1199/);
  assert.doesNotMatch(trailingSpaceLogs, / tail|Current evidence established REQUIRED_CONSTANT/);
});

test('a valid blocked child terminal result propagates as blocked, never implementation success', () => {
  const logs = runtimeScenario('blocked');
  assert.match(logs, /"phase":"blocked"/);
  assert.match(logs, /PI_CODING_SESSION .*"outcome":"blocked"/);
  assert.doesNotMatch(logs, /Coding session completed the implementation/);
});

test('coding session works after PREPARATION_FALLBACK and on a resumed implementer', () => {
  assert.match(runtimeScenario('fallback'), /"phase":"requested".*"preparationState":"PREPARATION_FALLBACK"/);
  assert.match(runtimeScenario('restored'), /"phase":"completed".*"submitted":true/);
});

test('trusted runtime protections hold inside the coding session and in the 2K phase', () => {
  assert.match(runtimeScenario('containment'), /PI_MUTATION_BLOCKED .*"reason":"invalid_path"/);
  assert.match(runtimeScenario('direct-containment'), /PI_MUTATION_BLOCKED .*"tool":"write".*"reason":"invalid_path"/);
});

test('a session that ends without submit returns control at 2K, with a bounded number of sessions', () => {
  const logs = runtimeScenario('no-submit');
  assert.match(logs, /"phase":"ended_without_submit".*"submitted":false/);
  assert.match(logs, /"phase":"rejected".*"reason":"max_sessions"/);
});

test('#481/#526 an aborted coding session returns authoritative state and bounded parent inspection', () => {
  const logs = runtimeScenario('no-submit-recovery');
  assert.match(logs, /"phase":"ended_without_submit".*"recoveryReceipt":\{/);
  assert.match(logs, /"infrastructure_code":"CHECK_ENV"/);
  assert.match(logs, /PI_CODING_RECOVERY_HANDOFF/);
  assert.match(logs, /PI_CODING_RECOVERY_GUARD /);
  assert.match(logs, /PI_CODING_RECOVERY_GUARD_ADVANCED .*"reason":"bounded_recovery_evidence".*"inspectionComplete":true/);
  assert.doesNotMatch(logs, /PI_CODING_RECOVERY_GUARD_RELEASED .*"reason":"bounded_recovery_evidence"/);
  assert.match(logs, /PI_UNAVAILABLE_CAPABILITY_CORRECTION .*"attemptedTool":"begin_coding_session".*"correction":1/);
  assert.doesNotMatch(logs, /PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn/);
  assert.match(logs, /CODING_RECOVERY_RECEIPT_OK/);
  assert.match(logs, /CODING_RECOVERY_BOUNDED_INSPECTION_OK/);
});

test('#526 partial child progress with failed validation survives abort and stays locally recoverable', () => {
  const logs = runtimeScenario('no-submit-recovery-partial');
  assert.match(logs, /PI_CODING_RECOVERY_GUARD .*"preparedOutputsPresent":\{"source":false,"test":false\}.*"status":"fail"/);
  assert.match(logs, /PI_TOOL_SURFACE_UPDATE .*"reason":"coding_recovery_evidence".*"read".*"retry_last_failed_check"/);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE .*"mode":"required"/);
  assert.match(logs, /PI_UNAVAILABLE_CAPABILITY_CORRECTION .*"attemptedTool":"bash"/);
  assert.match(logs, /PI_CODING_RECOVERY_GUARD_ADVANCED .*"reason":"bounded_recovery_evidence"/);
  assert.match(logs, /CODING_RECOVERY_OUTSIDE_SCOPE_BLOCKED_OK/);
  assert.match(logs, /CODING_RECOVERY_RETRY_ACCEPTED_OK/);
  assert.match(logs, /CODING_RECOVERY_PARTIAL_OK/);
  assert.doesNotMatch(logs, /PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn/);
});

test('#526 guarded recovery fails closed when preserved paths disappear and validation is unavailable', () => {
  const logs = runtimeScenario('no-submit-recovery-dead-end');
  assert.match(logs, /PI_CODING_RECOVERY_BLOCKED/);
  assert.match(logs, /CODING_RECOVERY_FAIL_CLOSED_OK/);
  assert.match(logs, /"failure_code":"PI_CODING_RECOVERY_BLOCKED"/);
  assert.match(logs, /"worktree_preserved":true/);
});

test('#499/#506 repair reads precede bounded reasoning and broad edits cannot bypass localization', () => {
  const logs = runtimeScenario('repair-evidence');
  assert.match(logs, /PI_TOOL_SURFACE_UPDATE .*"reason":"repair_evidence".*"read"/);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"rewriteEligiblePaths":\[\]/);
  assert.match(logs, /PI_CODING_REPAIR_TOOL_SURFACE .*"phase":"evidence".*"tools":\["read"\]/);
  assert.match(logs, /PI_CODING_SESSION .*"phase":"thinking_policy".*"policy":"repair_evidence_low_overhead".*"enableThinking":false/);
  assert.match(logs, /PI_CODING_REPAIR_READ .*"path":"test_generated.py".*"evidenceBudgetIndependent":true/);
  assert.doesNotMatch(logs, /PI_CODING_REPAIR_READ .*"path":"link-source.py"/);
  assert.match(logs, /PI_CODING_REPAIR_TOOL_SURFACE .*"phase":"reasoning_mutation"/);
  assert.match(logs, /PI_CODING_SESSION .*"phase":"thinking_policy".*"policy":"repair_reasoning_once".*"enableThinking":true.*"maxTokens":4096/);
  assert.match(logs, /PI_CODING_REPAIR_MUTATION_GUARD .*"status":"blocked".*"shape":"whole_file_rewrite"/);
  assert.match(logs, /PI_CODING_REPAIR_MUTATION_GUARD .*"status":"blocked".*"shape":"broad_edit"/);
  assert.match(logs, /PI_MUTATION .*"tool":"safe_edit".*"shape":"targeted_edit".*"repairPhase":true/);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":1.*"strictReduction":true/);
  assert.doesNotMatch(logs, /PI_CODING_VALIDATION_NON_CONVERGENT/);
  assert.match(logs, /CODING_REPAIR_EVIDENCE_OK/);
});

test('#511 repair reasoning length falls directly into one required low-overhead mutation fallback', () => {
  const logs = runtimeScenario('repair-reasoning-fallback');
  assert.match(logs, /PI_CODING_REPAIR_TOOL_SURFACE .*"phase":"reasoning_mutation"/);
  assert.match(logs, /PI_CODING_REPAIR_TOOL_CHOICE_ARMED .*"phase":"reasoning"/);
  assert.match(logs, /PI_CODING_REPAIR_ACTION_FALLBACK_ARMED .*"reason":"reasoning_output_ceiling_without_action"/);
  assert.match(logs, /PI_CODING_REPAIR_TOOL_SURFACE .*"phase":"fallback_mutation"/);
  assert.match(logs, /PI_CODING_REPAIR_TOOL_CHOICE_ARMED .*"phase":"fallback"/);
  assert.match(logs, /PI_CODING_REPAIR_ACTION_OBSERVED .*"phase":"fallback".*"tool":"safe_edit"/);
  assert.match(logs, /PI_CODING_REPAIR_ACTION_SATISFIED .*"tool":"safe_edit"/);
  assert.equal((logs.match(/PI_CODING_REPAIR_ACTION_FALLBACK_ARMED/g) ?? []).length, 1, 'one validation state gets one cheap fallback');
  assert.match(logs, /CODING_REPAIR_REASONING_FALLBACK_OK/);
});

test('#511 an empty cheap repair fallback aborts once with the worktree preserved', () => {
  const logs = runtimeScenario('repair-reasoning-fallback-abort');
  assert.match(logs, /PI_CODING_REPAIR_ACTION_FALLBACK_ARMED/);
  assert.match(logs, /PI_CODING_REPAIR_ACTION_FALLBACK_FAILED .*"checkpoint":\{"worktree_preserved":true\}/);
  assert.equal((logs.match(/PI_CODING_REPAIR_TOOL_SURFACE .*"phase":"fallback_mutation"/g) ?? []).length, 1, 'exactly one fallback provider request is attempted');
  assert.match(logs, /CODING_REPAIR_FALLBACK_ABORT_OK/);
});

test('#511 a completed no-tool reasoning turn also enters the cheap fallback without waiting for a ceiling', () => {
  const logs = runtimeScenario('repair-reasoning-prose-fallback');
  assert.match(logs, /PI_CODING_REPAIR_ACTION_FALLBACK_ARMED .*"reason":"reasoning_completed_without_action"/);
  assert.match(logs, /PI_CODING_REPAIR_ACTION_OBSERVED .*"phase":"fallback".*"tool":"safe_edit"/);
  assert.match(logs, /CODING_REPAIR_PROSE_FALLBACK_OK/);
});

test('#511 retryable provider errors retry reasoning instead of racing a fallback steer', () => {
  const logs = runtimeScenario('repair-retryable-provider-error');
  assert.match(logs, /PI_CODING_REPAIR_PROVIDER_RETRY .*"phase":"reasoning".*"status":429/);
  assert.ok((logs.match(/PI_CODING_REPAIR_TOOL_SURFACE .*"phase":"reasoning_mutation"/g) ?? []).length >= 2, 'the same reasoning phase is rebuilt for the provider retry');
  assert.doesNotMatch(logs, /PI_CODING_REPAIR_ACTION_FALLBACK_ARMED/);
  assert.match(logs, /CODING_REPAIR_PROVIDER_RETRY_OK/);
});

test('#511 non-retryable reasoning rejection arms fallback and fallback rejection aborts', () => {
  const logs = runtimeScenario('repair-provider-errors');
  assert.match(logs, /PI_CODING_REPAIR_ACTION_FALLBACK_ARMED .*"reason":"provider_error_422"/);
  assert.match(logs, /PI_CODING_REPAIR_ACTION_FALLBACK_FAILED .*"reason":"fallback_provider_error_422".*"worktree_preserved":true/);
  assert.match(logs, /CODING_REPAIR_PROVIDER_ERROR_ABORT_OK/);
});

test('#506 one syntax broad mutation is shared across write/safe_edit/edit and repeated bypass attempts fail closed', () => {
  const logs = runtimeScenario('repair-rewrite-limit');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"rewriteEligiblePaths":\["test_generated.py"\].*"broadMutationLimit":1/);
  assert.match(logs, /PI_MUTATION .*"tool":"write".*"shape":"whole_file_rewrite".*"repairPhase":true.*"broadMutationCount":1.*"wholeFileRewriteCount":1/);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":1.*"strictReduction":true/);
  assert.match(logs, /PI_CODING_REPAIR_MUTATION_GUARD .*"status":"blocked".*"shape":"whole_file_rewrite".*"broadCount":1/);
  assert.match(logs, /PI_CODING_REPAIR_MUTATION_GUARD .*"shape":"broad_edit".*"blockedAttempts":2/);
  assert.match(logs, /PI_CODING_REPAIR_MUTATION_GUARD .*"status":"limit_abort".*"shape":"broad_edit".*"blockedAttempts":3/);
  assert.match(logs, /PI_CODING_REPAIR_BROAD_MUTATION_LIMIT .*"worktree_preserved":true/);
  const firstSuccessfulRepairEnd = logs.indexOf('"strictReduction":true');
  assert.ok(firstSuccessfulRepairEnd > 0, 'first successful reasoning mutation reaches the next authoritative failure');
  assert.doesNotMatch(
    logs.slice(0, firstSuccessfulRepairEnd),
    /PI_CODING_REPAIR_ACTION_FALLBACK_ARMED/,
    'a successful reasoning tool call does not invoke fallback before the next validation state',
  );
  assert.match(logs, /CODING_REPAIR_BROAD_MUTATION_LIMIT_OK/);
});
test('#499 repair convergence survives unrelated passes and bounds A-B-A-B failure flip-flops', () => {
  const logs = runtimeScenario('repair-nonconvergent');
  assert.ok((logs.match(/PI_CODING_REPAIR_STATE .*"nonImprovingFailures":1.*"strictReduction":true/g) ?? []).length >= 1);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":2.*"strictReduction":false/);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":4.*"strictReduction":false/);
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":5.*"strictReduction":false.*"limit":5/);
  assert.match(logs, /PI_CODING_VALIDATION_NON_CONVERGENT .*"seen_signatures":2.*"limit":5.*"worktree_preserved":true/);
  assert.match(logs, /CODING_REPAIR_NONCONVERGENT_OK/);
});

test('#499 volatile diagnostic values keep one semantic failure identity', () => {
  const logs = runtimeScenario('repair-volatile-message');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":2.*"strictReduction":false.*"seenSignatures":1/);
  assert.doesNotMatch(logs, /PI_CODING_VALIDATION_NON_CONVERGENT/);
  assert.match(logs, /CODING_REPAIR_VOLATILE_MESSAGE_OK/);
});

test('#503 a provably covering same-kind pass clears narrower coding repair history', () => {
  const logs = runtimeScenario('repair-pass-reset');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"status":"cleared".*"reason":"validation_pass_covering_scope"/);
  const postReset = logs.slice(logs.indexOf('validation_pass_covering_scope'));
  assert.match(postReset, /PI_CODING_SESSION .*"phase":"thinking_policy".*"policy":"normal_low_overhead".*"enableThinking":false/);
  assert.match(postReset, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":1/);
  assert.doesNotMatch(logs, /PI_CODING_VALIDATION_NON_CONVERGENT/);
  assert.match(logs, /CODING_REPAIR_PASS_RESET_OK/);
});

test('#503 semantic diagnostic numbers remain distinct repair identities', () => {
  const logs = runtimeScenario('repair-semantic-number');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"nonImprovingFailures":2.*"seenSignatures":2/);
  assert.match(logs, /CODING_REPAIR_SEMANTIC_NUMBER_OK/);
});

test('#503 structured run_check failure details are observed even when isError is true', () => {
  const logs = runtimeScenario('repair-iserror-details');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"status":"fail"/);
  assert.match(logs, /CODING_REPAIR_ISERROR_DETAILS_OK/);
});

test('#503 empty trusted repair scope releases the evidence gate instead of dead-ending', () => {
  const logs = runtimeScenario('repair-empty-scope');
  assert.match(logs, /PI_CODING_REPAIR_STATE .*"evidenceGateReleased":true/);
  assert.doesNotMatch(logs, /PI_TOOL_SURFACE_UPDATE .*"reason":"repair_evidence".*"read"/);
  assert.match(logs, /CODING_REPAIR_EMPTY_SCOPE_OK/);
});

test('parent submit inherits accepted scope from a coding-session fork that ended without submit', () => {
  const logs = runtimeScenario('no-submit-parent-submit');
  assert.match(logs, /"phase":"ended_without_submit".*"submitted":false/);
  assert.match(logs, /PARENT_SUBMIT_AFTER_FORK_OK/);
});

test('#512 planner-armed 16K request is mutation-only, action-forced, and writes the full initial file', () => {
  const logs = runtimeScenario('large-mutation-auto-force');
  assert.match(logs, /PI_PLAN .*"largeMutation":true.*"largeMutationArmed":true/);
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"auto_pending"/);
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"granted".*"maxTokens":16384/);
  assert.match(logs, /PI_LARGE_MUTATION_TOOL_CHOICE_ARMED/);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE .*"source":"large_mutation"/);
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"scope_prelude".*"preserved":true/);
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"consumed".*"successfulFinishTool":true/);
  assert.match(logs, /LARGE_MUTATION_AUTO_FORCE_OK/);
});

test('#523 oversized coding-session handoff gets one forced correction without consuming the 16K grant', () => {
  const logs = runtimeScenario('large-mutation-coding-argument-recovery');
  assert.match(logs, /CODING_SESSION_ARGUMENT_BOUNDARY_OK/);
  assert.match(logs, /PI_CODING_SESSION_ARGUMENT_CORRECTION .*"correction":1.*"largeMutationBudget":"active"/);
  assert.match(logs, /PI_LARGE_MUTATION_BUDGET .*"phase":"coding_session_argument_correction".*"preserved":true/);
  assert.match(logs, /PI_CODING_SESSION_ARGUMENT_TOOL_SURFACE .*"tools":\["begin_coding_session"\]/);
  assert.match(logs, /PI_CODING_SESSION_ARGUMENT_VALIDATION_TURN .*"action":"ignored_for_provider_retry"/);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE .*"source":"coding_session_argument_correction"/);
  assert.doesNotMatch(logs, /PI_LARGE_MUTATION_PROVIDER_RETRY /);
  assert.doesNotMatch(logs, /PI_UNAVAILABLE_CAPABILITY_CORRECTION|PI_UNAVAILABLE_CAPABILITY_ABORT/, 'invalid arguments remain distinct from unavailable capability');
  assert.match(logs, /PI_CODING_SESSION_ARGUMENT_CORRECTED/);
  assert.match(logs, /CODING_SESSION_ARGUMENT_CORRECTION_OK/);
  assert.doesNotMatch(logs, /PI_LARGE_MUTATION_ACTION_REQUIRED/);
  assert.doesNotMatch(logs, /runtime_failure_metadata_invalid/);
});

test('#523 repeated invalid coding-session handoff aborts deterministically with preserved checkpoint', () => {
  const logs = runtimeScenario('large-mutation-coding-argument-retry-abort');
  assert.equal((logs.match(/PI_CODING_SESSION_ARGUMENT_CORRECTION /g) ?? []).length, 1);
  assert.match(logs, /PI_CODING_SESSION_ARGUMENT_RETRY_EXHAUSTED .*"attempts":2.*"retryLimit":1.*"worktree_preserved":true/);
  assert.match(logs, /CODING_SESSION_ARGUMENT_RETRY_ABORT_OK/);
  assert.doesNotMatch(logs, /PI_LARGE_MUTATION_ACTION_REQUIRED/);
});

test('#523 issue-agent accepts runtime-owned model abort codes and preserves their code and reason', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const reason = 'elevated large-mutation provider response completed without an allowed tool call';
  assert.deepEqual(
    classifyRuntimeFailureRecord({
      schema_version: 1,
      failure_class: 'model_execution_abort',
      failure_code: 'PI_LARGE_MUTATION_ACTION_REQUIRED',
      reason,
    }),
    {
      schema_version: 1,
      failure_class: 'model_execution_abort',
      failure_code: 'PI_LARGE_MUTATION_ACTION_REQUIRED',
      reason,
    },
    'a legitimate large-mutation abort keeps its original code and reason',
  );
  assert.equal(
    classifyRuntimeFailureRecord({
      schema_version: 1,
      failure_class: 'model_execution_abort',
      failure_code: 'PI_CODING_SESSION_ARGUMENT_RETRY_EXHAUSTED',
      reason: 'coding-session launch arguments remained invalid',
    })?.failure_code,
    'PI_CODING_SESSION_ARGUMENT_RETRY_EXHAUSTED',
  );
  assert.equal(
    classifyRuntimeFailureRecord({
      schema_version: 1,
      failure_class: 'model_execution_abort',
      failure_code: 'PI_FAKE_MODEL_CODE',
      reason: 'not runtime-owned',
    }),
    null,
    'unknown PI-looking codes remain invalid metadata',
  );
  assert.equal(
    classifyRuntimeFailureRecord({
      schema_version: 1,
      failure_class: 'infrastructure',
      failure_code: 'PI_LARGE_MUTATION_ACTION_REQUIRED',
      reason,
    }),
    null,
    'known codes with a mismatched class remain invalid metadata',
  );
  assert.equal(
    (workflow.match(/runtime-failure\.mjs" classify "\$PI_RUNTIME_FAILURE_FILE"/g) ?? []).length,
    2,
    'both publication failure paths use the same canonical classifier',
  );
  assert.equal(
    (workflow.match(/FAILURE_REASON="\$\(jq -r '\.reason' <<<"\$CLASSIFIED_RUNTIME_FAILURE"\)"/g) ?? []).length,
    2,
    'both publication paths preserve the validated original reason',
  );
  assert.match(workflow, /runtime_failure_metadata_invalid/, 'malformed or unsupported metadata still has a fail-closed classification');
});

test('#512 completed prose-only elevated response aborts without spending another 16K turn', () => {
  const logs = runtimeScenario('large-mutation-prose-abort');
  assert.match(logs, /PI_LARGE_MUTATION_TOOL_CHOICE_ARMED/);
  assert.match(logs, /PI_LARGE_MUTATION_ACTION_REQUIRED .*"worktree_preserved":true/);
  assert.equal((logs.match(/PI_LARGE_MUTATION_BUDGET .*"phase":"granted"/g) ?? []).length, 1);
  assert.doesNotMatch(logs, /PI_LARGE_MUTATION_ACTION_RETRY/);
  assert.match(logs, /LARGE_MUTATION_PROSE_ABORT_OK/);
});

test('#512 elevated output ceiling gets one required 16K retry, then aborts deterministically', () => {
  const logs = runtimeScenario('large-mutation-length-retry-abort');
  assert.equal((logs.match(/PI_LARGE_MUTATION_ACTION_RETRY .*"retryReason":"output_ceiling_without_tool_call"/g) ?? []).length, 1);
  assert.ok((logs.match(/PI_ACTION_REQUIRED_TOOL_CHOICE .*"source":"large_mutation"/g) ?? []).length >= 2);
  assert.match(logs, /PI_LARGE_MUTATION_TRUNCATION_RETRY_EXHAUSTED .*"retryLimit":1.*"worktree_preserved":true/);
  assert.match(logs, /LARGE_MUTATION_LENGTH_RETRY_ABORT_OK/);
});

test('#512 retryable elevated provider errors are bounded to one retry', () => {
  const logs = runtimeScenario('large-mutation-provider-retry-abort');
  assert.equal((logs.match(/PI_LARGE_MUTATION_PROVIDER_RETRY /g) ?? []).length, 1);
  assert.match(logs, /PI_LARGE_MUTATION_PROVIDER_RETRY .*"status":429.*"retry":1.*"retryLimit":1/);
  assert.match(logs, /PI_LARGE_MUTATION_PROVIDER_RETRY_EXHAUSTED .*"status":503.*"retryLimit":1.*"worktree_preserved":true/);
  assert.match(logs, /LARGE_MUTATION_PROVIDER_RETRY_ABORT_OK/);
});

test('#512 failed elevated actions get exactly one required retry before deterministic abort', () => {
  const logs = runtimeScenario('large-mutation-action-retry-abort');
  assert.equal((logs.match(/PI_LARGE_MUTATION_ACTION_RETRY /g) ?? []).length, 1, 'only one failed-action retry is permitted');
  assert.ok((logs.match(/PI_ACTION_REQUIRED_TOOL_CHOICE .*"source":"large_mutation"/g) ?? []).length >= 2, 'both elevated requests are provider action-forced');
  assert.match(logs, /PI_LARGE_MUTATION_ACTION_RETRY_EXHAUSTED .*"retryLimit":1.*"worktree_preserved":true/);
  assert.match(logs, /LARGE_MUTATION_ACTION_RETRY_ABORT_OK/);
});

test('#512 one elevated mutation grant permits one scope prelude and repeated scope-only turns terminate', () => {
  const logs = runtimeScenario('scope-prelude-cap');
  assert.equal((logs.match(/PI_LARGE_MUTATION_BUDGET .*"phase":"scope_prelude".*"preserved":true/g) ?? []).length, 1);
  assert.equal((logs.match(/PI_LARGE_MUTATION_ACTION_RETRY /g) ?? []).length, 1, 'only the first blocked repeat gets a retry');
  assert.match(logs, /PI_LARGE_MUTATION_ACTION_RETRY_EXHAUSTED .*"retryLimit":1/);
  assert.match(logs, /SCOPE_PRELUDE_CAP_OK/);
});

test('#669 per-request Main wire contract survives valid and failed tools and bounds provider stop violations', () => {
  const logs = runtimeScenario('action-required-serial');
  const records = logs.split('\n').filter(line => line.startsWith('PI_IMPLEMENTER_PROVIDER_WIRE '))
    .map(line => JSON.parse(line.slice('PI_IMPLEMENTER_PROVIDER_WIRE '.length)));
  assert.ok(records.length >= 5);
  assert.ok(records.every(req => req.productiveState === 'action_required' && req.toolChoice === 'required'));
  assert.ok(records.every(req => req.executableToolCount === req.executableTools.length));
  const violations = logs.split('\n').filter(line => line.startsWith('PI_PROVIDER_TOOL_CHOICE_CONTRACT_VIOLATION '))
    .map(line => JSON.parse(line.slice('PI_PROVIDER_TOOL_CHOICE_CONTRACT_VIOLATION '.length)));
  assert.equal(violations.length, 2);
  assert.notEqual(violations[0].request, violations[1].request, 'distinct requests correlated');
  assert.match(logs, /ACTION_REQUIRED_SERIAL_OK/);
});

test('first prose-only action-required retry stays forced through a ceiling turn until a real exposed tool', () => {
  const logs = runtimeScenario('prose-force-direct');
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_PERSISTENT/);
  assert.ok((logs.match(/PI_IMPLEMENTER_PROVIDER_WIRE .*"toolChoice":"required"/g) ?? []).length >= 2);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED .*"tool":"accept_mutation_scope"/);
  assert.doesNotMatch(logs, /PI_ACTION_REQUIRED_ABORT/);
});

test('OpenAI SDK provider error turns preserve forcing on 408/429 and recover once from a forced 422', () => {
  const logs = runtimeScenario('prose-force-provider-statuses');
  assert.ok((logs.match(/PI_IMPLEMENTER_PROVIDER_WIRE .*"toolChoice":"required"/g) ?? []).length >= 3);
  assert.match(logs, /PI_PROVIDER_ERROR_TURN .*"status":408.*"forced":true/);
  assert.match(logs, /PI_PROVIDER_ERROR_TURN .*"status":429.*"forced":true/);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_CLEARED .*"reason":"provider_request_rejected".*"status":422.*"source":"turn_end"/);
  assert.doesNotMatch(logs, /PI_ACTION_REQUIRED_ABORT/);
});

test('an already-completed repeated tool call cannot clear state forcing and still fails closed', () => {
  const logs = runtimeScenario('action-repeat-abort');
  assert.match(logs, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"attemptedTool":"subagents_enable"/);
  assert.match(logs, /PI_UNAVAILABLE_CAPABILITY_ABORT/);
  assert.doesNotMatch(logs, /PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn/);
});

test('#470 missing evidence executor restores the permit through the real runtime hooks', () => {
  const logs = runtimeScenario('evidence-missing-executor');
  const failureLine = logs.split('\n').find(line => line.startsWith('PI_RUNTIME_FAILURE '));
  assert.ok(failureLine, 'runtime contract failure is recorded');
  const failure = JSON.parse(failureLine.slice('PI_RUNTIME_FAILURE '.length));
  assert.equal(failure.failure_code, 'PI_TOOL_CONTRACT_FAILURE');
  assert.equal(failure.tool, 'read');
  assert.match(logs, /EVIDENCE_MISSING_EXECUTOR_PERMIT_RESTORED/);
});


test('#469 evidence unlock is single-use; stale lifecycle races reset strikes before genuine unavailable calls can abort', () => {
  const logs = runtimeScenario('action-hidden-abort');
  assert.match(logs, /PI_EVIDENCE_PERMIT_CONSUMED .*"tool":"read".*"productiveState":"action_required"/);
  assert.match(logs, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"attemptedTool":"grep"/);
  assert.match(logs, /PI_CAPABILITY_LIFECYCLE_MISMATCH .*"attemptedTool":"need_more_evidence"/);
  assert.ok((logs.match(/PI_UNAVAILABLE_CAPABILITY_CORRECTION /g) ?? []).length >= 1, 'an unavailable tool gets a bounded correction before abort');
  assert.match(logs, /PI_UNAVAILABLE_CAPABILITY_ABORT: unavailable capability repeated after 1 bounded correction turn/);
  assert.match(logs, /UNAVAILABLE_CAPABILITY_FAILURE .*"failure_code":"PI_UNAVAILABLE_CAPABILITY_ABORT"/);
  assert.match(logs, /UNAVAILABLE_CAPABILITY_FAILURE .*"worktree_preserved":true/);
  assert.doesNotMatch(logs, /PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn/);
});

test('coding-session fork preserves action_required forcing after its first tool', () => {
  const logs = runtimeScenario('fork-prose-force');
  assert.match(logs, /PI_IMPLEMENTER_PROVIDER_WIRE .*"toolChoice":"required"/);
  assert.match(logs, /PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED .*"tool":"accept_mutation_scope"/);
});

test('coding session rejects an unavailable required capability before launching the fork', () => {
  const logs = runtimeScenario('forbidden-capability');
  assert.match(logs, /"phase":"rejected".*"reason":"required_capability_unavailable"/);
});

test('#440 an equivalent capability-incompatible fork is rejected without model-declared required_capability', () => {
  const logs = runtimeScenario('incapable-repeat');
  assert.match(logs, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"attemptedTool":"bash"/);
  assert.match(logs, /"phase":"started"[^\n]*"parentHandoffBytes":0/);
  assert.match(logs, /"phase":"ended_without_submit".*"unreachableCapabilities":\["bash"\]/);
  assert.match(logs, /"phase":"rejected".*"reason":"repeated_incapable_session".*"unreachable":\["bash"\]/);
  assert.match(logs, /INCAPABLE_FORK_REPEAT_REJECTED_OK/);
});

test('#440 a trusted recovery transition after an incapable fork permits another coding session', () => {
  const logs = runtimeScenario('incapable-transition');
  assert.doesNotMatch(logs, /repeated_incapable_session/);
  assert.match(logs, /INCAPABLE_FORK_TRANSITION_OK/);
});

test('a deliberately non-compliant second prose-only turn still aborts with durable execution-failure metadata', () => {
  const logs = runtimeScenario('action-prose-abort');
  assert.match(logs, /PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn/);
  assert.match(logs, /RUNTIME_FAILURE_RECORD .*"failure_class":"model_execution_abort".*"failure_code":"PI_ACTION_REQUIRED_ABORT"/);
});

test('coding handoff failures reject with a coded reason before child launch', () => {
  for (const mode of ['handoff-missing', 'handoff-malformed']) {
    const logs = runtimeScenario(mode);
    assert.match(logs, /"phase":"rejected".*"reason":"handoff_unavailable"/);
    assert.match(logs, /HANDOFF_UNAVAILABLE_OK/);
  }
});

test('cancellation and drafting loops fail closed while coding no longer requires a persisted parent session', () => {
  assert.match(runtimeScenario('cancel'), /"phase":"cancelled"/);
  const noSession = runtimeScenario('no-session');
  assert.match(noSession, /"phase":"started".*"context":"fresh"/);
  assert.match(noSession, /"phase":"completed".*"submitted":true/);
  const draft = runtimeScenario('ceiling-draft');
  assert.match(draft, /PI_ACTION_REQUIRED_STEER: ceiling without tool \(1\/3\)/);
  assert.match(draft, /PI_ACTION_REQUIRED_ABORT: 3 consecutive action-required responses hit the output ceiling without a tool call/);
});

test('rewriting the issue-worktree runtime, settings or agent definition cannot change the coding session', () => {
  assert.match(runtimeScenario('tampered'), /"phase":"completed".*"submitted":true/);
  assert.match(runtimeScenario('shadow-agent'), /"phase":"ended_without_submit".*collides with configured agent/);
});

test('the submit nudge honors a submission recorded by another process', async () => {
  const { terminalMarkerSubmitted } = await import('../scripts/pi-common/terminal-tool.mjs');
  const dir = tempDir();
  try {
    const marker = path.join(dir, 'terminal');
    assert.equal(terminalMarkerSubmitted({ PI_TERMINAL_RESULT_FILE: marker }), false, 'no marker');
    fs.writeFileSync(marker, 'something else\n');
    assert.equal(terminalMarkerSubmitted({ PI_TERMINAL_RESULT_FILE: marker }), false, 'foreign content');
    fs.writeFileSync(marker, 'submitted\n');
    assert.equal(terminalMarkerSubmitted({ PI_TERMINAL_RESULT_FILE: marker }), true);
    assert.equal(terminalMarkerSubmitted({}), false, 'no marker configured');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run_check scope normalization from current dev accepts relative and worktree-absolute paths (#281)', async () => {
  const { normalizeRunCheckPaths } = await import('../scripts/pi-common/run-check.mjs');
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'generated.py'), 'x = 1\n');
    assert.deepEqual(normalizeRunCheckPaths(dir, { kind: 'python_compile', paths: [path.join(dir, 'generated.py')] }).paths, ['generated.py']);
    assert.deepEqual(normalizeRunCheckPaths(dir, { kind: 'python_compile', paths: ['generated.py'] }).paths, ['generated.py']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#397–#402 nested unavailable tools abort as runtime infrastructure without another coding session', () => {
  const logs = runtimeScenario('tool-contract');
  assert.match(logs, /PI_RUNTIME_FAILURE_NESTED/);
  assert.match(logs, /PI_TOOL_CONTRACT_FAILURE/);
  // #425: the contract-failure exit still records the session and keeps the fork's per-response usage.
  const session = lastMetrics.find(record => record.scope === 'session' && record.call === 'coding');
  assert.equal(session?.status, 'contract_failure');
  assert.equal(session.usage.totalTokens, 55);
  // Per-response usage (12) and the failed envelope's roll-up (55) disagree: keep the known 55, flag the mismatch.
  const ledger = summarizeUsage(lastMetrics);
  assert.equal(ledger.calls.get('coding').total, 55);
  assert.equal(ledger.complete, false);
  assert.ok(ledger.unknown.some(entry => entry.reason === 'session_response_usage_mismatch'));
  assert.ok(lastMetrics.some(record => record.call === 'coding' && record.scope === undefined && record.childSession === session.childSession));
});

test('#425 a second coding attempt after recovery keeps both sessions attributed once', () => {
  runtimeScenario('incapable-transition');
  const sessions = lastMetrics.filter(record => record.scope === 'session' && record.call === 'coding');
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].childSession, sessions[1].childSession);
  const perSession = sessions.map(session => lastMetrics.filter(record => record.scope === undefined && record.childSession === session.childSession).length);
  assert.ok(perSession.every(count => count > 0), 'each attempt has its own per-response usage');
  const ledger = summarizeUsage(lastMetrics);
  assert.equal(ledger.calls.get('coding').responses, perSession[0] + perSession[1]);
});

test('coding-session allowlist is derived from the executable registry, including hidden tools', () => {
  runtimeScenario('narrow-registry');
});

test('#470 failed bash invalidates pytest evidence when it changed the worktree', () => {
  assert.match(runtimeScenario('bash-error-mutates'), /FAILED_BASH_MUTATION_INVALIDATED/);
});

test('#470 failed bash invalidates pytest evidence when repository fingerprint is unknown', () => {
  assert.match(runtimeScenario('bash-error-unknown'), /FAILED_BASH_UNKNOWN_INVALIDATED/);
});

test('#399 executor-unavailable bash tool result aborts the parent as infrastructure immediately', () => {
  runtimeScenario('parent-contract');
});

test('malformed fork provenance preserves the original delegation error and removes the artifact', () => {
  assert.match(runtimeScenario('malformed-contract'), /PI_CODING_CONTRACT_METADATA_INVALID/);
});

test('both missing-executor event orders abort only once', () => {
  runtimeScenario('parent-contract');
  runtimeScenario('parent-contract-reverse');
});

test('#441 a tool activated after payload assembly is deferred, not advertised; contract failures still abort', () => {
  const logs = runtimeScenario('deferred-capability');
  assert.match(logs, /PI_PROVIDER_CAPABILITY_DEFERRED .*"request":\d+,"executableTools":\[[^\]]*\],"activeTools":\[[^\]]*"submit_result"[^\]]*\],"deferredTools":\["submit_result"\]/);
  assert.match(logs, /PI_PROVIDER_CAPABILITY_SNAPSHOT .*"deferredTools":\["submit_result"\]/);
  assert.match(logs, /PI_CAPABILITY_LIFECYCLE_MISMATCH .*"kind":"deferred_tool_called","attemptedTool":"submit_result"/);
  assert.equal((logs.match(/PI_CAPABILITY_LIFECYCLE_MISMATCH/g) ?? []).length, 1, 'both pi events for one call log once');
  assert.match(logs, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"kind":"executor_not_found","attemptedTool":"ghost_tool"/);
  assert.match(logs, /PI_RUNTIME_FAILURE .*"tool":"submit_result".*"failure_code":"PI_TOOL_CONTRACT_FAILURE"/);
  assert.match(logs, /DEFERRED_CAPABILITY_OK/);
});

test('#441 a coding-session fork defers a late-active tool and recovers from calling it', () => {
  const logs = runtimeScenario('fork-deferred-capability');
  assert.match(logs, /PI_CAPABILITY_LIFECYCLE_MISMATCH .*"attemptedTool":"submit_result"/);
  assert.match(logs, /FORK_UNAVAILABLE_SIDECAR_ONCE_OK/);
  assert.match(logs, /FORK_DEFERRED_CAPABILITY_OK/);
  assert.match(logs, /"phase":"completed".*"submitted":true/);
});

test('#441 deferred guidance stays conditional when another tool removes the deferred tool before the next request', () => {
  const logs = runtimeScenario('deferred-then-removed');
  assert.match(logs, /PI_CAPABILITY_LIFECYCLE_MISMATCH .*"attemptedTool":"submit_result"/);
  assert.match(logs, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"kind":"executor_not_found","attemptedTool":"submit_result"/);
  assert.doesNotMatch(logs, /PI_TOOL_CONTRACT_FAILURE/);
  assert.match(logs, /DEFERRED_THEN_REMOVED_OK/);
});
