// Shared reader for Pi JSONL event logs. Result parsers use this instead of
// each reimplementing tolerant JSON parsing, structured-entry lookup, and
// extraction of the last assistant text.
export function assistantText(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

export function readPiJsonl(jsonl, { customType } = {}) {
  let customResult = null;
  let finalText = '';

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }

    if (customType && event.type === 'entry_appended' && event.entry?.type === 'custom' &&
        event.entry?.customType === customType) {
      customResult = event.entry.data;
    }
    if (event.type === 'message_end') {
      const text = assistantText(event.message);
      if (text.trim()) finalText = text.trim();
    }
    if (event.type === 'agent_end') {
      // agent_end is authoritative for the completed turn. If it carries no
      // assistant message, do not leak a quoted/intermediate message_end from
      // an earlier turn into result parsing.
      const messages = Array.isArray(event.messages) ? event.messages : [];
      const assistant = [...messages].reverse().find(message => message?.role === 'assistant');
      const text = assistantText(assistant);
      finalText = text.trim();
    }
  }

  return { customResult, finalText };
}
