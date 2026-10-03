function errorText(error) {
  if (!error) return null;
  const text = String(error?.message ?? error).trim();
  return text || null;
}

export function normalizeCodingSessionOutcome({
  submitted,
  sessionError = null,
  receiptError = null,
} = {}) {
  const successful = submitted === true;
  const recoveredErrors = successful && sessionError ? [errorText(sessionError)] : [];
  const unresolvedTerminalError = successful
    ? null
    : errorText(sessionError) ?? errorText(receiptError);

  return {
    submitted: successful,
    successful_final_submission: successful,
    status: successful ? 'ok' : (unresolvedTerminalError ? 'error' : 'incomplete'),
    recovered_errors: recoveredErrors.filter(Boolean),
    unresolved_terminal_error: unresolvedTerminalError,
  };
}
