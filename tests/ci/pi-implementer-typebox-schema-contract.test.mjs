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
