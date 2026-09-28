import { writeFileSync } from 'node:fs';

export function terminalResult(text, details) {
  const marker = process.env.PI_TERMINAL_RESULT_FILE;
  if (marker) writeFileSync(marker, 'submitted\n', { encoding: 'utf8', mode: 0o600 });
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
