import { writeFileSync } from 'node:fs';

export function terminalResult(text, details) {
  const marker = process.env.PI_TERMINAL_RESULT_FILE;
  if (marker) writeFileSync(marker, 'submitted\n', { encoding: 'utf8', mode: 0o600 });
  return { content: [{ type: 'text', text }], details, terminate: true };
}

export function registerSubmitNudge(pi, { isSubmitted, customType, content, repeatWhile = () => false }) {
  let nudged = false;
  pi.on('agent_before_settle', () => {
    if (isSubmitted()) return undefined;
    if (nudged && !repeatWhile()) return undefined;
    nudged = true;
    return {
      continue: true,
      entries: [{ type: 'custom_message', customType, content, display: true }],
    };
  });
}

export function registerTerminalTool(pi, {
  name = 'submit_result',
  label,
  description,
  parameters,
  customType,
  nudgeType = 'pi-result-nudge',
  nudgeText,
  execute,
  successText = 'Result recorded. Stop now.',
}) {
  let submitted = false;
  let terminalFailed = false;
  pi.registerTool({
    name,
    label,
    description,
    parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const outcome = await execute(params, { toolCallId, signal, onUpdate, ctx });
        if (customType && outcome?.data !== undefined) pi.appendEntry(customType, outcome.data);
        submitted = true;
        return terminalResult(outcome?.text ?? successText, outcome?.details);
      } catch (error) {
        terminalFailed = true;
        throw error;
      }
    },
  });

  registerSubmitNudge(pi, {
    isSubmitted: () => submitted,
    customType: nudgeType,
    content: nudgeText,
    repeatWhile: () => terminalFailed,
  });

  return { isSubmitted: () => submitted };
}
