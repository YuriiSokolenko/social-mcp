// #594: compact only the recognizable, replaceable Implementer runtime action steer.
// This runs at the provider boundary, leaving Pi's original session and audit log intact.
// Other RUNTIME messages (repair, validation, capabilities, recovery, errors) are independent.
export const ACTION_REQUIRED_STEER_LEAD =
  'RUNTIME ACTION REQUIRED: evidence is complete. In the next response, do not narrate or restate the plan. ';
const VERIFICATION_LEAD = ' Verification status: ';

function steerText(message) {
  if (message?.role !== 'user') return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length === 1 &&
      (content[0]?.type === 'text' || content[0]?.type === 'input_text') &&
      typeof content[0].text === 'string') return content[0].text;
  return null;
}

function isRuntimeActionSteer(message) {
  const text = steerText(message);
  return text?.startsWith(ACTION_REQUIRED_STEER_LEAD) === true &&
    text.includes(VERIFICATION_LEAD);
}

function replaceSteerText(message, text) {
  if (typeof message.content === 'string') return { ...message, content: text };
  return {
    ...message,
    content: [{ ...message.content[0], text }],
  };
}

// Only remove exact runtime-generated action steer shapes. Never compact a user message
// with tool linkage, a multi-part user turn, or an unrelated directive. A suspected
// tool-linked action steer blocks the whole rewrite rather than risking tool-call pairing.
export function compactRuntimeActionSteers(payload, currentDirective = null) {
  if (!Array.isArray(payload?.messages)) return { payload, removed: 0, blocked: null };
  const indices = [];
  for (let i = 0; i < payload.messages.length; i++) {
    const message = payload.messages[i];
    if (!isRuntimeActionSteer(message)) continue;
    if (message.tool_call_id != null || message.tool_calls != null || message.name != null) {
      return { payload, removed: 0, blocked: 'tool_linked_steer' };
    }
    indices.push(i);
  }
  if (!indices.length) return { payload, removed: 0, blocked: null };
  if (currentDirective != null && (
    typeof currentDirective !== 'string' ||
    !currentDirective.startsWith(ACTION_REQUIRED_STEER_LEAD) ||
    !currentDirective.includes(VERIFICATION_LEAD)
  )) {
    return { payload, removed: 0, blocked: 'invalid_replacement' };
  }

  // Expired state removes all old steers; active state keeps only the newest one
  // and refreshes its tool/verification guidance for the actual outbound surface.
  const last = currentDirective == null ? -1 : indices[indices.length - 1];
  const targetIndices = new Set(indices);
  const messages = payload.messages.flatMap((message, index) => {
    if (!targetIndices.has(index)) return [message];
    return index === last ? [replaceSteerText(message, currentDirective)] : [];
  });
  return {
    payload: { ...payload, messages },
    removed: indices.length - (last === -1 ? 0 : 1),
    blocked: null,
  };
}
