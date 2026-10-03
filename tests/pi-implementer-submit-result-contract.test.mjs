import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';


const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULT_TOOL_URL = new URL('../scripts/pi-implementer-result-tool.mjs', import.meta.url).href;

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

function runSuccessfulSubmit({ modeEnv, params }) {
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
      let tool;
      const entries = [];
      const pi = {
        registerTool(value) { if (value.name === 'submit_result') tool = value; },
        appendEntry(type, data) { entries.push({ type, data }); },
        on() {},
      };
      registerResultTool(pi);
      const result = await tool.execute('submit', ${JSON.stringify(params)});
      console.log(JSON.stringify({ result, entries }));
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
        'title', 'summary', 'changes', 'files', 'already_satisfied',
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
        files: ['scripts/pi-implementer-result-tool.mjs'],
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
      await expectMissing({ ...complete, files: ['  '] }, ['files']);

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
      assert.equal(state.checkToolCall('prepare_implementation', {}), undefined);
      state.setComplexity('nontrivial');
      state.setEvidenceBudget(0);
      state.onToolExecutionEnd('prepare_implementation', false);
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

      const evidence = state.checkToolCall('read', { path: 'README.md' });
      assert.equal(evidence.block, true);
      assert.match(evidence.reason, /productive progress requires an action now/);

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

test('restored and validation-repair work still accept an empty submit_result payload', () => {
  const restored = runSuccessfulSubmit({
    modeEnv: { PI_RESUME_ACTIVE: 'true', PI_VALIDATION_REPAIR: 'false' },
    params: {},
  });
  assert.equal(restored.metadata.already_satisfied, true);
  assert.match(restored.metadata.summary, /replayed saved implementation/);

  const repaired = runSuccessfulSubmit({
    modeEnv: { PI_RESUME_ACTIVE: 'false', PI_VALIDATION_REPAIR: 'true' },
    params: {},
  });
  assert.equal(repaired.metadata.already_satisfied, true);
  assert.match(repaired.metadata.summary, /validation-repaired implementation/);
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
