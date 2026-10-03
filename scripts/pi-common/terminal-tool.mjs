import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  createSuccessfulTerminalReceipt,
  invalidateTerminalReceipt,
  readTerminalReceiptFile,
  writeTerminalReceiptFile,
} from './terminal-receipt.mjs';

export function terminalResult(text, details, receipt = null, env = process.env) {
  const marker = env.PI_TERMINAL_RESULT_FILE;
  if (marker) {
    if (receipt) {
      writeTerminalReceiptFile(marker, receipt);
    } else if (env.PI_STAGE === 'implementer') {
      throw new Error(JSON.stringify({ code: 'implementer_terminal_receipt_required' }));
    } else {
      writeFileSync(marker, 'submitted\n', { encoding: 'utf8', mode: 0o600 });
    }
  }
  return { content: [{ type: 'text', text }], details, terminate: true };
}

// The terminal marker is the run-wide truth: the implementer's coding session submits from a
// forked process, so this process's own `submitted` flag can be false although the run is done.
export function terminalMarkerSubmitted(env = process.env) {
  const marker = env.PI_TERMINAL_RESULT_FILE;
  try {
    if (!marker || !existsSync(marker)) return false;
    if (readTerminalReceiptFile(marker)) return true;
    // Legacy bare markers remain valid only for non-Implementer stages whose
    // terminal result carries no candidate publication authority.
    if (env.PI_STAGE === 'implementer') return false;
    return readFileSync(marker, 'utf8').trim() === 'submitted';
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
        if (process.env.PI_STAGE === 'implementer') invalidateTerminalReceipt(process.env);
        const outcome = await execute(params, { toolCallId, signal, onUpdate, ctx });
        if (customType && outcome?.data !== undefined) pi.appendEntry(customType, outcome.data);
        const receipt = process.env.PI_STAGE === 'implementer' && process.env.PI_IMPLEMENTER_RESULT_FILE
          ? createSuccessfulTerminalReceipt({
              cwd: ctx?.cwd ?? process.cwd(),
              resultFile: process.env.PI_IMPLEMENTER_RESULT_FILE,
              env: process.env,
            })
          : null;
        const result = terminalResult(outcome?.text ?? successText, outcome?.details, receipt);
        submitted = true;
        return result;
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
