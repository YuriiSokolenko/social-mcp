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

function runSuccessfulSubmit({ modeEnv, params, files = {}, acceptedFiles = Object.keys(files), expectedError = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-success-'));
  const work = cleanGitWorktree(root);
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
      const pi = {
        registerTool(value) { if (value.name === 'submit_result') tool = value; },
        appendEntry(type, data) { entries.push({ type, data }); },
        on() {},
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
      try {
        const result = await tool.execute('submit', ${JSON.stringify(params)});
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

test('submit_result advertises a flat object schema and runtime returns structured missing-field errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-result-contract-'));
  try {
    const program = `
      import assert from 'node:assert/strict';
      const {
        default: registerResultTool,
        CHANGED_PUBLICATION_FIELDS,
      } = await import(${JSON.stringify(RESULT_TOOL_URL)});

      let tool;
      let settle;
      const pi = {
        registerTool(value) { if (value.name === 'submit_result') tool = value; },
        appendEntry() {},
        getActiveTools() { return ['submit_result']; },
        on(event, fn) { if (event === 'agent_before_settle') settle = fn; },
      };
      registerResultTool(pi);

      assert.equal(tool.parameters.type, 'object');
      assert.equal(tool.parameters.anyOf, undefined);
      assert.deepEqual(Object.keys(tool.parameters.properties), [
        'title', 'summary', 'changes', 'already_satisfied',
        'blocked_reason', 'security_notes', 'limitations',
      ]);
      for (const field of CHANGED_PUBLICATION_FIELDS) {
        assert.match(
          tool.parameters.properties[field].description,
          /Required for fresh changed work/,
          field + ': publication requirement must be advertised by the tool schema',
        );
      }
      const complete = {
        title: 'Contract fix',
        summary: 'Strengthen submit_result publication metadata.',
        changes: ['Require publication metadata'],
        files: '["scripts/pi-implementer-result-tool.mjs"]', // legacy malformed field is ignored
        security_notes: 'No security impact.',
        limitations: 'None.',
      };
      async function expectMissing(input, expected) {
        await assert.rejects(
          tool.execute('invalid', input),
          error => {
            assert.deepEqual(JSON.parse(error.message), {
              code: 'missing_publication_fields',
              missing_fields: expected,
            });
            return true;
          },
        );
      }

      for (const field of CHANGED_PUBLICATION_FIELDS) {
        const invalid = { ...complete };
        delete invalid[field];
        await expectMissing(invalid, [field]);
      }

      for (const field of ['title', 'summary', 'security_notes', 'limitations']) {
        await expectMissing({ ...complete, [field]: '   ' }, [field]);
      }
      await expectMissing({ ...complete, changes: [''] }, ['changes']);
      assert.equal(tool.parameters.properties.files, undefined, 'file list is not requested from the model');

      const multi = { ...complete };
      delete multi.title;
      delete multi.changes;
      delete multi.security_notes;
      await expectMissing(multi, ['title', 'changes', 'security_notes']);

      const nudge = settle();
      assert.match(nudge.entries[0].content, /missing publication fields/);
      assert.match(nudge.entries[0].content, /retry submit_result immediately/);
      assert.match(nudge.entries[0].content, /CURRENTLY EXPOSED TOOLS.*submit_result/);
      assert.doesNotMatch(nudge.entries[0].content, /need_more_evidence/, 'hidden blocker is not advertised by the terminal nudge');
      assert.match(tool.description, /runtime validates that complete publication contract/);
    `;
    const child = runProgram({
      dir,
      program,
      env: {
        PI_RESUME_ACTIVE: 'false',
        PI_VALIDATION_REPAIR: 'false',
      },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real failed submit_result call leaves ProgressController on the terminal retry path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-result-retry-'));
  try {
    const progressUrl = new URL('../scripts/pi-common/progress-controller.mjs', import.meta.url).href;
    const configUrl = new URL('../scripts/pi-common/stage-config.mjs', import.meta.url).href;
    const program = `
      import assert from 'node:assert/strict';
      const { default: registerResultTool } = await import(${JSON.stringify(RESULT_TOOL_URL)});
      const { ProgressController } = await import(${JSON.stringify(progressUrl)});
      const { stageConfig } = await import(${JSON.stringify(configUrl)});

      let tool;
      const pi = {
        registerTool(value) { if (value.name === 'submit_result') tool = value; },
        appendEntry() {},
        on() {},
      };
      registerResultTool(pi);

      const state = new ProgressController(stageConfig('implementer'), {});
      state.onTurnStart(0);
      state.applyPreparedImplementation({ status: 'prepared', plan: ['plan'], complexity: 'nontrivial', evidenceBudget: 0, largeMutation: false, reason: 'test' });
      assert.equal(state.productiveProgressState(), 'action_required');

      const incomplete = { title: 'Missing publication metadata' };
      assert.equal(state.checkToolCall('submit_result', incomplete), undefined);
      let failed = false;
      try {
        await tool.execute('submit-invalid', incomplete);
      } catch (error) {
        failed = true;
        assert.equal(JSON.parse(error.message).code, 'missing_publication_fields');
      }
      assert.equal(failed, true);
      state.onToolExecutionEnd('submit_result', true);
      assert.equal(state.productiveProgressState(), 'action_required');

      assert.equal(
        state.checkToolCall('read', { path: 'README.md' }),
        undefined,
        '#540 fresh Main keeps direct repository inspection available after a failed submit',
      );
      assert.equal(state.productiveProgressState(), 'action_required');

      const corrected = {
        title: 'Contract fix',
        summary: 'Complete publication metadata.',
        changes: ['Require publication metadata'],
        files: ['scripts/pi-implementer-result-tool.mjs'],
        security_notes: 'No security impact.',
        limitations: 'None.',
      };
      assert.equal(state.checkToolCall('submit_result', corrected), undefined);
    `;
    const child = runProgram({
      dir,
      program,
      env: {
        PI_RESUME_ACTIVE: 'false',
        PI_VALIDATION_REPAIR: 'false',
      },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registration snapshots fresh mode instead of re-reading resume env at execute time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-result-mode-snapshot-'));
  try {
    const program = `
      import assert from 'node:assert/strict';
      const { default: registerResultTool } = await import(${JSON.stringify(RESULT_TOOL_URL)});
      let tool;
      const pi = {
        registerTool(value) { if (value.name === 'submit_result') tool = value; },
        appendEntry() {},
        on() {},
      };
      registerResultTool(pi);
      process.env.PI_RESUME_ACTIVE = 'true';
      await assert.rejects(
        tool.execute('still-fresh', {}),
        error => {
          assert.equal(JSON.parse(error.message).code, 'missing_publication_fields');
          return true;
        },
      );
    `;
    const child = runProgram({
      dir,
      program,
      env: {
        PI_RESUME_ACTIVE: 'false',
        PI_VALIDATION_REPAIR: 'false',
      },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
});

test('fresh already_satisfied and blocked result shapes still execute successfully', () => {
  const satisfied = runSuccessfulSubmit({
    modeEnv: { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'false' },
    params: { already_satisfied: true, changes: [] },
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
        tool.execute('submit', {
          title: 'Feature',
          summary: 'Implement feature.',
          changes: ['Add feature'],
          files: ['feature.py'],
          security_notes: 'No security impact.',
          limitations: 'None.',
        }),
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
        PI_RESUME_ACTIVE: 'false',
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
  const params = {
    title: 'Three-file change',
    summary: 'Use runtime-owned publication files.',
    changes: ['Add feature and test'],
    files: '["src/app.py","src/helper.py"]',
    security_notes: 'No security impact.',
    limitations: 'None.',
  };
  const allowed = runSuccessfulSubmit({
    modeEnv: {},
    params,
    files: three,
  });
  assert.deepEqual(allowed.metadata.files, Object.keys(three).sort());
  assert.deepEqual(allowed.metadata.changes, ['Add feature and test']);
  assert.equal(allowed.metadata.accepted_scope.accepted.length, 3);

  const rejected = runSuccessfulSubmit({
    modeEnv: {},
    params: { ...params, files: ['src/app.py', 'src/helper.py', 'tests/test_app.py'] },
    files: three,
    acceptedFiles: ['src/app.py', 'src/helper.py'],
    expectedError: /accepted_scope_violation/,
  });
  assert.match(rejected.output.error, /tests\\/test_app.py/);

  runSuccessfulSubmit({
    modeEnv: {},
    params,
    expectedError: /at least one concrete change is required/,
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
    assert.match(child.stdout, /PREPARED_OUTPUTS_REQUIRED/);

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
