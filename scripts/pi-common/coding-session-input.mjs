// Pure coding-session handoff normalization and begin_coding_session argument admission.
// No session state, plan IO, tool registration, or child launch.
export const CODING_SESSION_HANDOFF_MAX_LENGTH = 1200;

export function normalizedCodingSessionHandoff(value) {
  const trimmed = String(value ?? '').trim();
  return Array.from(trimmed).slice(0, CODING_SESSION_HANDOFF_MAX_LENGTH).join('').trimEnd();
}

export function codingSessionArgumentValidation(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push('arguments: must be an object');
  } else {
    const optionalString = (field, maxLength) => {
      if (!Object.prototype.hasOwnProperty.call(input, field)) return;
      if (typeof input[field] !== 'string') {
        errors.push(`${field}: must be a string`);
        return;
      }
      if (Array.from(input[field]).length > maxLength) {
        errors.push(`${field}: must not have more than ${maxLength} characters`);
      }
    };
    optionalString('reason', 300);
    optionalString('handoff', CODING_SESSION_HANDOFF_MAX_LENGTH);
    optionalString('required_capability', 100);
  }
  if (errors.length === 0) return null;
  return {
    errors,
    diagnostic: `Validation failed for tool "begin_coding_session":\n  - ${errors.join('\n  - ')}`,
  };
}

export function codingSessionArgumentFailure(message, toolName, executableTools) {
  if (!toolName || !Array.isArray(executableTools) || !executableTools.includes(toolName)) return null;
  const toolCall = Array.isArray(message?.content)
    ? message.content.find(part => part?.type === 'toolCall' && part?.name === toolName)
    : null;
  if (!toolCall) return null;

  let input = toolCall.arguments ?? toolCall.input ?? toolCall.parameters;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return {
        errors: ['arguments: must be a valid JSON object'],
        diagnostic: 'Validation failed for tool "begin_coding_session":\n  - arguments: must be a valid JSON object',
      };
    }
  }
  return codingSessionArgumentValidation(input);
}
