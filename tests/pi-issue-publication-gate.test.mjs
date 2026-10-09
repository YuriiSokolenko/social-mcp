import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readScript } from './helpers/resolved-source.mjs';

import {
  assertPublicationFileSet,
  isUnsandboxedBackend,
  nextLabelsForVerification,
  publicationBase,
  saveCheckpoint,
  upsertPullRequest,
} from '../scripts/pi-common/issue-publication.mjs';
import { writeImplementerResult } from '../scripts/pi-common/implementer-result.mjs';
import { PIPELINE_LABELS } from '../scripts/pi-common/state-machine.mjs';
import {
  appendCheckRecord,
  FINAL_PIPELINE_COMPLETE_SOURCE,
  VERIFICATION_STATES,
} from '../scripts/pi-common/validation-ledger.mjs';
import {
  createSuccessfulTerminalReceipt,
  writeTerminalReceiptFile,
} from '../scripts/pi-common/terminal-receipt.mjs';
import { acceptedScopeStateFromRef, mutationJournalStateFromRef } from '../scripts/pi-common/issue-worktree.mjs';
import { captureMutationSnapshot } from '../scripts/pi-common/mutation-snapshot.mjs';
import {
  encodeMutationJournalState,
  markMutationJournalLocalOnly,
  mutationJournalState,
  recordSuccessfulMutation,
  undoMutation,
} from '../scripts/pi-common/mutation-journal.mjs';
import { registerMutationScope } from '../scripts/pi-common/accepted-mutation-scope.mjs';

const TYPEBOX_STUB_LOADER = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox') return {
    url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
    shortCircuit: true,
  };
  return nextResolve(specifier, context);
}`;

function configureTestGit(git) {
  git('config', 'user.name', 'Pi Test');
  git('config', 'user.email', 'pi@example.invalid');
  git('config', 'commit.gpgsign', 'false');
}

/**
 * Regression for the exact smoke-run shape: focused run_check infra_error on
 * one path, broad checks.final passes, PR says VERIFICATION_BLOCKED_INFRA in
 * its body -- but prose alone must not be enough to let the PR progress.
 * `nextLabelsForVerification` is the durable control-plane gate: it is what
 * `upsertPullRequest` calls to decide whether to add pi:needs-human to the
 * PR itself, which both the shared PR-guard (used by Reviewer and PR Fix,
 * see pr-guard.mjs's "needs-human is a hard stop") and Merge Gate
 * (pi-auto-merge.mjs's own needs-human check) already treat as unconditional.
 */

test('a non-VERIFIED PR gets pi:needs-human added', () => {
  for (const state of [
    VERIFICATION_STATES.BLOCKED_INFRA,
    VERIFICATION_STATES.FAILED,
    VERIFICATION_STATES.PENDING,
    VERIFICATION_STATES.NOT_APPLICABLE,
  ]) {
    assert.deepEqual(nextLabelsForVerification([], state), [PIPELINE_LABELS.needsHuman]);
    assert.deepEqual(nextLabelsForVerification(['some-other-label'], state), ['some-other-label', PIPELINE_LABELS.needsHuman]);
  }
});

test('a VERIFIED PR never gets pi:needs-human added', () => {
  assert.equal(nextLabelsForVerification([], VERIFICATION_STATES.VERIFIED), null);
  assert.equal(nextLabelsForVerification(['some-other-label'], VERIFICATION_STATES.VERIFIED), null);
});

test('pi:needs-human is never added twice, and never removed once present', () => {
  const alreadyGated = [PIPELINE_LABELS.needsHuman, 'review:passed'];
  assert.equal(nextLabelsForVerification(alreadyGated, VERIFICATION_STATES.BLOCKED_INFRA), null);
  // Even a later VERIFIED run must not auto-clear it: exactly like every
  // other pi:needs-human producer in this codebase, clearing it is a human
  // action, never something this gate does for the PR author.
  assert.equal(nextLabelsForVerification(alreadyGated, VERIFICATION_STATES.VERIFIED), null);
});

/**
 * Trust-root regression: an earlier version of this gate derived trust from
 * `record.backend` inside the ledger itself -- but the ledger is exactly the
 * thing an untrusted mini-swe process can write to, so it could forge
 * `backend: 'pi'` on every record and sail through the gate. The trust input
 * must come from somewhere the implementer's own process tree can never
 * reach: the workflow_dispatch `inputs.backend` value, fixed by the Actions
 * runner before the job starts and never routed through $GITHUB_ENV. This is
 * threaded into `upsertPullRequest` as its own `backend` argument, entirely
 * independent of anything in the ledger file.
 */
test('isUnsandboxedBackend trusts only the harness-declared backend, never anything from a record', () => {
  assert.equal(isUnsandboxedBackend('pi'), false);
  assert.equal(isUnsandboxedBackend('mini-swe'), true);
  assert.equal(isUnsandboxedBackend(undefined), true);
  assert.equal(isUnsandboxedBackend(''), true);
});

test('a forged ledger where every record claims backend: pi still gets pi:needs-human, because the harness knows the real backend was mini-swe', () => {
  // This is the literal attack the ledger-derived version of this gate was
  // vulnerable to: a raw-shell mini-swe process rewriting every record's
  // `backend` field to 'pi' and every `status` to 'pass', including the
  // completion marker. The gate must not even look at that field.
  const forgedButAllPassLedgerVerificationState = VERIFICATION_STATES.VERIFIED;
  const harnessKnownBackend = 'mini-swe';
  assert.deepEqual(
    nextLabelsForVerification([], forgedButAllPassLedgerVerificationState, isUnsandboxedBackend(harnessKnownBackend)),
    [PIPELINE_LABELS.needsHuman],
  );
});

test('a VERIFIED Pi-backend run is unaffected by the backend-trust gate', () => {
  assert.equal(nextLabelsForVerification([], VERIFICATION_STATES.VERIFIED, isUnsandboxedBackend('pi')), null);
});

test('label objects in GitHub API shape (not bare strings) are handled identically', () => {
  const apiShapeLabels = [{ name: 'review:passed' }];
  assert.deepEqual(
    nextLabelsForVerification(apiShapeLabels, VERIFICATION_STATES.BLOCKED_INFRA),
    ['review:passed', PIPELINE_LABELS.needsHuman],
  );
});

test('upsertPullRequest derives trust from the backend argument, not the ledger, and returns verification_state', () => {
  const source = readScript('scripts/pi-common/issue-publication.mjs', 'utf8');
  assert.match(source, /client = githubClient\(\)/);
  assert.match(source, /const \{ api, replaceLabels \} = client;/);
  assert.match(source, /const verificationState = computeVerificationState\(ledgerRecords, \{ corrupted: ledgerCorrupted, candidateRevision \}\);/);
  assert.match(source, /assertSuccessfulTerminalReceipt\(\{/);
  assert.match(source, /published_pr_head_mismatch/);
  assert.match(source, /const unsandboxedBackend = isUnsandboxedBackend\(backend\);/);
  assert.match(source, /nextLabelsForVerification\(existing\[0\]\.labels, verificationState, unsandboxedBackend\)/);
  assert.match(source, /nextLabelsForVerification\(\[\], verificationState, unsandboxedBackend\)/);
  assert.match(source, /if \(nextLabels\) await replaceLabels\(pr\.number, nextLabels\);/);
  assert.match(source, /return \{ number:pr\.number, url:pr\.html_url, verification_state: verificationState \};/);
  // The CLI dispatch forwards the 5th positional arg as `backend`.
  assert.match(source, /upsertPullRequest\(\{issue:Number\(a\[0\]\),resultFile:a\[1\],owner:a\[2\],ledgerFile:a\[3\],backend:a\[4\],cwd:a\[5\],startCommit:a\[6\]\}\)/);
});

test('the issue-agent workflow passes the workflow_dispatch backend input directly, never a shell-environment expansion', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  const prStep = workflow.slice(workflow.indexOf('Create or update pull request'));
  // "${{ inputs.backend || 'pi' }}" is evaluated by the Actions runner into the
  // literal command text; it is never a $VAR expansion that a compromised
  // process could influence by writing to $GITHUB_ENV.
  assert.match(prStep, /issue-publication\.mjs" pr "\$ISSUE" "\$PI_IMPLEMENTER_RESULT_FILE" "\$\{\{ github\.repository_owner \}\}" "\$PI_VALIDATION_LEDGER_FILE" "\$\{\{ inputs\.backend \|\| 'pi' \}\}"/);
  assert.match(workflow, /verification_state=\$\(jq -r '\.verification_state' <<<"\$PR"\)/);
  assert.doesNotMatch(workflow, /PI_TERMINAL_RESULT_FILE/);
  assert.match(
    readScript('scripts/pi-run-stage.mjs', 'utf8'),
    /writeGithubEnv\(env, 'PI_TERMINAL_RESULT_FILE', spec\.artifacts\.terminalResultPath\)/,
  );
  const reviewStep = workflow.slice(workflow.indexOf('Start independent PR review'));
  assert.match(reviewStep, /if: steps\.checkpoint\.outputs\.changed == 'true' && steps\.pr\.outputs\.number != '' && steps\.pr\.outputs\.verification_state == 'VERIFIED'/);
});


test('publication rejects a stray probe file that submit_result did not declare (#334)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-publication-file-set-'));
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-publication-result-'));
  const resultFile = path.join(resultDir, 'implementer-result.json');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init');
    configureTestGit(git);
    fs.writeFileSync(path.join(dir, 'helper.py'), 'def trim(value):\n    return value.strip()\n');
    git('add', '-A');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    fs.appendFileSync(path.join(dir, 'helper.py'), '\n');
    fs.writeFileSync(path.join(dir, 'test_helper.py'), 'from helper import trim\n');
    fs.writeFileSync(path.join(dir, '.probe.py"'), 'probe = True\n');
    git('add', '-A');
    git('commit', '-m', 'candidate');

    writeImplementerResult(resultFile, {
      title: 'Whitespace helper',
      summary: 'Update helper and test.',
      changes: ['Update whitespace helper', 'Add helper regression test'],
      files: ['helper.py', 'test_helper.py'],
      security_notes: 'No security impact.',
      limitations: 'None.',
    });

    assert.throws(
      () => assertPublicationFileSet({ cwd: dir, base, resultFile }),
      /Implementer file-set mismatch: unexpected files: \.probe\.py"/,
    );

    writeImplementerResult(resultFile, {
      title: 'Whitespace helper',
      summary: 'Update helper and test, including the explicitly declared probe.',
      changes: ['Update whitespace helper', 'Add helper regression test', 'Add explicitly declared probe'],
      files: ['helper.py', 'test_helper.py', '.probe.py"'],
      security_notes: 'No security impact.',
      limitations: 'None.',
      scope_enforcement: 'predeclared',
      accepted_scope: {
        schema_version: 1,
        accepted: [
          { path: 'helper.py', rationale: 'Issue requires the helper implementation change.' },
          { path: 'test_helper.py', rationale: 'Issue requires a focused regression test.' },
        ],
        temporary: [],
        baseline: [],
      },
    });
    assert.throws(
      () => assertPublicationFileSet({ cwd: dir, base, resultFile }),
      error => {
        const diagnostic = JSON.parse(error.message);
        assert.equal(diagnostic.code, 'accepted_scope_violation');
        assert.deepEqual(diagnostic.unexpected_paths, ['.probe.py"']);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(resultDir, { recursive: true, force: true });
  }
});

test('issue-agent passes the trusted result file into issue-branch publication (#334)', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.match(
    workflow,
    /issue-publication\.mjs" push "\$ISSUE" "\$JOB_DIR" "\$PI_IMPLEMENTER_START_COMMIT" "\$PI_ISSUE_BRANCH_EXPECTED" "\$PI_IMPLEMENTER_RESULT_FILE"/,
  );
});


test('publication detects both sides of a rename instead of folding it (#338 review)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-publication-rename-'));
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-publication-result-'));
  const resultFile = path.join(resultDir, 'implementer-result.json');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init');
    configureTestGit(git);
    fs.writeFileSync(path.join(dir, 'old.py'), 'value = 1\n');
    git('add', '-A');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    git('mv', 'old.py', 'new.py');
    git('commit', '-am', 'rename');

    writeImplementerResult(resultFile, {
      title: 'Rename helper',
      summary: 'Rename the helper.',
      changes: ['Rename helper'],
      files: ['old.py', 'new.py'],
      security_notes: 'No security impact.',
      limitations: 'None.',
      scope_enforcement: 'predeclared',
      accepted_scope: {
        schema_version: 1,
        accepted: [
          { path: 'old.py', rationale: 'Issue requires renaming the existing helper.' },
          { path: 'new.py', rationale: 'Issue requires the renamed helper target.' },
        ],
        temporary: [],
        baseline: [],
      },
    });

    assert.deepEqual(
      assertPublicationFileSet({ cwd: dir, base, resultFile }),
      ['new.py', 'old.py'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(resultDir, { recursive: true, force: true });
  }
});

test('publication reports declared files that are missing from the diff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-publication-missing-'));
  const resultFile = path.join(dir, 'implementer-result.json');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init');
    configureTestGit(git);
    fs.writeFileSync(path.join(dir, 'helper.py'), 'value = 1\n');
    git('add', '-A');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    fs.appendFileSync(path.join(dir, 'helper.py'), 'value2 = 2\n');
    git('commit', '-am', 'candidate');

    writeImplementerResult(resultFile, {
      title: 'Update helper',
      summary: 'Update helper.',
      changes: ['Update helper'],
      files: ['helper.py', 'not-changed.py'],
      security_notes: 'No security impact.',
      limitations: 'None.',
    });

    assert.throws(
      () => assertPublicationFileSet({ cwd: dir, base, resultFile }),
      /missing files: not-changed\.py/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publication base stays on integrated origin/dev even when the run started earlier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-publication-base-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init');
    configureTestGit(git);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'start\n');
    git('add', '-A');
    git('commit', '-m', 'run start');
    const startCommit = git('rev-parse', 'HEAD').trim();

    fs.appendFileSync(path.join(dir, 'base.txt'), 'dev advanced\n');
    git('commit', '-am', 'latest dev');
    const latestDev = git('rev-parse', 'HEAD').trim();
    git('update-ref', 'refs/remotes/origin/dev', latestDev);

    fs.writeFileSync(path.join(dir, 'implementation.txt'), 'candidate\n');
    git('add', '-A');
    git('commit', '-m', 'implementation');

    assert.equal(publicationBase(dir, startCommit), 'origin/dev');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publication base falls back to run-start when latest dev is not integrated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-publication-fallback-base-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    configureTestGit((...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }));
    fs.writeFileSync(path.join(dir, 'base.txt'), 'start\n');
    git('add', '-A');
    git('commit', '-qm', 'run start');
    const startCommit = git('rev-parse', 'HEAD');
    const branch = git('branch', '--show-current');

    git('checkout', '-qb', 'upstream');
    fs.writeFileSync(path.join(dir, 'upstream.txt'), 'latest dev\n');
    git('add', '-A');
    git('commit', '-qm', 'advance dev');
    git('update-ref', 'refs/remotes/origin/dev', git('rev-parse', 'HEAD'));

    git('checkout', '-q', branch);
    fs.writeFileSync(path.join(dir, 'implementation.txt'), 'candidate\n');
    git('add', '-A');
    git('commit', '-qm', 'implementation');

    assert.equal(publicationBase(dir, startCommit), startCommit);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PR head mismatch is behaviourally gated before publication succeeds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pr-head-mismatch-'));
  const repoDir = path.join(root, 'repo');
  fs.mkdirSync(repoDir);
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'PR Head Test');
    git('config', 'user.email', 'pr-head@example.invalid');
    fs.writeFileSync(path.join(repoDir, 'app.py'), 'value = 1\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const startCommit = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/dev', startCommit);

    fs.writeFileSync(path.join(repoDir, 'app.py'), 'value = 2\n');
    git('add', '-A');
    git('commit', '-qm', 'candidate');

    const resultFile = path.join(root, 'result.json');
    const ledgerFile = path.join(root, 'ledger.jsonl');
    const terminalFile = path.join(root, 'terminal.json');
    writeImplementerResult(resultFile, {
      title: 'Head mismatch',
      summary: 'Exercise the post-create head gate.',
      changes: ['Update app value'],
      files: ['app.py'],
      security_notes: 'No security impact.',
      limitations: 'None.',
      scope_enforcement: 'predeclared',
      accepted_scope: {
        schema_version: 1,
        accepted: [{ path: 'app.py', rationale: 'Issue requires the app change.' }],
        temporary: [],
        baseline: [],
      },
    });
    const env = {
      PI_STAGE: 'implementer',
      PI_ISSUE: '423',
      PI_VALIDATION_RUN_ID: 'head-mismatch-run',
      PI_IMPLEMENTER_START_COMMIT: startCommit,
      PI_TERMINAL_RESULT_FILE: terminalFile,
    };
    const receipt = createSuccessfulTerminalReceipt({ cwd: repoDir, resultFile, env });
    writeTerminalReceiptFile(terminalFile, receipt);
    appendCheckRecord(ledgerFile, {
      kind: 'checks_final',
      scope: { whole_repo: true },
      status: 'pass',
      source: FINAL_PIPELINE_COMPLETE_SOURCE,
      stage: 'implementer',
      backend: 'pi',
      run_id: 'head-mismatch-run',
      candidate_revision: receipt.candidate_revision,
      summary: 'complete',
    });

    const labels = [];
    let apiCall = 0;
    const client = {
      api: async (_path, method = 'GET') => {
        apiCall += 1;
        if (apiCall === 1) return [];
        assert.equal(method, 'POST');
        return {
          number: 91,
          html_url: 'https://example.invalid/pr/91',
          head: { sha: 'not-the-local-head' },
          labels: [],
        };
      },
      replaceLabels: async (number, nextLabels) => {
        labels.push({ number, nextLabels });
      },
    };

    await assert.rejects(
      upsertPullRequest({
        issue: 423,
        resultFile,
        owner: 'owner',
        ledgerFile,
        backend: 'pi',
        cwd: repoDir,
        startCommit,
        env,
        client,
      }),
      error => {
        const diagnostic = JSON.parse(error.message);
        assert.equal(diagnostic.code, 'published_pr_head_mismatch');
        assert.equal(diagnostic.expected_head, git('rev-parse', 'HEAD'));
        assert.equal(diagnostic.actual_head, 'not-the-local-head');
        return true;
      },
    );
    assert.deepEqual(labels, [{
      number: 91,
      nextLabels: [PIPELINE_LABELS.needsHuman],
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fresh submit_result rejects an undeclared untracked probe before checkpoint publication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-submit-file-set-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const context = path.join(root, 'issue.json');
  const resultFile = path.join(root, 'result.json');
  const loader = path.join(root, 'loader.mjs');
  const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
    fs.mkdirSync(work);
    git('init');
    configureTestGit(git);
    git('remote', 'add', 'origin', remote);
    fs.writeFileSync(path.join(work, 'helper.py'), 'value = 1\n');
    git('add', '-A');
    git('commit', '-m', 'base');
    git('branch', '-M', 'dev');
    git('push', '-u', 'origin', 'dev');

    fs.writeFileSync(context, JSON.stringify({ number: 334, title: 'Probe regression', body: 'Reject stray files' }));
    fs.writeFileSync(loader, TYPEBOX_STUB_LOADER);

    const moduleUrl = new URL('../scripts/pi-implementer-result-tool.mjs', import.meta.url).href;
    const program = `
      const { default: register } = await import(${JSON.stringify(moduleUrl)});
      let submit;
      const pi = {
        registerTool(tool) { if (tool.name === 'submit_result') submit = tool; },
        on() {},
        appendEntry() {},
      };
      register(pi);
      const fs = await import('node:fs');
      const { registerMutationScope } = await import(${JSON.stringify(new URL('../scripts/pi-common/accepted-mutation-scope.mjs', import.meta.url).href)});
      registerMutationScope({
        cwd: process.cwd(),
        paths: ['helper.py', 'test_helper.py'],
        rationale: 'Only helper and the test are publishable',
      });
      fs.appendFileSync('helper.py', 'value2 = 2\\n');
      fs.writeFileSync('test_helper.py', 'from helper import value\\n');
      fs.writeFileSync('.probe.py"', 'probe = True\\n');
      try {
        await submit.execute('submit', {
          title: 'Probe regression',
          summary: 'Update helper and test.',
          changes: ['Update helper', 'Add regression test'],
          files: ['helper.py', 'test_helper.py'],
          security_notes: 'No security impact.',
          limitations: 'None.',
        }, null, null, { cwd: process.cwd() });
        process.exitCode = 10;
      } catch (error) {
        console.error(error.message);
        process.exitCode = 42;
      }
    `;
    const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', program], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_WORKSPACE: process.cwd(),
        PI_ISSUE: '334',
        PI_ISSUE_CONTEXT: context,
        PI_IMPLEMENTER_RESULT_FILE: resultFile,
        PI_RESUME_ACTIVE: 'false',
        PI_VALIDATION_REPAIR: 'false',
      },
    });

    assert.equal(child.status, 42, child.stderr + child.stdout);
    assert.match(child.stderr, /accepted_scope_violation/);
    assert.match(child.stderr, /\.probe\.py/);
    assert.equal(fs.existsSync(resultFile), false, 'failed submit must not record publishable metadata');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('#424 journal seal on an already-changed committed tree remains a changed checkpoint', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-changed-journal-seal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const journalFile = path.join(root, 'mutation-journal.json');
  const missingResult = path.join(root, 'missing-result.json');
  const missingScope = path.join(root, 'missing-scope.json');

  execFileSync('git', ['init', '--bare', remote]);
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
  const startCommit = git('rev-parse', 'HEAD').trim();

  const env = { PI_MUTATION_JOURNAL_FILE: journalFile };
  mutationJournalState(work, env); // persist an explicit empty initial journal
  fs.writeFileSync(path.join(work, 'feature.py'), 'value = 1\n');

  const first = saveCheckpoint({
    issue: 424,
    cwd: work,
    startCommit,
    expectedSha: '',
    resultFile: missingResult,
    scopeFile: missingScope,
    mutationJournalFile: journalFile,
  });
  assert.equal(first.changed, true);

  // Change only journal metadata while HEAD already contains real implementation content.
  const after = captureMutationSnapshot(work, 'feature.py');
  markMutationJournalLocalOnly({ cwd: work, after, tool: 'write', env });

  const second = saveCheckpoint({
    issue: 424,
    cwd: work,
    startCommit,
    expectedSha: first.commit,
    resultFile: missingResult,
    scopeFile: missingScope,
    mutationJournalFile: journalFile,
  });

  assert.equal(second.changed, true, 'real implementation diff must not be mislabeled journal-sealed');
  assert.equal(second.reason, undefined);
  assert.notEqual(second.commit, first.commit, 'changed journal is still sealed in a new checkpoint commit');
  assert.match(git('diff', '--name-only', startCommit, second.commit), /feature\.py/);
});

test('#424 malformed newest journal trailer does not wedge resume or resurrect older state', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-invalid-journal-trailer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  git('init');
  configureTestGit(git);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('update-ref', 'refs/remotes/origin/dev', base);

  const older = encodeMutationJournalState(dir, { schema_version: 1, entries: [] });
  git('commit', '--allow-empty', '-m', `older valid\n\nPi-Mutation-Journal: ${older}`);
  git('commit', '--allow-empty', '-m', 'newest invalid\n\nPi-Mutation-Journal: definitely-not-a-gzip-trailer');

  assert.equal(
    mutationJournalStateFromRef('HEAD', dir),
    null,
    'newest explicit invalid state is unusable and must not fall through to older provenance',
  );
});

test('#424 journal comparison treats a locally missing expected checkpoint sha as no prior trailer', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-missing-checkpoint-ref-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init');
  configureTestGit(git);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-m', 'base');

  assert.equal(
    mutationJournalStateFromRef('0123456789abcdef0123456789abcdef01234567', dir),
    null,
  );
});

test('#424 cleanup-only resume seals an empty mutation journal into the checkpoint ref', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mutation-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const journalFile = path.join(root, 'mutation-journal.json');
  const missingResult = path.join(root, 'missing-result.json');
  const missingScope = path.join(root, 'missing-scope.json');
  execFileSync('git', ['init', '--bare', remote]);
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
  const startCommit = git('rev-parse', 'HEAD').trim();

  const env = { PI_MUTATION_JOURNAL_FILE: journalFile };
  const before = captureMutationSnapshot(work, '.probe.txt');
  fs.writeFileSync(path.join(work, '.probe.txt'), 'scratch\n');
  const after = captureMutationSnapshot(work, '.probe.txt');
  const entry = recordSuccessfulMutation({
    cwd: work,
    before,
    after,
    tool: 'write',
    disposition: 'temporary',
    env,
  });

  const first = saveCheckpoint({
    issue: 424,
    cwd: work,
    startCommit,
    expectedSha: '',
    resultFile: missingResult,
    scopeFile: missingScope,
    mutationJournalFile: journalFile,
  });
  assert.equal(first.changed, true);
  assert.equal(mutationJournalStateFromRef(first.commit, work).entries.at(-1).id, entry.id);

  // Model the next workflow attempt: checkpoint content is restored as an uncommitted patch
  // on the base commit, while the durable journal sidecar is restored separately.
  const patch = execFileSync('git', ['diff', '--binary', startCommit, first.commit], { cwd: work });
  git('reset', '--hard', startCommit);
  execFileSync('git', ['apply', '--index', '-'], { cwd: work, input: patch });
  git('reset');
  undoMutation({
    cwd: work,
    mutationId: entry.id,
    reason: 'remove restored accidental scratch',
    env,
  });
  assert.deepEqual(mutationJournalState(work, env).entries, []);
  assert.equal(git('status', '--porcelain').trim(), '');

  const second = saveCheckpoint({
    issue: 424,
    cwd: work,
    startCommit,
    expectedSha: first.commit,
    resultFile: missingResult,
    scopeFile: missingScope,
    mutationJournalFile: journalFile,
  });
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'journal-sealed');
  assert.notEqual(second.commit, startCommit);
  assert.deepEqual(mutationJournalStateFromRef(second.commit, work).entries, []);
  assert.equal(git('diff', '--quiet', startCommit, second.commit), '');

  const headAfterSeal = git('rev-parse', 'HEAD').trim();
  const third = saveCheckpoint({
    issue: 424,
    cwd: work,
    startCommit,
    expectedSha: second.commit,
    resultFile: missingResult,
    scopeFile: missingScope,
    mutationJournalFile: journalFile,
  });
  assert.equal(third.changed, false);
  assert.equal(third.reason, 'no-change');
  assert.equal(git('rev-parse', 'HEAD').trim(), headAfterSeal, 'identical journal state must not add another empty checkpoint commit');
});

test('checkpoint persists accepted scope before submit_result and does not create empty scope-only commits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-scope-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const scopeFile = path.join(root, 'accepted-scope.json');
  const missingResult = path.join(root, 'missing-result.json');
  execFileSync('git', ['init', '--bare', remote]);
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
  const startCommit = git('rev-parse', 'HEAD').trim();

  registerMutationScope({
    cwd: work,
    paths: ['feature.py'],
    disposition: 'publishable',
    rationale: 'Issue requires the new feature implementation file.',
    env: { PI_ACCEPTED_MUTATION_SCOPE_FILE: scopeFile },
  });
  fs.writeFileSync(path.join(work, 'feature.py'), 'value = 1\n');

  const first = saveCheckpoint({
    issue: 422,
    cwd: work,
    startCommit,
    expectedSha: '',
    resultFile: missingResult,
    scopeFile,
  });
  assert.equal(first.changed, true);
  assert.deepEqual(acceptedScopeStateFromRef(first.commit, work).accepted, [{
    path: 'feature.py',
    rationale: 'Issue requires the new feature implementation file.',
  }]);

  const headBefore = git('rev-parse', 'HEAD').trim();
  const second = saveCheckpoint({
    issue: 422,
    cwd: work,
    startCommit,
    expectedSha: first.commit,
    resultFile: missingResult,
    scopeFile,
  });
  assert.equal(second.changed, true, 'the existing implementation diff is still checkpoint content');
  assert.equal(git('rev-parse', 'HEAD').trim(), headBefore, 'no empty scope-only commit is added');

  const resultFile = path.join(root, 'result.json');
  // The result metadata is intentionally stale: a later repair/coding step
  // accepted another path after submit_result. Checkpoint must persist the
  // live sidecar superset, not lose the later acceptance.
  writeImplementerResult(resultFile, {
    title: 'Feature follow-up',
    summary: 'Add the feature implementation.',
    changes: ['Add feature file'],
    files: ['feature.py'],
    security_notes: 'None.',
    limitations: 'None.',
    scope_enforcement: 'predeclared',
    accepted_scope: {
      schema_version: 1,
      accepted: [
        { path: 'feature.py', rationale: 'Issue requires the new feature implementation file.' },
      ],
      temporary: [],
      baseline: [],
    },
  });
  registerMutationScope({
    cwd: work,
    paths: ['second.py'],
    disposition: 'publishable',
    rationale: 'Repair attempt requires the follow-up implementation file.',
    env: { PI_ACCEPTED_MUTATION_SCOPE_FILE: scopeFile },
  });
  fs.writeFileSync(path.join(work, 'second.py'), 'value = 2\n');
  const third = saveCheckpoint({
    issue: 422,
    cwd: work,
    startCommit,
    expectedSha: first.commit,
    resultFile,
    scopeFile,
  });
  assert.equal(third.changed, true);
  assert.deepEqual(acceptedScopeStateFromRef(third.commit, work).accepted.map(entry => entry.path), ['feature.py', 'second.py']);
});

test('checkpoint never lets a Pi sidecar override unsandboxed-gated metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mini-checkpoint-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const scopeFile = path.join(root, 'accepted-scope.json');
  const resultFile = path.join(root, 'result.json');
  execFileSync('git', ['init', '--bare', remote]);
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
  const startCommit = git('rev-parse', 'HEAD').trim();

  registerMutationScope({
    cwd: work,
    paths: ['feature.py'],
    disposition: 'publishable',
    rationale: 'Stale Pi sidecar entry must not upgrade mini-swe trust.',
    env: { PI_ACCEPTED_MUTATION_SCOPE_FILE: scopeFile },
  });
  fs.writeFileSync(path.join(work, 'feature.py'), 'value = 1\n');
  writeImplementerResult(resultFile, {
    title: 'Mini change',
    summary: 'Unsandboxed implementation.',
    changes: ['Add feature'],
    files: ['feature.py'],
    security_notes: 'None.',
    limitations: 'Human gate required.',
    scope_enforcement: 'unsandboxed-gated',
  });

  const saved = saveCheckpoint({
    issue: 422,
    cwd: work,
    startCommit,
    expectedSha: '',
    resultFile,
    scopeFile,
  });
  assert.equal(saved.changed, true);
  const message = git('log', '-1', '--format=%B');
  assert.match(message, /Pi-Scope-Enforcement: unsandboxed-gated/);
  assert.doesNotMatch(message, /Pi-Accepted-Mutation-Scope:/);
});

test('resume finds the newest valid scope receipt through a marker-less checkpoint tip', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-scope-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init');
  configureTestGit(git);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-m', 'base');

  const receipt = {
    schema_version: 1,
    accepted: [{ path: 'feature.py', rationale: 'Issue requires the feature file.' }],
    temporary: [],
    baseline: [],
  };
  const encoded = Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64url');
  fs.writeFileSync(path.join(dir, 'feature.py'), 'one\n');
  git('add', '-A');
  git('commit', '-m', `checkpoint one\n\nPi-Scope-Enforcement: predeclared\nPi-Accepted-Mutation-Scope: ${encoded}`);

  fs.writeFileSync(path.join(dir, 'later.txt'), 'later\n');
  git('add', '-A');
  git('commit', '-m', 'marker-less later checkpoint');

  assert.deepEqual(acceptedScopeStateFromRef('HEAD', dir), receipt);
});

test('mini-swe unsandboxed-gated metadata still requires exact declared diff but not a Pi scope receipt', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mini-swe-scope-'));
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mini-swe-result-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(resultDir, { recursive: true, force: true }));
  const resultFile = path.join(resultDir, 'result.json');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init');
  configureTestGit(git);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'feature.py'), 'value = 1\n');
  git('add', '-A');
  git('commit', '-m', 'candidate');

  writeImplementerResult(resultFile, {
    title: 'Feature',
    summary: 'Implement feature.',
    changes: ['Add feature'],
    files: ['feature.py'],
    security_notes: 'None.',
    limitations: 'Unsandboxed backend remains needs-human gated.',
    scope_enforcement: 'unsandboxed-gated',
  });
  assert.deepEqual(assertPublicationFileSet({ cwd: dir, base, resultFile }), ['feature.py']);
});
