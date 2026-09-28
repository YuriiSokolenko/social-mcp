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
  constructor({ turnLimit = 100, repeatThreshold, requireComplexity = false, preComplexityAllowedTools = [], requiredFirstReadPath = null }) {
    this.turnLimit = turnBudget(turnLimit);
    this.repeatThreshold = repeatLimit(repeatThreshold);
    this.requireComplexity = requireComplexity;
    this.preComplexityAllowedTools = new Set(preComplexityAllowedTools);
    this.requiredFirstReadPath = requiredFirstReadPath;
    this.requiredFirstReadDone = !requiredFirstReadPath;
    this.complexity = requireComplexity ? null : 'default';
    this.absoluteTurn = 0;
    this.seen = new Map();
    this.repositoryEditSeen = false;
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
    if (!this.requiredFirstReadDone) {
      const requestedPath = typeof input?.path === 'string' ? input.path : '';
      const allowed = toolName === 'read' && (requestedPath === this.requiredFirstReadPath || requestedPath.endsWith(`/${this.requiredFirstReadPath}`));
      if (!allowed) return { block: true, reason: `First read the required operating contract: ${this.requiredFirstReadPath}` };
      this.requiredFirstReadDone = true;
    }
    if (toolName === 'declare_task_complexity') return undefined;
    if (this.requireComplexity && this.complexity && this.complexity !== 'default' && !this.repositoryEditSeen) {
      if (toolName === 'edit' || toolName === 'write') {
        this.repositoryEditSeen = true;
      } else {
        return { block: true, reason: 'Complexity is declared and the execution plan is fixed. The next tool call must make the first repository edit with edit or write; do not inspect, test, load skills, or continue analysis first.' };
      }
    }
    if (this.requireComplexity && !this.complexity) {
      if (!this.preComplexityAllowedTools.has(toolName)) {
        return { block: true, reason: 'Before complexity declaration, finish the required startup orientation and plan using only the allowed inspection tools. Repository edits, skills, submission, and other work require declare_task_complexity first.' };
      }
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
