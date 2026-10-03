import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { writeImplementerResult } from '../scripts/pi-common/implementer-result.mjs';
import {
  assertSuccessfulTerminalReceipt,
  createSuccessfulTerminalReceipt,
  writeTerminalReceiptFile,
} from '../scripts/pi-common/terminal-receipt.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-terminal-receipt-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Receipt Test');
  git('config', 'user.email', 'receipt@example.invalid');
  fs.writeFileSync(path.join(repo, 'app.py'), 'value = 1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/dev', git('rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(repo, 'app.py'), 'value = 2\n');

  const resultFile = path.join(root, 'result.json');
  const terminalFile = path.join(root, 'terminal.json');
  writeImplementerResult(resultFile, {
    title: 'Bind candidate receipt',
    summary: 'Bind submission to exact candidate bytes.',
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
    PI_IMPLEMENTER_RESULT_FILE: resultFile,
    PI_CODING_SESSION: JSON.stringify({ sessionId: 'session-a' }),
  };
  const receipt = createSuccessfulTerminalReceipt({ cwd: repo, resultFile, env, base: 'origin/dev' });
  writeTerminalReceiptFile(terminalFile, receipt);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { repo, resultFile, terminalFile, env };
}

test('terminal receipt is run/session bound and rejects same-path post-submit mutation', t => {
  const { repo, resultFile, env } = fixture(t);
  assert.doesNotThrow(() => assertSuccessfulTerminalReceipt({
    cwd: repo,
    resultFile,
    env,
    base: 'origin/dev',
    expectedSessionId: 'session-a',
  }));
  assert.throws(
    () => assertSuccessfulTerminalReceipt({
      cwd: repo,
      resultFile,
      env,
      base: 'origin/dev',
      expectedSessionId: 'session-b',
    }),
    /terminal_receipt_foreign_session/,
  );
  fs.writeFileSync(path.join(repo, 'app.py'), 'value = 3\n');
  assert.throws(
    () => assertSuccessfulTerminalReceipt({
      cwd: repo,
      resultFile,
      env,
      base: 'origin/dev',
      expectedSessionId: 'session-a',
    }),
    /terminal_receipt_candidate_mismatch/,
  );
});

test('terminal receipt rejects foreign run, malformed marker and changed result metadata', t => {
  const { repo, resultFile, terminalFile, env } = fixture(t);
  assert.throws(
    () => assertSuccessfulTerminalReceipt({
      cwd: repo,
      resultFile,
      env: { ...env, PI_VALIDATION_RUN_ID: 'other-run' },
      base: 'origin/dev',
      expectedSessionId: 'session-a',
    }),
    /terminal_receipt_foreign_run/,
  );

  writeImplementerResult(resultFile, {
    title: 'Changed metadata',
    summary: 'Metadata was rewritten after submission.',
    changes: ['Update app value'],
    files: ['app.py'],
    security_notes: 'No security impact.',
    limitations: 'None.',
  });
  assert.throws(
    () => assertSuccessfulTerminalReceipt({
      cwd: repo,
      resultFile,
      env,
      base: 'origin/dev',
      expectedSessionId: 'session-a',
    }),
    /terminal_receipt_result_metadata_mismatch/,
  );

  fs.writeFileSync(terminalFile, 'submitted\n');
  assert.throws(
    () => assertSuccessfulTerminalReceipt({
      cwd: repo,
      resultFile,
      env,
      base: 'origin/dev',
    }),
    /terminal_receipt_invalid/,
  );
});

test('receipt defaults to the same run-start fallback base when latest dev is not integrated', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-terminal-fallback-base-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Receipt Test');
  git('config', 'user.email', 'receipt@example.invalid');
  fs.writeFileSync(path.join(repo, 'app.py'), 'value = 1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const startCommit = git('rev-parse', 'HEAD');
  const branch = git('branch', '--show-current');

  git('checkout', '-qb', 'upstream');
  fs.writeFileSync(path.join(repo, 'upstream.py'), 'upstream = True\n');
  git('add', '-A');
  git('commit', '-qm', 'advance dev');
  git('update-ref', 'refs/remotes/origin/dev', git('rev-parse', 'HEAD'));
  git('checkout', '-q', branch);
  fs.writeFileSync(path.join(repo, 'app.py'), 'value = 2\n');

  const resultFile = path.join(root, 'result.json');
  const terminalFile = path.join(root, 'terminal.json');
  writeImplementerResult(resultFile, {
    title: 'Fallback base',
    summary: 'Bind a non-integrated candidate to its run-start base.',
    changes: ['Update app value'],
    files: ['app.py'],
    security_notes: 'No security impact.',
    limitations: 'None.',
  });
  const env = {
    PI_STAGE: 'implementer',
    PI_VALIDATION_RUN_ID: 'run-fallback',
    PI_IMPLEMENTER_START_COMMIT: startCommit,
    PI_TERMINAL_RESULT_FILE: terminalFile,
  };

  try {
    const receipt = createSuccessfulTerminalReceipt({ cwd: repo, resultFile, env });
    assert.equal(receipt.candidate_revision.base_commit, startCommit);
    writeTerminalReceiptFile(terminalFile, receipt);
    assert.doesNotThrow(() => assertSuccessfulTerminalReceipt({ cwd: repo, resultFile, env }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
