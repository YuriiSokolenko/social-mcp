// Pi's small self-hosted model has no built-in turn budget and can repeat an
// identical failing or exploratory tool call dozens of times without noticing.
// This policy blocks tool calls once a run exceeds a turn budget or repeats
// the exact same call too often, so the model is pushed to finalize instead
// of silently burning the whole job timeout. See docs/CI_RULES.md.

export function turnBudget(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('PI_MAX_TURNS must be a positive integer');
  }
  return limit;
}

export function repeatLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('PI_MAX_REPEAT_CALLS must be a positive integer');
  }
  return limit;
}

// Normalizes a tool call into a signature so trivial whitespace differences
// do not create a "new" call, without hiding a genuinely different command.
export function toolCallSignature(toolName, input) {
  const sortedKeys = Object.keys(input ?? {}).sort();
  return `${toolName}:${JSON.stringify(input ?? {}, sortedKeys)}`.replace(/\s+/g, ' ');
}

export class LoopGuard {
  constructor({ turnLimit, repeatThreshold }) {
    this.turnLimit = turnBudget(turnLimit);
    this.repeatThreshold = repeatLimit(repeatThreshold);
    this.turnIndex = 0;
    this.seen = new Map();
  }

  onTurnStart(turnIndex) {
    this.turnIndex = turnIndex;
  }

  checkToolCall(toolName, input) {
    if (this.turnIndex >= this.turnLimit) {
      return {
        block: true,
        reason: `Turn budget exceeded (${this.turnLimit} turns). Stop exploring `
          + 'and return your final ARCHITECT_RESULT now, using what you already found.',
      };
    }
    const signature = toolCallSignature(toolName, input);
    const count = (this.seen.get(signature) ?? 0) + 1;
    this.seen.set(signature, count);
    if (count > this.repeatThreshold) {
      return {
        block: true,
        reason: `You already ran this exact ${toolName} call ${count - 1} times with the `
          + 'same arguments; the result will not change. Reuse the earlier result, try a '
          + 'genuinely different check, or finalize your ARCHITECT_RESULT now.',
      };
    }
    return undefined;
  }
}
