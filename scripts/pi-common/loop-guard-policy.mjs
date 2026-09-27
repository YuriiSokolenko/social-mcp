/**
 * Shared loop/stall policy for long-running Pi model sessions.
 *
 * Complexity-aware budgets start when complexity is declared, not when Pi
 * starts. Hard limits end exploration; they never prevent the agent from
 * editing the requested result or submitting it.
 */

const PROFILES = Object.freeze({
  trivial: Object.freeze({ softTurns: 3, hardTurns: 5, toolCalls: 8 }),
  normal: Object.freeze({ softTurns: 30, hardTurns: 60, toolCalls: 120 }),
  complex: Object.freeze({ softTurns: 60, hardTurns: 100, toolCalls: 240 }),
});
const COMPLETION_TOOLS = new Set(['write', 'edit', 'submit_result']);

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
    this.absoluteTurn = 0;
    this.declaredAtTurn = requireComplexity ? null : 0;
    this.explorationCalls = 0;
    this.softWarned = false;
    this.seen = new Map();
  }

  setComplexity(name) {
    if (this.complexity && this.complexity !== name) throw new Error(`Task complexity already declared as ${this.complexity}`);
    if (!this.complexity) this.declaredAtTurn = this.absoluteTurn;
    this.complexity = name;
    this.profile = complexityProfile(name);
    return this.profile;
  }

  onTurnStart(turnIndex) { this.absoluteTurn = turnIndex; }
  budgetTurn() {
    if (this.declaredAtTurn === null) return 0;
    return Math.max(0, this.absoluteTurn - this.declaredAtTurn);
  }

  takeSoftWarning() {
    if (!this.profile || this.softWarned || this.budgetTurn() < this.profile.softTurns) return undefined;
    this.softWarned = true;
    return `Execution budget is nearing its limit for a ${this.complexity} task. Stop exploring, make only the smallest remaining change, and call submit_result as soon as the acceptance criteria are satisfied.`;
  }

  checkToolCall(toolName, input) {
    if (toolName === 'declare_task_complexity') return undefined;
    if (!this.profile) return { block: true, reason: 'Declare task complexity first with declare_task_complexity (trivial, normal, or complex) before using implementation tools.' };

    // Hard budget ends exploration, not completion. The agent must always be
    // able to make/fix the requested edit and submit the result.
    if (COMPLETION_TOOLS.has(toolName)) return undefined;

    if (this.budgetTurn() >= this.profile.hardTurns) {
      return { block: true, reason: `Exploration budget exhausted for ${this.complexity} task (${this.profile.hardTurns} turns after complexity declaration). Do not inspect more context. Finish with write/edit if needed, then call submit_result.` };
    }
    if (this.explorationCalls >= this.profile.toolCalls) {
      return { block: true, reason: `Exploration tool-call budget exhausted for ${this.complexity} task (${this.profile.toolCalls} calls). Finish with write/edit if needed, then call submit_result.` };
    }
    this.explorationCalls += 1;

    const signature = toolCallSignature(toolName, input);
    const count = (this.seen.get(signature) ?? 0) + 1;
    this.seen.set(signature, count);
    if (count > this.repeatThreshold) {
      return { block: true, reason: `You already ran this exact ${toolName} call ${count - 1} times with the same arguments; reuse the earlier result, make the needed edit, or call submit_result.` };
    }
    return undefined;
  }
}
