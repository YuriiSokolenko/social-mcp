/**
 * Shared loop/stall policy for long-running Pi model sessions.
 *
 * The guard defines deterministic operational limits used by wrappers around
 * model execution. It stops runaway exploration; it never decides whether an
 * implementation is correct.
 */

const PROFILES = Object.freeze({
  trivial: Object.freeze({ softTurns: 3, hardTurns: 5, toolCalls: 8 }),
  normal: Object.freeze({ softTurns: 30, hardTurns: 60, toolCalls: 120 }),
  complex: Object.freeze({ softTurns: 60, hardTurns: 100, toolCalls: 240 }),
});

export function turnBudget(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('PI_MAX_TURNS must be a positive integer');
  return limit;
}

export function repeatLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('PI_MAX_REPEAT_CALLS must be a positive integer');
  return limit;
}

export function complexityProfile(name) {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`Unknown task complexity: ${name}`);
  return profile;
}

export function toolCallSignature(toolName, input) {
  const sortedKeys = Object.keys(input ?? {}).sort();
  return `${toolName}:${JSON.stringify(input ?? {}, sortedKeys)}`.replace(/\s+/g, ' ');
}

export class LoopGuard {
  constructor({ turnLimit = 100, repeatThreshold, requireComplexity = false }) {
    this.defaultTurnLimit = turnBudget(turnLimit);
    this.repeatThreshold = repeatLimit(repeatThreshold);
    this.requireComplexity = requireComplexity;
    this.profile = requireComplexity ? null : { softTurns: this.defaultTurnLimit, hardTurns: this.defaultTurnLimit, toolCalls: Number.MAX_SAFE_INTEGER };
    this.complexity = requireComplexity ? null : 'default';
    this.turnIndex = 0;
    this.toolCalls = 0;
    this.softWarned = false;
    this.seen = new Map();
  }

  setComplexity(name) {
    if (this.complexity && this.complexity !== name) throw new Error(`Task complexity already declared as ${this.complexity}`);
    this.complexity = name;
    this.profile = complexityProfile(name);
    return this.profile;
  }

  onTurnStart(turnIndex) {
    this.turnIndex = turnIndex;
  }

  takeSoftWarning() {
    if (!this.profile || this.softWarned || this.turnIndex < this.profile.softTurns) return undefined;
    this.softWarned = true;
    return `Execution budget is nearing its limit for a ${this.complexity} task. Stop exploring, make only the smallest remaining change, and call submit_result as soon as the acceptance criteria are satisfied.`;
  }

  checkToolCall(toolName, input) {
    if (toolName === 'declare_task_complexity') return undefined;
    if (!this.profile) {
      return {
        block: true,
        reason: 'Declare task complexity first with declare_task_complexity (trivial, normal, or complex) before using implementation tools.',
      };
    }
    // Submission must remain reachable even after the exploration budget is exhausted.
    if (toolName === 'submit_result') return undefined;

    if (this.turnIndex >= this.profile.hardTurns) {
      return {
        block: true,
        reason: `Hard turn budget exceeded for ${this.complexity} task (${this.profile.hardTurns} turns). Further exploration is blocked; call submit_result now.`,
      };
    }
    if (this.toolCalls >= this.profile.toolCalls) {
      return {
        block: true,
        reason: `Tool-call budget exceeded for ${this.complexity} task (${this.profile.toolCalls} calls). Further exploration is blocked; call submit_result now.`,
      };
    }
    this.toolCalls += 1;

    const signature = toolCallSignature(toolName, input);
    const count = (this.seen.get(signature) ?? 0) + 1;
    this.seen.set(signature, count);
    if (count > this.repeatThreshold) {
      return {
        block: true,
        reason: `You already ran this exact ${toolName} call ${count - 1} times with the same arguments; reuse the earlier result, try a genuinely different check, or call submit_result now.`,
      };
    }
    return undefined;
  }
}
