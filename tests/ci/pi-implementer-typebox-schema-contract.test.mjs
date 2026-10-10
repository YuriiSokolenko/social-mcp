import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RESULT_TOOL_URL = new URL('../../scripts/pi-implementer-result-tool.mjs', import.meta.url).href;
const TYPEBOX_PACKAGE_ROOT = process.env.PI_TYPEBOX_PACKAGE_ROOT;

if (!TYPEBOX_PACKAGE_ROOT) {
  throw new Error('PI_TYPEBOX_PACKAGE_ROOT is required for the real TypeBox CI contract check.');
}

const EXPECTED_PROPERTIES = {
  resultText: 'Fresh changed work only: complete Markdown/free-text implementation description on the dedicated submission request.',
  already_satisfied: 'Fresh work only: explicit, evidence-proven already-satisfied outcome.',
  blocked_reason: 'Fresh work only: concrete contradictory requirement, verified against the current repository.',
};

function writeTypeboxLoader(dir) {
  const loader = path.join(dir, 'real-typebox-loader.mjs');
  const packageParent = pathToFileURL(path.join(TYPEBOX_PACKAGE_ROOT, 'resolve-from-here.mjs')).href;
  fs.writeFileSync(loader, `
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'typebox' || specifier.startsWith('typebox/')) {
        return nextResolve(specifier, { ...context, parentURL: ${JSON.stringify(packageParent)} });
      }
      return nextResolve(specifier, context);
    }
  `);
  return loader;
}

test('registered submit_result schema matches the real Pi TypeBox transport contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-real-typebox-'));
  try {
    const loader = writeTypeboxLoader(dir);
    const program = `
      import assert from 'node:assert/strict';
      const { Value } = await import('typebox/value');
      const { default: registerResultTool } = await import(${JSON.stringify(RESULT_TOOL_URL)});

      let tool;
      const pi = {
        registerTool(value) { if (value.name === 'submit_result') tool = value; },
        appendEntry() {},
        on() {},
      };
      registerResultTool(pi);

      const schema = tool.parameters;
      const expectedProperties = ${JSON.stringify(EXPECTED_PROPERTIES)};
      assert.equal(schema.type, 'object');
      assert.equal(schema.anyOf, undefined, 'transport schema must not use a union');
      assert.equal(schema.oneOf, undefined, 'transport schema must not use a union');
      assert.equal(schema.allOf, undefined, 'transport schema must stay flat');
      assert.deepEqual(Object.keys(schema.properties), Object.keys(expectedProperties));
      assert.deepEqual(schema.required ?? [], [], 'explicit terminal outcomes and restored compatibility remain optional in TypeBox');
      for (const [field, description] of Object.entries(expectedProperties)) {
        assert.equal(schema.properties[field].description, description, field + ' description');
        assert.equal(schema.properties[field].anyOf, undefined, field + ' must not be union-shaped');
        assert.equal(schema.properties[field].oneOf, undefined, field + ' must not be union-shaped');
      }

      assert.equal(Value.Check(schema, {}), true, 'flat transport schema must permit alternate result shapes');
      await assert.rejects(
        tool.execute('missing-fresh-publication-metadata', {}),
        error => {
          assert.deepEqual(JSON.parse(error.message), {
            code: 'result_submission_not_complete',
            phase: 'coding',
            provider_budget_verified: false,
          });
          return true;
        },
        'runtime validation remains authoritative for fresh changed work',
      );
    `;
    const bootstrap = `
      import { register } from 'node:module';
      import { pathToFileURL } from 'node:url';
      register(pathToFileURL(${JSON.stringify(loader)}), import.meta.url);
      ${program}
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PI_RESUME_ACTIVE: 'false',
        PI_VALIDATION_REPAIR: 'false',
      },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #764: golden fixtures captured from the original registered TypeBox schemas on dev.
const RUNTIME_SCHEMA_URL = new URL('../../scripts/pi-agent-runtime.mjs', import.meta.url).href;
const EXPECTED_MUTATION_TOOL_METADATA = {
  "accept_mutation_scope": {
    "label": "Accept mutation scope",
    "description": "Record task-related mutation intent in trusted runtime state before changing a new path. disposition=publishable authorizes the path for the final diff only when accepted before it becomes changed. disposition=temporary permits scratch/probe work but the path must be removed before final validation/publication. A path that is already changed cannot be retroactively made publishable."
  },
  "structural_edit": {
    "label": "Structural AST edit",
    "description": "Preferred source-code mutation when one exact syntax node can be described with an ast-grep pattern/rewrite. ast-grep infers the language from the target file, dry-runs the rewrite, requires exactly one AST match, verifies the matched byte range is still current, then writes that one replacement atomically. Use metavariables to preserve untouched code instead of reproducing neighboring statements. Use safe_edit for bounded text/config edits or when structural matching is not a good fit."
  },
  "safe_edit": {
    "label": "Safe line edit",
    "description": "Deterministic current-worktree mutation by 1-based line/range. Prefer it for bounded insert/replace changes when reproducing multiline oldText would be brittle. It re-reads the file immediately before writing, validates an optional expected marker, preserves newline style/final-newline state, writes atomically, returns a bounded post-edit preview of what landed on disk, and participates in normal rollback/progress handling. A result with changed=false means no edit occurred. Do not re-read merely to verify a successful change."
  },
  "run_check": {
    "label": "Run focused check",
    "description": "Focused local verification without shell access. kind=python_compile|ruff take paths (workspace files/dirs); kind=pytest takes Python .py test targets (optionally ::test_node), e.g. {kind:\"pytest\",targets:[\"tests/test_engine.py\"]}; kind=node_test takes explicit .test.mjs/.test.js files, e.g. {kind:\"node_test\",targets:[\"examples/workflow-smoke/arkanoid/engine.test.mjs\"]}; kind=profile takes a trusted profile=node_tests|pytest_all. Never pass JavaScript targets to pytest or Python targets to node_test: the mismatched request is invalid, not a test failure. Returns {status: pass|fail|timeout|invalid|infra_error, summary, diagnostics[{file,line,column,code,message}], stdout_tail, stderr_tail}. A failing check creates an exact kind+scope recovery requirement: fix the diagnostic with a mutation, then use retry_last_failed_check; broader or different scopes cannot resolve it. status=infra_error means the runner could not run the check (sandbox or tool missing): it says nothing about your change, so do not retry, do not look for a shell workaround, and report it as an infrastructure blocker. Available once after each successful mutation; the permit is consumed when the call is accepted regardless of the check outcome. Passing does not replace final validation; still call submit_result."
  }
};

async function checkRegisteredToolContracts(runtimeUrl, metadata) {
  const assert=(await import('node:assert/strict')).default;
  const {Type}=await import('typebox');
  const {Value}=await import('typebox/value');
  const {default: runtime}=await import(runtimeUrl);
  const kinds=['python_compile','ruff','pytest','node_test','profile'];
  // These fixtures are taken from the inline Type.Object declarations on dev before extraction.
  const expected={
    accept_mutation_scope:Type.Object({
      paths:Type.Array(Type.String({minLength:1,maxLength:1000}),{minItems:1,maxItems:20}),
      disposition:Type.Union([Type.Literal('publishable'),Type.Literal('temporary')]),
      rationale:Type.String({minLength:8,maxLength:500}),
    }),
    structural_edit:Type.Object({
      path:Type.String({minLength:1,maxLength:1000}),
      pattern:Type.String({minLength:1,maxLength:20000}),
      rewrite:Type.String({minLength:1,maxLength:20000}),
    }),
    safe_edit:Type.Object({
      path:Type.String({minLength:1,maxLength:1000}),
      operation:Type.Union([Type.Literal('insert_before'),Type.Literal('insert_after'),Type.Literal('replace')]),
      start_line:Type.Integer({minimum:1}),
      end_line:Type.Optional(Type.Integer({minimum:1})),
      text:Type.String({minLength:1,maxLength:20000}),
      expected_marker:Type.Optional(Type.String({minLength:1,maxLength:300})),
    }),
    run_check:Type.Object({
      kind:Type.Union(kinds.map(kind=>Type.Literal(kind))),
      paths:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:1000}),{maxItems:20})),
      targets:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:1000}),{maxItems:20})),
      profile:Type.Optional(Type.String({minLength:1,maxLength:64})),
    }),
  };
  const tools=[];
  const pi={
    registerTool(tool){tools.push(tool);},on(){},appendEntry(){},
    events:{on(){},emit(){}},getActiveTools(){return [];},
    setActiveTools(){},getAllTools(){return tools.map(tool=>({name:tool.name}));},
    sendUserMessage(){},
  };
  runtime(pi);
  const byName=new Map(tools.map(tool=>[tool.name,tool]));
  assert.deepEqual(tools.filter(tool=>Object.hasOwn(expected,tool.name)).map(tool=>tool.name),
    ['accept_mutation_scope','structural_edit','safe_edit','run_check']);
  for(const [name,golden] of Object.entries(expected)){
    const tool=byName.get(name);
    assert.ok(tool,name+' registered');
    assert.equal(tool.label,metadata[name].label,name+' label');
    assert.equal(tool.description,metadata[name].description,name+' description');
    assert.equal(JSON.stringify(tool.parameters),JSON.stringify(golden),name+' serialized schema and ordering');
    assert.deepEqual(Object.keys(tool.parameters.properties),Object.keys(golden.properties),name+' property order');
    assert.deepEqual(tool.parameters.required,golden.required,name+' required fields');
  }
  const scope={paths:['a'],disposition:'publishable',rationale:'12345678'};
  const structural={path:'a',pattern:'x',rewrite:'y'};
  const safe={path:'a',operation:'replace',start_line:1,text:'x'};
  const check={kind:'node_test'};
  const cases={
    accept_mutation_scope:[
      [scope,true],[{...scope,disposition:'temporary'},true],
      [{...scope,paths:Array(20).fill('a'),rationale:'r'.repeat(500)},true],
      [{...scope,paths:[]},false],[{...scope,paths:Array(21).fill('a')},false],
      [{...scope,paths:['']},false],[{...scope,paths:['a'.repeat(1001)]},false],
      [{...scope,disposition:'wrong'},false],[{...scope,rationale:'x'.repeat(7)},false],
      [{...scope,rationale:'x'.repeat(501)},false],[{paths:['a'],disposition:'publishable'},false],
    ],
    structural_edit:[
      [structural,true],[{path:'a'.repeat(1000),pattern:'p'.repeat(20000),rewrite:'r'.repeat(20000)},true],
      [{...structural,path:''},false],[{...structural,path:'p'.repeat(1001)},false],
      [{...structural,pattern:''},false],[{...structural,rewrite:''},false],
      [{...structural,pattern:'x'.repeat(20001)},false],
      [{...structural,rewrite:'x'.repeat(20001)},false],
    ],
    safe_edit:[
      [safe,true],[{...safe,operation:'insert_before',end_line:1,expected_marker:'x'},true],
      [{...safe,operation:'insert_after',text:'x'.repeat(20000),expected_marker:'x'.repeat(300)},true],
      [{...safe,operation:'append'},false],[{...safe,start_line:0},false],
      [{...safe,start_line:1.5},false],[{...safe,end_line:0},false],
      [{...safe,text:''},false],[{...safe,text:'x'.repeat(20001)},false],
      [{...safe,expected_marker:''},false],[{...safe,expected_marker:'x'.repeat(301)},false],
    ],
    run_check:[
      ...kinds.map(kind=>[{kind},true]),
      [{...check,paths:[],targets:[],profile:'x'},true],
      [{...check,paths:Array(20).fill('a'),targets:Array(20).fill('a'),profile:'x'.repeat(64)},true],
      [{...check,kind:'shell'},false],[{...check,paths:Array(21).fill('a')},false],
      [{...check,targets:Array(21).fill('a')},false],[{...check,paths:['']},false],
      [{...check,targets:['a'.repeat(1001)]},false],[{...check,profile:''},false],
      [{...check,profile:'x'.repeat(65)},false],
    ],
  };
  for(const [name,values] of Object.entries(cases))for(const [value,valid] of values)
    assert.equal(Value.Check(byName.get(name).parameters,value),valid,name+' boundary '+JSON.stringify(value).slice(0,100));
}

test('registered mutation and run_check TypeBox contracts remain unchanged (#764)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-tool-schemas-'));
  try {
    const loader = writeTypeboxLoader(dir);
    const source = [
      "import { register } from 'node:module';",
      "import { pathToFileURL } from 'node:url';",
      'register(pathToFileURL(' + JSON.stringify(loader) + '), import.meta.url);',
      'await (' + checkRegisteredToolContracts.toString() + ')(' + JSON.stringify(RUNTIME_SCHEMA_URL) + ', ' + JSON.stringify(EXPECTED_MUTATION_TOOL_METADATA) + ');',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// #766: characterize both *registered* search schemas before extracting their builders.
// These golden schemas intentionally do not import runtime-tool-schemas.mjs.
const EXPECTED_SEARCH_TOOL_METADATA = {
  indexed_repo_search: {
    label: 'Indexed repository search',
    description: 'Fast read-only search against the configured Zoekt index of dev. Prefer it for literal/path discovery when the source symbol/path is not already known. For a known source-code symbol, use semantic LSP lookup first. Results may lag the current worktree, so use direct read/repo_search for exact post-mutation verification.',
  },
  repo_search: {
    label: 'Repository search',
    description: 'Cheap deterministic literal search over tracked repository paths or content in the current worktree. Use before scout for mechanical discovery; no child model is launched.',
  },
};

async function checkRegisteredSearchContracts(runtimeUrl, metadata) {
  const assert = (await import('node:assert/strict')).default;
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { Type } = await import('typebox');
  const { Value } = await import('typebox/value');
  const { default: runtime } = await import(runtimeUrl);

  const expected = {
    indexed_repo_search: Type.Object({
      kind: Type.Optional(Type.Union([
        Type.Literal('content'),
        Type.Literal('path'),
        Type.Literal('symbol'),
      ])),
      query: Type.String({ minLength: 1, maxLength: 300 }),
      pathPrefix: Type.Optional(Type.String({ maxLength: 300 })),
      extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 12 })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    repo_search: Type.Object({
      kind: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('path')])),
      query: Type.String({ minLength: 1, maxLength: 300 }),
      pathPrefix: Type.Optional(Type.String({ maxLength: 300 })),
      extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 12 })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
  };

  function registerTools() {
    const tools = [];
    runtime({
      registerTool(tool) { tools.push(tool); },
      on() {}, appendEntry() {},
      events: { on() {}, emit() {} },
      getActiveTools() { return []; },
      setActiveTools() {},
      getAllTools() { return tools.map(tool => ({ name: tool.name })); },
      sendUserMessage() {},
    });
    return tools;
  }

  const saved = {
    url: process.env.PI_ZOEKT_URL,
    repository: process.env.PI_ZOEKT_REPOSITORY,
    timeout: process.env.PI_ZOEKT_TIMEOUT_MS,
  };
  try {
    delete process.env.PI_ZOEKT_URL;
    const withoutZoekt = registerTools();
    const plainNames = withoutZoekt.map(tool => tool.name);
    assert.equal(plainNames.includes('indexed_repo_search'), false, 'Zoekt-disabled tool must not register');
    assert.equal(plainNames.filter(name => name === 'repo_search').length, 1, 'repo_search is independent of Zoekt');

    process.env.PI_ZOEKT_URL = 'http://127.0.0.1:6070';
    process.env.PI_ZOEKT_REPOSITORY = 'org/repo';
    process.env.PI_ZOEKT_TIMEOUT_MS = '3000';
    const withZoekt = registerTools();
    const names = withZoekt.map(tool => tool.name);
    assert.equal(names.filter(name => name === 'indexed_repo_search').length, 1);
    assert.equal(names.filter(name => name === 'repo_search').length, 1);
    assert.equal(names.indexOf('indexed_repo_search') + 1, names.indexOf('repo_search'),
      'search registration order and adjacency');
    assert.deepEqual(names.filter(name => name !== 'indexed_repo_search'), plainNames,
      'enabling Zoekt adds only its original conditional registration');

    const tools = new Map(withZoekt.map(tool => [tool.name, tool]));
    for (const [name, golden] of Object.entries(expected)) {
      const tool = tools.get(name);
      assert.ok(tool, name + ' registered');
      assert.equal(tool.label, metadata[name].label, name + ' label');
      assert.equal(tool.description, metadata[name].description, name + ' description');
      assert.equal(JSON.stringify(tool.parameters), JSON.stringify(golden),
        name + ' exact serialized provider schema, constraints, metadata and ordering');
      assert.deepEqual(Object.keys(tool.parameters.properties), Object.keys(golden.properties),
        name + ' property order');
      assert.deepEqual(tool.parameters.required, ['query'], name + ' required field');
      assert.deepEqual(tool.parameters.required, golden.required, name + ' required vs optional');

      const base = { query: 'needle' };
      const cases = [
        [base, true],
        [{ ...base, kind: 'content' }, true],
        [{ ...base, kind: 'path' }, true],
        [{ ...base, kind: 'symbol' }, name === 'indexed_repo_search'],
        [{ ...base, kind: 'regex' }, false],
        [{ query: 'q'.repeat(300) }, true],
        [{ query: '' }, false],
        [{ query: 'q'.repeat(301) }, false],
        [{ kind: 'path' }, false],
        [{ ...base, pathPrefix: '' }, true],
        [{ ...base, pathPrefix: 'p'.repeat(300) }, true],
        [{ ...base, pathPrefix: 'p'.repeat(301) }, false],
        [{ ...base, extensions: [] }, true],
        [{ ...base, extensions: Array(12).fill('x'.repeat(16)) }, true],
        [{ ...base, extensions: Array(13).fill('js') }, false],
        [{ ...base, extensions: [''] }, false],
        [{ ...base, extensions: ['x'.repeat(17)] }, false],
        [{ ...base, maxResults: 1 }, true],
        [{ ...base, maxResults: 50 }, true],
        [{ ...base, maxResults: 0 }, false],
        [{ ...base, maxResults: 51 }, false],
        [{ ...base, maxResults: 1.5 }, false],
      ];
      for (const [input, valid] of cases) {
        assert.equal(Value.Check(tool.parameters, input), valid,
          name + ' boundary ' + JSON.stringify(input).slice(0, 100));
      }
    }

    // Execute the actual registered callbacks, not substitute helpers.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-repo-search-contract-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'needle.txt'), 'needle inside a tracked file\n');
      for (const args of [['init', '-q', dir], ['-C', dir, 'add', 'src/needle.txt']]) {
        const result = spawnSync('git', args, { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
      const result = await tools.get('repo_search').execute(
        'repo-search-contract', { kind: 'path', query: 'needle' }, undefined, undefined, { cwd: dir },
      );
      assert.deepEqual(result.details, {
        kind: 'path', query: 'needle', matches: [{ path: 'src/needle.txt' }], truncated: false,
      });
      assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.details) }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, async json() {
        return { Files: [{ FileName: 'src/needle.txt', Repository: 'org/repo', Version: 'rev1' }] };
      } };
    };
    try {
      const result = await tools.get('indexed_repo_search').execute(
        'indexed-search-contract', { kind: 'symbol', query: 'NeedleSymbol', maxResults: 1 },
      );
      assert.equal(request.url, 'http://127.0.0.1:6070/api/search');
      assert.equal(request.options.method, 'POST');
      const payload = JSON.parse(request.options.body);
      assert.match(payload.Q, /repo:\^org\/repo\$/);
      assert.match(payload.Q, /sym:/);
      assert.equal(payload.Opts.MaxDocDisplayCount, 1);
      assert.deepEqual(result.details, {
        backend: 'zoekt', kind: 'symbol', query: 'NeedleSymbol',
        matches: [{ path: 'src/needle.txt', version: 'rev1', repository: 'org/repo' }],
        truncated: true,
      });
      assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.details) }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    for (const [key, value] of [
      ['PI_ZOEKT_URL', saved.url],
      ['PI_ZOEKT_REPOSITORY', saved.repository],
      ['PI_ZOEKT_TIMEOUT_MS', saved.timeout],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('registered repository search schemas match original TypeBox and exposure contracts (#766)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-search-typebox-'));
  try {
    const loader = writeTypeboxLoader(dir);
    const source = [
      "import { register } from 'node:module';",
      "import { pathToFileURL } from 'node:url';",
      'register(pathToFileURL(' + JSON.stringify(loader) + '), import.meta.url);',
      'await (' + checkRegisteredSearchContracts.toString() + ')(' + JSON.stringify(RUNTIME_SCHEMA_URL) + ', ' + JSON.stringify(EXPECTED_SEARCH_TOOL_METADATA) + ');',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #775: pre-extraction golden copies of the three *registered* recovery schemas.
// Do not import any recovery builders here: schema comparison must be independent.
const EXPECTED_RECOVERY_TOOL_METADATA = {
  recover_worktree: {
    label: 'Recover accidental worktree changes',
    description: 'Delete one untracked file or restore one tracked file to HEAD without a shell or coding session. delete_untracked and revert_tracked work only on paths the runtime can prove changed during this stage (clean/absent in the run-start baseline, not journaled, delete also not in accepted scope); pre-existing, journaled (use undo_mutation) and protected paths are refused with a precise code. Refuses escapes, symlinks, ignored files, .git and .gitignore. A file-set mismatch lists each remaining path under file_set.drift with its exact recovery action. Returns the current changed files and validates them against expected_files immediately; pass the intended final file set. A mismatch is recoverable: clean remaining accidental files, then submit_result.',
  },
  undo_mutation: {
    label: 'Undo a recorded mutation',
    description: 'Selectively undo one recorded structural_edit/safe_edit/edit/write by mutation_id. The runtime restores exact prior bytes/mode or deletes a file only when that mutation proved it created the file. It compares the current file with the recorded post-fingerprint first and refuses stale/conflicting, symlink, hard-link, out-of-worktree and protected control-plane targets. Pass the intended final file set so cleanup is validated immediately.',
  },
  rollback_last_mutation: {
    label: 'Rollback last mutation',
    description: 'Fast shortcut for undoing the shared latest structural_edit/safe_edit/edit/write. Persistent journal order is authoritative across parent/coding-session processes and uses compare-before-undo. After bounded-journal degradation, rollback is available only in the process that made the local-only mutation; other processes refuse instead of selecting an older mutation. After resume the barrier is intentionally stale because no process owns its prior-byte snapshot, so this shortcut continues to refuse until a new journaled mutation supersedes the barrier or explicit targeted recovery resolves the state. The local-only path also refuses if later bytes changed.',
  },
};

async function checkRegisteredRecoveryContracts(runtimeUrl, metadata) {
  const assert = (await import('node:assert/strict')).default;
  const { Type } = await import('typebox');
  const { Value } = await import('typebox/value');
  const { default: runtime } = await import(runtimeUrl);

  const expected = {
    recover_worktree: Type.Object({
      action: Type.Union([Type.Literal('delete_untracked'), Type.Literal('revert_tracked')]),
      path: Type.String({ minLength: 1, maxLength: 1000 }),
      expected_files: Type.Array(Type.String(), { maxItems: 200 }),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }),
    undo_mutation: Type.Object({
      mutation_id: Type.String({ minLength: 1, maxLength: 80 }),
      expected_files: Type.Array(Type.String(), { maxItems: 200 }),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }),
    rollback_last_mutation: Type.Object({
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }),
  };

  const registered = [];
  const pi = {
    registerTool(tool) { registered.push(tool); },
    on() {}, appendEntry() {},
    events: { on() {}, emit() {} },
    getActiveTools() { return []; },
    setActiveTools() {},
    getAllTools() { return registered.map(tool => ({ name: tool.name })); },
    sendUserMessage() {},
  };
  runtime(pi);
  const recoveryNames = registered
    .map(tool => tool.name)
    .filter(name => Object.hasOwn(expected, name));
  assert.deepEqual(recoveryNames,
    ['recover_worktree', 'undo_mutation', 'rollback_last_mutation'],
    'recovery tools remain registered once each and in the same order');

  const byName = new Map(registered.map(tool => [tool.name, tool]));
  for (const [name, golden] of Object.entries(expected)) {
    const tool = byName.get(name);
    assert.ok(tool, name + ' must be registered');
    assert.equal(tool.label, metadata[name].label, name + ' label');
    assert.equal(tool.description, metadata[name].description, name + ' description');
    assert.equal(typeof tool.execute, 'function', name + ' registered executor');
    assert.equal(JSON.stringify(tool.parameters), JSON.stringify(golden),
      name + ' exact serialized provider contract including key, union and metadata order');
    assert.deepEqual(Object.keys(tool.parameters.properties), Object.keys(golden.properties),
      name + ' property order');
    assert.deepEqual(tool.parameters.required, golden.required,
      name + ' required field ordering');
    assert.deepEqual(tool.parameters.required, Object.keys(golden.properties),
      name + ' all recovery arguments are required');
  }

  const recover = { action: 'delete_untracked', path: 'src/file.txt', expected_files: [], reason: 'cleanup' };
  const undo = { mutation_id: 'mut-1', expected_files: [], reason: 'undo' };
  const rollback = { reason: 'rollback' };
  const cases = {
    recover_worktree: [
      [recover, true],
      [{ ...recover, action: 'revert_tracked' }, true],
      [{ ...recover, action: 'delete' }, false],
      [{ ...recover, path: '' }, false],
      [{ ...recover, path: 'p'.repeat(1000) }, true],
      [{ ...recover, path: 'p'.repeat(1001) }, false],
      [{ ...recover, expected_files: Array(200).fill('file') }, true],
      [{ ...recover, expected_files: Array(201).fill('file') }, false],
      [{ ...recover, expected_files: [''] }, true],
      [{ ...recover, expected_files: ['a', 42] }, false],
      [{ ...recover, reason: 'r'.repeat(500) }, true],
      [{ ...recover, reason: '' }, false],
      [{ ...recover, reason: 'r'.repeat(501) }, false],
      [{ ...recover, expected_files: 'not-an-array' }, false],
      [{ path: 'src/file.txt', expected_files: [], reason: 'cleanup' }, false],
      [{ action: 'delete_untracked', expected_files: [], reason: 'cleanup' }, false],
      [{ action: 'delete_untracked', path: 'src/file.txt', reason: 'cleanup' }, false],
      [{ action: 'delete_untracked', path: 'src/file.txt', expected_files: [] }, false],
    ],
    undo_mutation: [
      [undo, true],
      [{ ...undo, mutation_id: 'x'.repeat(80) }, true],
      [{ ...undo, mutation_id: '' }, false],
      [{ ...undo, mutation_id: 'x'.repeat(81) }, false],
      [{ ...undo, expected_files: Array(200).fill('a') }, true],
      [{ ...undo, expected_files: Array(201).fill('a') }, false],
      [{ ...undo, expected_files: [''] }, true],
      [{ ...undo, expected_files: [null] }, false],
      [{ ...undo, reason: 'x'.repeat(500) }, true],
      [{ ...undo, reason: '' }, false],
      [{ ...undo, reason: 'x'.repeat(501) }, false],
      [{ expected_files: [], reason: 'undo' }, false],
      [{ mutation_id: 'mut-1', reason: 'undo' }, false],
      [{ mutation_id: 'mut-1', expected_files: [] }, false],
    ],
    rollback_last_mutation: [
      [rollback, true],
      [{ reason: 'x'.repeat(500) }, true],
      [{ reason: '' }, false],
      [{ reason: 'x'.repeat(501) }, false],
      [{}, false],
      [{ reason: 123 }, false],
    ],
  };
  for (const [name, values] of Object.entries(cases)) {
    for (const [value, valid] of values) {
      assert.equal(Value.Check(byName.get(name).parameters, value), valid,
        name + ' boundary ' + JSON.stringify(value).slice(0, 120));
    }
  }
}

test('registered recovery tool TypeBox contracts remain unchanged (#775)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-recovery-typebox-'));
  try {
    const loader = writeTypeboxLoader(dir);
    const source = [
      "import { register } from 'node:module';",
      "import { pathToFileURL } from 'node:url';",
      'register(pathToFileURL(' + JSON.stringify(loader) + '), import.meta.url);',
      'await (' + checkRegisteredRecoveryContracts.toString() + ')(' + JSON.stringify(RUNTIME_SCHEMA_URL) + ', ' + JSON.stringify(EXPECTED_RECOVERY_TOOL_METADATA) + ');',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PI_STAGE: 'implementer', PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
