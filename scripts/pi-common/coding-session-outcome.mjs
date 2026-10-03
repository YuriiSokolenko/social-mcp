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
