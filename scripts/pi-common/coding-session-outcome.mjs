function errorText(error) {
  if (!error) return null;
  const text = String(error?.message ?? error).trim();
  return text || null;
}

/**
 * Historical child errors are diagnostic once a valid final receipt exists:
 * final successful submission is authoritative even if the session reported an
 * earlier (or later transport) error. An invalid/stale receipt is different:
 * it means "not submitted yet", so the parent may retry rather than turning the
 * receipt diagnostic itself into a terminal execution failure.
 */
export function normalizeCodingSessionOutcome({
  submitted,
  sessionError = null,
  receiptError = null,
} = {}) {
  const successful = submitted === true;
  const recoveredErrors = successful && sessionError ? [errorText(sessionError)] : [];
  const unresolvedTerminalError = successful
    ? null
    : errorText(sessionError);
  const receiptDiagnostic = successful ? null : errorText(receiptError);

  return {
    submitted: successful,
    successful_final_submission: successful,
    status: successful ? 'ok' : (unresolvedTerminalError ? 'error' : 'incomplete'),
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
