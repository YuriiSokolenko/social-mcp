import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function terminalResult(text, details) {
  const marker = process.env.PI_TERMINAL_RESULT_FILE;
  if (marker) writeFileSync(marker, 'submitted\n', { encoding: 'utf8', mode: 0o600 });
  return { content: [{ type: 'text', text }], details, terminate: true };
}

// The terminal marker is the run-wide truth: the implementer's coding session submits from a
// forked process, so this process's own `submitted` flag can be false although the run is done.
export function terminalMarkerSubmitted(env = process.env) {
  const marker = env.PI_TERMINAL_RESULT_FILE;
  try {
    return Boolean(marker && existsSync(marker) && readFileSync(marker, 'utf8').trim() === 'submitted');
  } catch {
    return false;
  }
}

export function registerSubmitNudge(pi, {
  isSubmitted,
  customType,
  content,
  repeatWhile = () => false,
  maxNudges = null,
}) {
  let nudgeCount = 0;
  pi.on('agent_before_settle', () => {
    if (isSubmitted()) return undefined;
    if (nudgeCount > 0 && !repeatWhile()) return undefined;
    const limit = typeof maxNudges === 'function' ? maxNudges() : maxNudges;
    if (Number.isSafeInteger(limit) && limit >= 0 && nudgeCount >= limit) return undefined;
    nudgeCount += 1;
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
  nudgeRepeatWhile = () => false,
  nudgeMaxCount = null,
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
    isSubmitted: () => submitted || terminalMarkerSubmitted(),
    customType: nudgeType,
    content: nudgeText,
    repeatWhile: () => terminalFailed || nudgeRepeatWhile(),
    maxNudges: () => terminalFailed ? null : nudgeMaxCount,
  });

  return { isSubmitted: () => submitted || terminalMarkerSubmitted() };
}
