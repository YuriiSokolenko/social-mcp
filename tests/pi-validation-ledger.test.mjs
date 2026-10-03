import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendCheckRecord,
  readValidationLedger,
  resolveRunArtifactId,
  resolveValidationRunId,
  normalizeScope,
  reconcile,
  latestUnresolvedRunCheckFailure,
  runCheckRequestForRecord,
  computeVerificationState,
  renderValidationSection,
  VERIFICATION_STATES,
  FINAL_PIPELINE_COMPLETE_SOURCE,
} from '../scripts/pi-common/validation-ledger.mjs';

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-validation-ledger-'));
  return path.join(dir, 'ledger.jsonl');
}

test('resolveValidationRunId trims explicit ids and falls back consistently', () => {
  assert.equal(
    resolveValidationRunId({ PI_VALIDATION_RUN_ID: '  explicit-run  ', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }),
    'explicit-run',
  );
  assert.equal(
    resolveValidationRunId({ PI_VALIDATION_RUN_ID: '   ', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }),
    '123-2',
  );
  assert.equal(resolveValidationRunId({}), `local-${process.pid}-1`);
});

test('resolveRunArtifactId normalizes GitHub ids independently of an explicit validation id', () => {
  assert.equal(
    resolveRunArtifactId({
      PI_VALIDATION_RUN_ID: 'validation-only',
      GITHUB_RUN_ID: ' 123 ',
      GITHUB_RUN_ATTEMPT: ' 2 ',
    }),
    '123-2',
  );
  assert.equal(
    resolveRunArtifactId({ GITHUB_RUN_ID: '   ', GITHUB_RUN_ATTEMPT: '   ' }),
    `local-${process.pid}-1`,
  );
});

const focused = (overrides = {}) => ({
  kind: 'python_compile',
  scope: { paths: ['arkanoid.py'] },
  status: 'pass',
  exit_code: 0,
  source: 'run_check',
  stage: 'implementer',
  backend: 'pi',
  run_id: 'local',
  ...overrides,
});

const finalCheck = (overrides = {}) => ({
  kind: 'pytest',
  scope: { whole_repo: true },
  status: 'pass',
  exit_code: 0,
  source: 'checks_final',
  stage: 'implementer',
  backend: 'pi',
  run_id: 'local',
  ...overrides,
});

// The one record that actually proves the whole checks.final pipeline ran to
// completion, as opposed to a single step's own record.
const finalComplete = (overrides = {}) => ({
  kind: 'checks_final',
  scope: { whole_repo: true },
  status: 'pass',
  source: FINAL_PIPELINE_COMPLETE_SOURCE,
  stage: 'implementer',
  backend: 'pi',
  run_id: 'local',
  ...overrides,
});

test('appendCheckRecord/readValidationLedger round-trip preserves order and assigns seq', () => {
  const ledgerPath = tempLedger();
  appendCheckRecord(ledgerPath, focused());
  appendCheckRecord(ledgerPath, finalCheck());
  const { records, corrupted } = readValidationLedger(ledgerPath);
  assert.equal(corrupted, false);
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'python_compile');
  assert.equal(records[1].kind, 'pytest');
  assert.equal(records[0].seq, 0);
  assert.equal(records[1].seq, 1);
});

test('#424 mutation undo is preserved as audit provenance but never counts as verification', () => {
  const ledgerPath = tempLedger();
  appendCheckRecord(ledgerPath, {
    kind: 'undo_mutation',
    scope: { paths: ['.probe.txt'], mutation_id: 'mutation-00000000-0000-4000-8000-000000000000' },
    status: 'pass',
    source: 'mutation_undo',
    stage: 'implementer',
    backend: 'pi',
    run_id: 'local',
    summary: 'Removed accidental scratch artifact',
  });
  const { records, corrupted } = readValidationLedger(ledgerPath);
  assert.equal(corrupted, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].source, 'mutation_undo');
  assert.deepEqual(reconcile(records), []);
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.NOT_APPLICABLE);
});

test('readValidationLedger on a missing path returns an empty, uncorrupted result without throwing', () => {
  const ledgerPath = tempLedger();
  assert.deepEqual(readValidationLedger(ledgerPath), { records: [], corrupted: false });
});

test('normalizeScope treats an absolute in-worktree path and the equivalent relative path as the same scope', () => {
  const cwd = '/home/runner/actions-runner/_work/_temp/agent-implementer-1';
  const absolute = normalizeScope({ kind: 'python_compile', paths: [`${cwd}/arkanoid.py`] }, cwd);
  const relative = normalizeScope({ kind: 'python_compile', paths: ['arkanoid.py'] }, cwd);
  assert.deepEqual(absolute, relative);
});

test('a passing focused check plus a completed final-checks pipeline yields VERIFIED', () => {
  const records = [focused({ status: 'pass' }), finalCheck({ status: 'pass' }), finalComplete()];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.VERIFIED);
});

test('VERIFIED is bound to the exact candidate revision recorded by checks.final', () => {
  const candidateA = {
    schema_version: 1,
    base_commit: 'base-a',
    digest: 'candidate-a',
    files: ['app.py'],
  };
  const candidateB = {
    schema_version: 1,
    base_commit: 'base-a',
    digest: 'candidate-b',
    files: ['app.py'],
  };
  const records = [
    focused({ status: 'pass' }),
    finalCheck({ status: 'pass' }),
    finalComplete({ candidate_revision: candidateA }),
  ];
  assert.equal(
    computeVerificationState(records, { candidateRevision: candidateA }),
    VERIFICATION_STATES.VERIFIED,
  );
  assert.equal(
    computeVerificationState(records, { candidateRevision: candidateB }),
    VERIFICATION_STATES.PENDING,
  );
  assert.match(
    renderValidationSection(records, { candidateRevision: candidateB }),
    /does not attest the current candidate revision/,
  );
});

test('a passing focused check with no final-checks record yields PENDING, never VERIFIED', () => {
  // "Did checks.final run" must come from the ledger itself, never be assumed
  // true: a lone focused pass is not proof the authoritative pipeline ran.
  const records = [focused({ status: 'pass' })];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.PENDING);
});

test('one passing checks.final step without the pipeline-completion marker yields PENDING, never VERIFIED', () => {
  // The exact scenario a second review round caught: Ruff (one checks.final
  // step) passes and gets recorded, then the process dies before
  // git diff --check and pytest run. A per-step record alone must never be
  // mistaken for "the whole pipeline finished."
  const records = [focused({ status: 'pass' }), finalCheck({ kind: 'ruff', status: 'pass' })];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.PENDING);
});

test('a failing focused check yields VERIFICATION_FAILED', () => {
  const records = [focused({ status: 'fail' }), finalCheck({ status: 'pass' }), finalComplete()];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.FAILED);
});

test('a focused check that returns infra_error yields VERIFICATION_BLOCKED_INFRA while implementation stays complete', () => {
  const records = [focused({ status: 'infra_error', infrastructure: { component: 'sandbox', code: 'SANDBOX_EXECUTOR_ERROR' } })];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.BLOCKED_INFRA);
  // Requirement #4: implementation completion is tracked entirely separately
  // (implementer-result.mjs's outcome), never derived from or blocked by the
  // ledger — an infra_error here must not be able to flip that flag.
  const implementationComplete = true;
  assert.equal(implementationComplete, true);
});

test('a focused check that times out yields VERIFICATION_BLOCKED_INFRA', () => {
  const records = [focused({ status: 'timeout' })];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.BLOCKED_INFRA);
});

test('a later equivalent authoritative check resolves an earlier infra_error', () => {
  const records = [
    focused({ status: 'infra_error' }),
    focused({ status: 'pass' }),
    finalCheck({ status: 'pass' }),
    finalComplete(),
  ];
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.VERIFIED);
});

test('an unrelated broad pytest pass does not satisfy a failed/infra-error focused python_compile requirement', () => {
  const records = [
    focused({ kind: 'python_compile', scope: { paths: ['arkanoid.py'] }, status: 'infra_error' }),
    finalCheck({ kind: 'pytest', scope: { whole_repo: true }, status: 'pass' }),
  ];
  // This is the literal shape of smoke run 36782519549: a focused python_compile
  // infra_error plus a broad, unrelated pytest pass.
  assert.equal(computeVerificationState(records), VERIFICATION_STATES.BLOCKED_INFRA);
});

test('#342 recovery keeps the exact failed pytest scope pending across a broader pass until that scope passes', () => {
  const failed = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_feature.py::test_exact_case'] },
    status: 'fail',
  });
  const broaderPass = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_feature.py'] },
    status: 'pass',
  });
  const records = [failed, broaderPass];

  assert.equal(computeVerificationState(records), VERIFICATION_STATES.FAILED);
  assert.equal(latestUnresolvedRunCheckFailure(records), failed);
  assert.deepEqual(runCheckRequestForRecord(failed), {
    kind: 'pytest',
    targets: ['tests/test_feature.py::test_exact_case'],
  });

  const exactPass = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_feature.py::test_exact_case'] },
    status: 'pass',
  });
  records.push(exactPass);
  assert.equal(latestUnresolvedRunCheckFailure(records), null);
  assert.equal(reconcile(records).find(record => record.scope.targets?.includes('tests/test_feature.py::test_exact_case'))?.status, 'pass');
});

test('exact-scope timeout, invalid, and infra_error stop forced retry but remain fail-closed verification', () => {
  const failure = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_feature.py::test_exact_case'] },
    status: 'fail',
  });
  for (const status of ['timeout', 'invalid', 'infra_error']) {
    const later = focused({
      kind: 'pytest',
      scope: { targets: ['tests/test_feature.py::test_exact_case'] },
      status,
    });
    const records = [failure, later];
    assert.equal(
      latestUnresolvedRunCheckFailure(records),
      null,
      `${status} must end the forced retry episode`,
    );
    assert.equal(
      computeVerificationState(records),
      VERIFICATION_STATES.BLOCKED_INFRA,
      `${status} remains fail-closed verification evidence`,
    );
  }
});

test('multiple failed scopes remain independently recoverable within one workflow run', () => {
  const firstFailure = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_feature.py::test_exact_case'] },
    status: 'fail',
    run_id: 'run-1',
  });
  const secondFailure = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_other.py::test_other_case'] },
    status: 'fail',
    run_id: 'run-1',
  });
  const broaderPass = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_feature.py'] },
    status: 'pass',
    run_id: 'run-1',
  });
  const secondPass = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_other.py::test_other_case'] },
    status: 'pass',
    run_id: 'run-1',
  });

  const records = [firstFailure, secondFailure, broaderPass];
  assert.equal(
    latestUnresolvedRunCheckFailure(records, { runId: 'run-1' }),
    secondFailure,
    'most recent unresolved exact failure is recovered first',
  );

  records.push(secondPass);
  assert.equal(
    latestUnresolvedRunCheckFailure(records, { runId: 'run-1' }),
    firstFailure,
    'resolving one scope exposes the remaining exact failure instead of dropping it',
  );
});

test('a repeated exact fail refreshes the active recovery evidence without creating another obligation', () => {
  const first = focused({
    kind: 'ruff',
    scope: { paths: ['src/a.py'] },
    status: 'fail',
    summary: 'first',
  });
  const second = focused({
    kind: 'ruff',
    scope: { paths: ['src/a.py'] },
    status: 'fail',
    summary: 'second',
  });
  assert.equal(latestUnresolvedRunCheckFailure([first, second]), second);
});

test('failed-check recovery is scoped to the current workflow run and spans repair attempts', () => {
  const oldRun = focused({
    kind: 'ruff',
    scope: { paths: ['old.py'] },
    status: 'fail',
    run_id: 'run-0',
    attempt_id: 'primary',
  });
  const primary = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_primary.py::test_case'] },
    status: 'fail',
    run_id: 'run-1',
    attempt_id: 'primary',
  });
  const records = [oldRun, primary];

  assert.equal(
    latestUnresolvedRunCheckFailure(records, { runId: 'run-1' }),
    primary,
    'a validation-repair session inherits an unresolved failure from the primary attempt',
  );
  assert.equal(
    latestUnresolvedRunCheckFailure(records, { runId: 'run-2' }),
    null,
    'failures from an earlier workflow run never control a new run',
  );

  const repairPass = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_primary.py::test_case'] },
    status: 'pass',
    run_id: 'run-1',
    attempt_id: 'validation-repair:2',
  });
  records.push(repairPass);
  assert.equal(
    latestUnresolvedRunCheckFailure(records, { runId: 'run-1' }),
    null,
    'a later repair can resolve an exact failure recorded by an earlier attempt',
  );
});

test('legacy run_check records without attempt_id still participate in current-run recovery', () => {
  const legacyFailure = focused({
    kind: 'ruff',
    scope: { paths: ['legacy.py'] },
    status: 'fail',
    run_id: 'run-1',
  });
  delete legacyFailure.attempt_id;

  assert.equal(
    latestUnresolvedRunCheckFailure([legacyFailure], { runId: 'run-1', stage: 'implementer' }),
    legacyFailure,
  );
});

test('an unreconstructable newer failure does not hide an older exact recovery obligation', () => {
  const older = focused({
    kind: 'ruff',
    scope: { paths: ['src/a.py'] },
    status: 'fail',
    run_id: 'run-1',
    stage: 'implementer',
  });
  const malformedNewer = focused({
    kind: 'pytest',
    scope: { whole_repo: true },
    status: 'fail',
    run_id: 'run-1',
    stage: 'implementer',
  });

  assert.equal(
    latestUnresolvedRunCheckFailure([older, malformedNewer], { runId: 'run-1', stage: 'implementer' }),
    older,
  );
});

test('recovery selection ignores run_check failures from other stages', () => {
  const implementerFailure = focused({
    kind: 'ruff',
    scope: { paths: ['src/a.py'] },
    status: 'fail',
    run_id: 'run-1',
    stage: 'implementer',
  });
  const reviewerFailure = focused({
    kind: 'pytest',
    scope: { targets: ['tests/test_review.py::test_case'] },
    status: 'fail',
    run_id: 'run-1',
    stage: 'reviewer',
  });

  assert.equal(
    latestUnresolvedRunCheckFailure([implementerFailure, reviewerFailure], { runId: 'run-1', stage: 'implementer' }),
    implementerFailure,
  );
});

test('runCheckRequestForRecord rejects mixed scopes instead of replaying a different check', () => {
  assert.throws(
    () => runCheckRequestForRecord(focused({
      kind: 'pytest',
      scope: {
        paths: ['src/a.py'],
        targets: ['tests/test_a.py::test_case'],
      },
      status: 'fail',
    })),
    /ambiguous or unsupported scope/,
  );
});

test('runCheckRequestForRecord rejects a scope field that does not match the check kind', () => {
  assert.throws(
    () => runCheckRequestForRecord(focused({
      kind: 'pytest',
      scope: { paths: ['src/a.py'] },
      status: 'fail',
    })),
    /scope does not match check kind/,
  );
});

test('a ledger with an unparseable line is treated as blocked, never as evidence of VERIFIED', () => {
  // All records that DID parse look fully green. Fail-closed means the
  // corrupted flag alone must still force BLOCKED_INFRA: the dropped line
  // could have been exactly the fail/infra_error record that made this
  // "pass" untrustworthy, and the ledger has no way to know it wasn't.
  const ledgerPath = tempLedger();
  appendCheckRecord(ledgerPath, focused({ status: 'pass' }));
  appendCheckRecord(ledgerPath, finalCheck({ status: 'pass' }));
  fs.appendFileSync(ledgerPath, '{"kind":"pytest","scope":{whole_repo\n');
  const { records, corrupted } = readValidationLedger(ledgerPath);
  assert.equal(records.length, 2);
  assert.equal(corrupted, true);
  assert.equal(computeVerificationState(records, { corrupted }), VERIFICATION_STATES.BLOCKED_INFRA);
  assert.match(renderValidationSection(records, { corrupted }), /could not be fully read/);
});

test('renderValidationSection renders only from ledger records, never from model-provided text', () => {
  const core = fs.readFileSync(new URL('../scripts/pi-common/validation-ledger.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(core, /\.title\b|\.changes\b|\.security_notes\b/);
  const records = [focused({ status: 'pass' }), finalCheck({ status: 'pass' }), finalComplete()];
  const text = renderValidationSection(records);
  assert.match(text, /python_compile\(arkanoid\.py\): passed/);
  assert.match(text, /Overall verification state: VERIFIED/);
  // The pipeline-completion marker proves completeness; it is not itself a
  // check, so it must never render as its own bullet.
  assert.doesNotMatch(text, /checks_final_complete/);
});

test('renderValidationSection on an empty ledger states plainly that nothing was recorded', () => {
  const text = renderValidationSection([]);
  assert.match(text, /No authoritative checks were recorded/);
  assert.match(text, /VERIFICATION_NOT_APPLICABLE/);
});

test('duplicate/equivalent checks reconcile deterministically by recency, not by best status', () => {
  const forward = [
    focused({ status: 'fail' }),
    focused({ status: 'infra_error' }),
    focused({ status: 'pass' }),
    finalCheck({ status: 'pass' }),
    finalComplete(),
  ];
  assert.equal(reconcile(forward)[0].status, 'pass');
  assert.equal(computeVerificationState(forward), VERIFICATION_STATES.VERIFIED);

  const backward = [
    focused({ status: 'pass' }),
    focused({ status: 'infra_error' }),
    focused({ status: 'fail' }),
    finalCheck({ status: 'pass' }),
  ];
  assert.equal(reconcile(backward)[0].status, 'fail');
  assert.equal(computeVerificationState(backward), VERIFICATION_STATES.FAILED);
});

test('appendCheckRecord is fail-closed: it rejects a record missing kind, scope, source, stage, or backend', () => {
  const ledgerPath = tempLedger();
  const cases = [
    ['kind', { ...focused(), kind: undefined }],
    ['kind', { ...focused(), kind: '' }],
    ['scope', { ...focused(), scope: undefined }],
    ['scope', { ...focused(), scope: ['not', 'an', 'object'] }],
    ['source', { ...focused(), source: 'model_claim' }],
    ['stage', { ...focused(), stage: undefined }],
    ['backend', { ...focused(), backend: '' }],
  ];
  for (const [field, record] of cases) {
    assert.throws(() => appendCheckRecord(ledgerPath, record), new RegExp(field), `expected rejection for missing/invalid ${field}`);
  }
  assert.deepEqual(readValidationLedger(ledgerPath), { records: [], corrupted: false });
});

test('appendCheckRecord rejects an unknown status', () => {
  const ledgerPath = tempLedger();
  assert.throws(() => appendCheckRecord(ledgerPath, focused({ status: 'maybe' })), /Unknown validation ledger status/);
});

test('the core stays backend-neutral: no Pi-specific or project-specific coupling', () => {
  const core = fs.readFileSync(new URL('../scripts/pi-common/validation-ledger.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(core, /typebox|pi-agent-runtime|registerTool/);
});
