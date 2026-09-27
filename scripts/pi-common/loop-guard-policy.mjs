/**
 * Shared loop/stall policy for long-running Pi model sessions.
 *
 * Complexity is descriptive metadata, not an execution quota. The guard only
 * enforces a global turn ceiling and repeated-call protection. Complexity may
 * be escalated when investigation reveals broader scope, but never downgraded.
 */

const COMPLEXITY_RANK = Object.freeze({ trivial: 0, normal: 1, complex: 2 });

export function turnBudget(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('PI_MAX_TURNS must be a positive integer');
  return limit;
}

export function repeatLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('PI_MAX_REPEAT_CALLS must be a positive integer');
  return limit;
}

export function validateComplexity(name) {
  if (!(name in COMPLEXITY_RANK)) throw new Error(`Unknown task complexity: ${name}`);
  return name;
}

export function toolCallSignature(toolName, input) {
  const sortedKeys = Object.keys(input ?? {}).sort();
  return `${toolName}:${JSON.stringify(input ?? {}, sortedKeys)}`.replace(/\s+/g, ' ');
}

export class LoopGuard {
  constructor({ turnLimit = 100, repeatThreshold, requireComplexity = false }) {
    this.turnLimit = turnBudget(turnLimit);
    this.repeatThreshold = repeatLimit(repeatThreshold);
    this.requireComplexity = requireComplexity;
    this.complexity = requireComplexity ? null : 'default';
    this.absoluteTurn = 0;
    this.seen = new Map();
  }

  setComplexity(name) {
    validateComplexity(name);
    if (this.complexity && this.complexity !== 'default') {
      const current = COMPLEXITY_RANK[this.complexity];
      const next = COMPLEXITY_RANK[name];
      if (next < current) throw new Error(`Task complexity cannot be downgraded from ${this.complexity} to ${name}`);
      if (next === current) return { complexity: this.complexity, changed: false };
    }
    const previous = this.complexity;
    this.complexity = name;
    return { complexity: name, previous, changed: previous !== name };
  }

  onTurnStart(turnIndex) { this.absoluteTurn = turnIndex; }

  checkToolCall(toolName, input) {
    if (toolName === 'declare_task_complexity') return undefined;
    if (this.requireComplexity && !this.complexity) {
      return { block: true, reason: 'Declare task complexity first with declare_task_complexity (trivial, normal, or complex) before using other tools.' };
    }
    if (this.absoluteTurn >= this.turnLimit) {
      return { block: true, reason: `Global execution limit reached (${this.turnLimit} turns). Stop investigating and finish with the available evidence.` };
    }

    const signature = toolCallSignature(toolName, input);
    const count = (this.seen.get(signature) ?? 0) + 1;
    this.seen.set(signature, count);
    if (count > this.repeatThreshold) {
      return { block: true, reason: `You already ran this exact ${toolName} call ${count - 1} times with the same arguments; reuse the earlier result or change strategy.` };
    }
    return undefined;
  }
}
