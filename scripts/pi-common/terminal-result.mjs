export function terminalResult(text, details) {
  return { content: [{ type: 'text', text }], details, terminate: true };
}

export function registerSubmitNudge(pi, { isSubmitted, customType, content }) {
  let nudged = false;
  pi.on('agent_before_settle', () => {
    if (isSubmitted() || nudged) return undefined;
    nudged = true;
    return {
      continue: true,
      entries: [{ type: 'custom_message', customType, content, display: true }],
    };
  });
}
