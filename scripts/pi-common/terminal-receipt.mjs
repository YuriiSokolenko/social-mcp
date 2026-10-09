import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  computeCandidateRevision,
  resolveCandidateBase,
  sameCandidateRevision,
} from './candidate-revision.mjs';
import { resolveValidationRunId } from './validation-ledger.mjs';
import { readImplementerResult } from './implementer-result.mjs';

export const TERMINAL_RECEIPT_KIND = 'pi_terminal_receipt';
export const TERMINAL_RECEIPT_SCHEMA_VERSION = 2;

// This receipt is a consistency binding, not a cryptographic authentication
// token. Authorization still comes from trusted harness validation/publication
// policy; the receipt only keeps run/result metadata/candidate bytes aligned.

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function receiptAttemptId(env) {
  if (env.PI_VALIDATION_REPAIR === 'true') {
    return `validation-repair:${String(env.PI_VALIDATION_REPAIR_ATTEMPT ?? '1').trim() || '1'}`;
  }
  return 'primary';
}

function receiptSessionId(env) {
  const raw = String(env.PI_CODING_SESSION ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.sessionId === 'string' && parsed.sessionId.trim()
      ? parsed.sessionId.trim()
      : null;
  } catch {
    return null;
  }
}

function resultMetadataDigest(resultFile) {
  if (!resultFile || !fs.existsSync(resultFile) || !fs.statSync(resultFile).size) {
    throw new Error('implementer result metadata is missing');
  }
  return sha256(fs.readFileSync(resultFile));
}

function receiptError(code, details = {}) {
  return new Error(JSON.stringify({ code, ...details }));
}

export function createSuccessfulTerminalReceipt({
  cwd = process.cwd(),
  resultFile,
  env = process.env,
  base,
} = {}) {
  const candidateBase = base ?? resolveCandidateBase({
    cwd,
    startCommit: env.PI_IMPLEMENTER_START_COMMIT,
  });
  const candidateRevision = computeCandidateRevision({
    cwd,
    base: candidateBase,
  });
  return {
    kind: TERMINAL_RECEIPT_KIND,
    schema_version: TERMINAL_RECEIPT_SCHEMA_VERSION,
    status: 'success',
    outcome: readImplementerResult(resultFile)?.outcome ?? null,
    run_id: resolveValidationRunId(env),
    attempt_id: receiptAttemptId(env),
    session_id: receiptSessionId(env),
    issue: String(env.PI_ISSUE ?? env.ISSUE ?? '').trim() || null,
    candidate_revision: candidateRevision,
    result_metadata_sha256: resultMetadataDigest(resultFile),
    created_at: new Date().toISOString(),
  };
}

export function writeTerminalReceiptFile(target, receipt) {
  if (!target) throw receiptError('terminal_receipt_path_missing');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // This rename is the commit point; the parent never publishes metadata
    // without independently revalidating this receipt and the current Git tree.
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return receipt;
}

export function readTerminalReceiptFile(target) {
  if (!target || !fs.existsSync(target) || !fs.statSync(target).size) return null;
  try {
    const receipt = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (
      receipt?.kind !== TERMINAL_RECEIPT_KIND ||
      receipt?.schema_version !== TERMINAL_RECEIPT_SCHEMA_VERSION ||
      receipt?.status !== 'success' ||
      !['changed', 'already_satisfied', 'blocked'].includes(receipt?.outcome) ||
      typeof receipt?.run_id !== 'string' ||
      typeof receipt?.attempt_id !== 'string' ||
      typeof receipt?.result_metadata_sha256 !== 'string' ||
      typeof receipt?.candidate_revision?.digest !== 'string' ||
      typeof receipt?.candidate_revision?.base_commit !== 'string'
    ) {
      return null;
    }
    return receipt;
  } catch {
    return null;
  }
}

export function invalidateTerminalReceipt(env = process.env) {
  const target = String(env.PI_TERMINAL_RESULT_FILE ?? '').trim();
  if (target) fs.rmSync(target, { force: true });
}

export function assertSuccessfulTerminalReceipt({
  cwd = process.cwd(),
  resultFile,
  env = process.env,
  base,
  expectedSessionId,
  bindAttempt = true,
} = {}) {
  const target = String(env.PI_TERMINAL_RESULT_FILE ?? '').trim();
  if (!target || !fs.existsSync(target) || !fs.statSync(target).size) {
    throw receiptError('terminal_receipt_missing');
  }

  const receipt = readTerminalReceiptFile(target);
  if (!receipt) throw receiptError('terminal_receipt_invalid');

  const runId = resolveValidationRunId(env);
  if (receipt.run_id !== runId) {
    throw receiptError('terminal_receipt_foreign_run', { expected_run_id: runId, actual_run_id: receipt.run_id });
  }

  if (bindAttempt) {
    const attemptId = receiptAttemptId(env);
    if (receipt.attempt_id !== attemptId) {
      throw receiptError('terminal_receipt_foreign_attempt', { expected_attempt_id: attemptId, actual_attempt_id: receipt.attempt_id });
    }
  }

  if (expectedSessionId !== undefined && receipt.session_id !== expectedSessionId) {
    throw receiptError('terminal_receipt_foreign_session', {
      expected_session_id: expectedSessionId,
      actual_session_id: receipt.session_id,
    });
  }

  const issue = String(env.PI_ISSUE ?? env.ISSUE ?? '').trim();
  if (issue && receipt.issue !== issue) {
    throw receiptError('terminal_receipt_foreign_issue', { expected_issue: issue, actual_issue: receipt.issue });
  }

  let metadataDigest;
  try {
    metadataDigest = resultMetadataDigest(resultFile);
  } catch {
    throw receiptError('terminal_receipt_result_metadata_missing');
  }
  if (receipt.result_metadata_sha256 !== metadataDigest) {
    throw receiptError('terminal_receipt_result_metadata_mismatch');
  }

  const candidateBase = base ?? resolveCandidateBase({
    cwd,
    startCommit: env.PI_IMPLEMENTER_START_COMMIT,
  });
  const candidateRevision = computeCandidateRevision({
    cwd,
    base: candidateBase,
  });
  if (!sameCandidateRevision(receipt.candidate_revision, candidateRevision)) {
    throw receiptError('terminal_receipt_candidate_mismatch', {
      expected_candidate: candidateRevision.digest,
      receipt_candidate: receipt.candidate_revision?.digest ?? null,
    });
  }

  return { receipt, candidateRevision };
}
