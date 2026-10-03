import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { assertPublicationCandidate } from '../scripts/pi-common/issue-publication.mjs';
import { writeImplementerResult } from '../scripts/pi-common/implementer-result.mjs';
import {
  appendCheckRecord,
  FINAL_PIPELINE_COMPLETE_SOURCE,
  VERIFICATION_STATES,
} from '../scripts/pi-common/validation-ledger.mjs';
import {
  createSuccessfulTerminalReceipt,
  writeTerminalReceiptFile,
} from '../scripts/pi-common/terminal-receipt.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-publication-candidate-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Publication Test');
  git('config', 'user.email', 'publication@example.invalid');
  fs.writeFileSync(path.join(repo, 'app.py'), 'value = 1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/dev', git('rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(repo, 'app.py'), 'value = 2\n');

  const resultFile = path.join(root, 'result.json');
  const terminalFile = path.join(root, 'terminal.json');
  const ledgerFile = path.join(root, 'ledger.jsonl');
  writeImplementerResult(resultFile, {
    title: 'Exact candidate publication',
    summary: 'Publish only bytes that were submitted and validated.',
    changes: ['Update app value'],
    files: ['app.py'],
    security_notes: 'No security impact.',
    limitations: 'None.',
  });
  const env = {
    PI_STAGE: 'implementer',
    PI_ISSUE: '423',
    PI_VALIDATION_RUN_ID: 'run-423',
    PI_TERMINAL_RESULT_FILE: terminalFile,
  };
  const receipt = createSuccessfulTerminalReceipt({ cwd: repo, resultFile, env, base: 'origin/dev' });
  writeTerminalReceiptFile(terminalFile, receipt);
  appendCheckRecord(ledgerFile, {
    kind: 'pytest',
    scope: { whole_repo: true },
    status: 'pass',
    source: 'checks_final',
    stage: 'implementer',
    backend: 'pi',
    run_id: 'run-423',
    summary: 'passed',
  });
  appendCheckRecord(ledgerFile, {
    kind: 'checks_final',
    scope: { whole_repo: true },
    status: 'pass',
    source: FINAL_PIPELINE_COMPLETE_SOURCE,
    stage: 'implementer',
    backend: 'pi',
    run_id: 'run-423',
    candidate_revision: receipt.candidate_revision,
    summary: 'complete',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { repo, resultFile, terminalFile, ledgerFile, env };
}

test('publication requires receipt and final validation for the same current candidate', t => {
  const { repo, resultFile, terminalFile, ledgerFile, env } = fixture(t);
  const verified = assertPublicationCandidate({
    cwd: repo,
    base: 'origin/dev',
    resultFile,
    ledgerFile,
    terminalFile,
    env,
  });
  assert.equal(verified.verificationState, VERIFICATION_STATES.VERIFIED);

  fs.writeFileSync(path.join(repo, 'app.py'), 'value = 3\n');
  assert.throws(
    () => assertPublicationCandidate({
      cwd: repo,
      base: 'origin/dev',
      resultFile,
      ledgerFile,
      terminalFile,
      env,
    }),
    /terminal_receipt_candidate_mismatch/,
  );
});
