function errorText(error) {
  if (!error) return null;
  const text = String(error?.message ?? error).trim();
  return text || null;
}

/**
 * The pinned adapter resolves earlier recoverable tool errors BEFORE returning
 * completed. A failed/cancelled/timed-out delegation must not be upgraded to
 * success by a tool receipt left behind in the child's worktree.
 */
export function normalizeCodingSessionOutcome({
  submitted,
  outcome = null,
  sessionError = null,
  receiptError = null,
} = {}) {
  const semanticOutcome = ['changed', 'already_satisfied', 'blocked'].includes(outcome) ? outcome : null;
  const terminalSubmitted = submitted === true && !sessionError;
  const successful = terminalSubmitted && semanticOutcome !== 'blocked';
  const recoveredErrors = []; // Earlier recoverable tool errors were handled inside Pi.
  const unresolvedTerminalError = errorText(sessionError);
  const receiptDiagnostic = successful ? null : errorText(receiptError);

  return {
    submitted: terminalSubmitted,
    successful_final_submission: successful,
    outcome: terminalSubmitted ? semanticOutcome : null,
    status: terminalSubmitted && semanticOutcome === 'blocked' ? 'blocked' : successful ? 'ok' : (unresolvedTerminalError ? 'error' : 'incomplete'),
    recovered_errors: recoveredErrors.filter(Boolean),
    unresolved_terminal_error: unresolvedTerminalError,
    receipt_error: receiptDiagnostic,
  };
}


function normalizedPaths(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => item.trim()))].sort();
}

/**
 * Trusted child->parent continuation contract. Inputs are runtime-derived state only:
 * git changed paths, the accepted-scope receipt, prepared-output presence, and the
 * authoritative validation ledger. No model prose is admitted into this receipt.
 */
export function codingSessionRecoveryReceipt({
  changedFiles = [],
  acceptedScope = null,
  preparedOutputs = null,
  lastValidation = null,
} = {}) {
  const accepted = new Set(normalizedPaths(acceptedScope?.accepted?.map(entry => entry?.path)));
  const changedPublishablePaths = normalizedPaths(changedFiles).filter(file => accepted.has(file));
  const outputs = {
    source: preparedOutputs?.source === true,
    test: preparedOutputs?.test === true,
  };
  const validation = lastValidation && typeof lastValidation === 'object'
    ? {
        kind: typeof lastValidation.kind === 'string' ? lastValidation.kind : null,
        status: typeof lastValidation.status === 'string' ? lastValidation.status : null,
        infrastructure_code: typeof lastValidation.infrastructure_code === 'string'
          ? lastValidation.infrastructure_code
          : null,
      }
    : null;
  const preparedComplete = outputs.source && outputs.test;
  const remaining = !preparedComplete
    ? 'prepared_outputs'
    : (!validation || validation.status !== 'pass')
      ? 'validation'
      : 'terminal_submission';

  return {
    coding_session_status: 'aborted',
    changed_publishable_paths: changedPublishablePaths,
    prepared_outputs_present: outputs,
    last_validation: validation,
    remaining_terminal_obligation: remaining,
  };
}
