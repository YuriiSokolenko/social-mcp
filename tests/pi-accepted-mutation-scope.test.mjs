import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  assertAcceptedMutationScope,
  assertMutationPathAuthorized,
  initializeMutationScope,
  mutationScopeReceipt,
  registerMutationScope,
} from '../scripts/pi-common/accepted-mutation-scope.mjs';
import { validateAcceptedScopeMetadata, validateFinalProductTree } from '../scripts/pi-common/finalize-product-tree.mjs';
import { writeImplementerResult } from '../scripts/pi-common/implementer-result.mjs';

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-accepted-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Scope Test');
  git('config', 'user.email', 'scope@example.invalid');
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'old.py'), 'value = 1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
  return { root, git };
}

test('publishable scope must be accepted before the path becomes changed', t => {
  const { root } = repo(t);
  initializeMutationScope(root, {});

  registerMutationScope({
    cwd: root,
    paths: ['intended.py'],
    disposition: 'publishable',
    rationale: 'Issue requires the intended implementation module.',
    env: {},
  });
  assert.deepEqual(
    assertMutationPathAuthorized({ cwd: root, requestedPath: 'intended.py', env: {} }),
    { path: 'intended.py', disposition: 'publishable' },
  );

  fs.writeFileSync(path.join(root, 'intended.py'), 'value = 2\n');
  fs.writeFileSync(path.join(root, '.pi-tmp-placeholder.py'), 'scratch = True\n');

  assert.throws(
    () => registerMutationScope({
      cwd: root,
      paths: ['.pi-tmp-placeholder.py'],
      disposition: 'publishable',
      rationale: 'Include the accidental scratch file only to match the final diff.',
      env: {},
    }),
    error => {
      const diagnostic = JSON.parse(error.message);
      assert.equal(diagnostic.code, 'scope_retroactive_publishable_rejected');
      assert.deepEqual(diagnostic.paths, ['.pi-tmp-placeholder.py']);
      return true;
    },
  );

  assert.throws(
    () => assertAcceptedMutationScope({
      cwd: root,
      receipt: mutationScopeReceipt(root, {}),
    }),
    error => {
      const diagnostic = JSON.parse(error.message);
      assert.equal(diagnostic.code, 'accepted_scope_violation');
      assert.deepEqual(diagnostic.unexpected_paths, ['.pi-tmp-placeholder.py']);
      return true;
    },
  );
});

test('temporary scratch can be registered after discovery but must be removed before publication', t => {
  const { root } = repo(t);
  initializeMutationScope(root, {});
  fs.writeFileSync(path.join(root, '.probe.txt'), 'probe\n');

  registerMutationScope({
    cwd: root,
    paths: ['.probe.txt'],
    disposition: 'temporary',
    rationale: 'Temporary local probe used only during implementation.',
    env: {},
  });

  assert.deepEqual(
    assertMutationPathAuthorized({ cwd: root, requestedPath: '.probe.txt', env: {} }),
    { path: '.probe.txt', disposition: 'temporary' },
  );
  assert.throws(
    () => assertAcceptedMutationScope({ cwd: root, receipt: mutationScopeReceipt(root, {}) }),
    error => JSON.parse(error.message).temporary_paths.includes('.probe.txt'),
  );

  fs.rmSync(path.join(root, '.probe.txt'));
  assert.deepEqual(
    assertAcceptedMutationScope({ cwd: root, receipt: mutationScopeReceipt(root, {}) }),
    [],
  );
});

test('restored baseline is tracked separately and cannot be promoted retroactively', t => {
  const { root } = repo(t);
  fs.writeFileSync(path.join(root, 'restored.py'), 'saved work\n');

  const state = initializeMutationScope(root, {});
  assert.ok(state.baseline.has('restored.py'));
  assert.deepEqual(
    assertMutationPathAuthorized({ cwd: root, requestedPath: 'restored.py', env: {} }),
    { path: 'restored.py', disposition: 'baseline-recovery' },
  );

  assert.throws(
    () => registerMutationScope({
      cwd: root,
      paths: ['restored.py'],
      disposition: 'publishable',
      rationale: 'Attempt to promote restored work after it was already changed.',
      env: {},
    }),
    error => JSON.parse(error.message).code === 'scope_retroactive_publishable_rejected',
  );

  assert.throws(
    () => assertAcceptedMutationScope({ cwd: root, receipt: mutationScopeReceipt(root, {}) }),
    error => {
      const diagnostic = JSON.parse(error.message);
      assert.deepEqual(diagnostic.baseline_unaccepted_paths, ['restored.py']);
      return true;
    },
  );

  fs.rmSync(path.join(root, 'restored.py'));
  assert.deepEqual(assertAcceptedMutationScope({ cwd: root, receipt: mutationScopeReceipt(root, {}) }), []);
});

test('trusted restored receipt preserves intentional scope while still rejecting unrelated restored paths', t => {
  const first = repo(t);
  initializeMutationScope(first.root, {});
  registerMutationScope({
    cwd: first.root,
    paths: ['intended.py'],
    disposition: 'publishable',
    rationale: 'Issue requires this implementation module.',
    env: {},
  });
  const prior = mutationScopeReceipt(first.root, {});

  const second = repo(t);
  fs.writeFileSync(path.join(second.root, 'intended.py'), 'saved intended work\n');
  fs.writeFileSync(path.join(second.root, 'scratch.py'), 'saved accidental work\n');
  initializeMutationScope(second.root, {
    PI_ACCEPTED_MUTATION_SCOPE_STATE: JSON.stringify(prior),
  });

  assert.throws(
    () => assertAcceptedMutationScope({
      cwd: second.root,
      receipt: mutationScopeReceipt(second.root, {
        PI_ACCEPTED_MUTATION_SCOPE_STATE: JSON.stringify(prior),
      }),
    }),
    error => {
      const diagnostic = JSON.parse(error.message);
      assert.deepEqual(diagnostic.unexpected_paths, ['scratch.py']);
      assert.deepEqual(diagnostic.baseline_unaccepted_paths, ['scratch.py']);
      return true;
    },
  );

  fs.rmSync(path.join(second.root, 'scratch.py'));
  assert.deepEqual(
    assertAcceptedMutationScope({
      cwd: second.root,
      receipt: mutationScopeReceipt(second.root, {}),
    }),
    ['intended.py'],
  );
});

test('accepted deletion and rename paths remain publishable', t => {
  const { root, git } = repo(t);
  initializeMutationScope(root, {});
  registerMutationScope({
    cwd: root,
    paths: ['old.py', 'new.py', 'base.txt'],
    disposition: 'publishable',
    rationale: 'Issue requires a rename plus removal of the obsolete base file.',
    env: {},
  });

  git('mv', 'old.py', 'new.py');
  fs.rmSync(path.join(root, 'base.txt'));

  assert.deepEqual(
    assertAcceptedMutationScope({ cwd: root, receipt: mutationScopeReceipt(root, {}) }),
    ['base.txt', 'new.py', 'old.py'],
  );
});


test('scope sidecar carries child-process amendments back into an already initialized parent state', t => {
  const { root } = repo(t);
  const sidecar = path.join(root, '..', path.basename(root) + '-scope.json');
  t.after(() => fs.rmSync(sidecar, { force: true }));
  const env = { PI_ACCEPTED_MUTATION_SCOPE_FILE: sidecar };

  initializeMutationScope(root, env);
  assert.deepEqual(mutationScopeReceipt(root, env).accepted, []);

  const moduleUrl = new URL('../scripts/pi-common/accepted-mutation-scope.mjs', import.meta.url).href;
  const program = `
    const { registerMutationScope } = await import(${JSON.stringify(moduleUrl)});
    registerMutationScope({
      cwd: process.argv[1],
      paths: ['child.py'],
      disposition: 'publishable',
      rationale: 'Child coding process owns this task-related implementation file.',
      env: process.env,
    });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program, root], {
    encoding: 'utf8',
    env: { ...process.env, PI_ACCEPTED_MUTATION_SCOPE_FILE: sidecar },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);

  assert.deepEqual(mutationScopeReceipt(root, env).accepted, [{
    path: 'child.py',
    rationale: 'Child coding process owns this task-related implementation file.',
  }]);
});


test('final product validation fails closed when a changed tree has no implementer result metadata', t => {
  const { root } = repo(t);
  fs.writeFileSync(path.join(root, 'feature.py'), 'value = 1\n');

  assert.throws(
    () => validateFinalProductTree({
      cwd: root,
      ledgerPath: path.join(root, 'ledger.jsonl'),
      backend: 'pi',
      env: {},
    }),
    error => {
      const diagnostic = JSON.parse(error.message);
      assert.equal(diagnostic.code, 'accepted_scope_missing');
      assert.deepEqual(diagnostic.unexpected_paths, ['feature.py']);
      return true;
    },
  );
});


test('final product validation applies the accepted-scope gate before product checks', t => {
  const { root } = repo(t);
  const resultFile = path.join(root, '..', path.basename(root) + '-result.json');
  t.after(() => fs.rmSync(resultFile, { force: true }));

  fs.writeFileSync(path.join(root, 'feature.py'), 'value = 1\n');
  fs.writeFileSync(path.join(root, 'scratch.py'), 'scratch = True\n');
  writeImplementerResult(resultFile, {
    title: 'Feature',
    summary: 'Implement the requested feature.',
    changes: ['Add feature'],
    files: ['feature.py', 'scratch.py'],
    security_notes: 'None.',
    limitations: 'None.',
    scope_enforcement: 'predeclared',
    accepted_scope: {
      schema_version: 1,
      accepted: [{ path: 'feature.py', rationale: 'Issue requires this feature file.' }],
      temporary: [],
      baseline: [],
    },
  });

  assert.throws(
    () => validateFinalProductTree({
      cwd: root,
      ledgerPath: path.join(root, 'ledger.jsonl'),
      backend: 'pi',
      env: { PI_IMPLEMENTER_RESULT_FILE: resultFile },
    }),
    error => {
      const diagnostic = JSON.parse(error.message);
      assert.equal(diagnostic.code, 'accepted_scope_violation');
      assert.deepEqual(diagnostic.unexpected_paths, ['scratch.py']);
      return true;
    },
  );
});


test('final scope metadata gate permits the explicitly human-gated mini-swe path', t => {
  const { root } = repo(t);
  const resultFile = path.join(root, '..', path.basename(root) + '-mini-result.json');
  t.after(() => fs.rmSync(resultFile, { force: true }));
  fs.writeFileSync(path.join(root, 'mini.py'), 'value = 1\n');

  writeImplementerResult(resultFile, {
    title: 'Mini change',
    summary: 'Implement through mini-swe.',
    changes: ['Add mini.py'],
    files: ['mini.py'],
    security_notes: 'None.',
    limitations: 'Requires human gate.',
    scope_enforcement: 'unsandboxed-gated',
  });

  assert.equal(
    validateAcceptedScopeMetadata({
      cwd: root,
      base: 'origin/dev',
      env: { PI_IMPLEMENTER_RESULT_FILE: resultFile },
    }).scope_enforcement,
    'unsandboxed-gated',
  );
});
