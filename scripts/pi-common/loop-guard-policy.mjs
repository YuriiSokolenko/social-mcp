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

function canonicalize(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonicalize(value[name], name)]));
  }
  if (typeof value === 'string' && key === 'command') return value.replace(/\s+/g, ' ').trim();
  return value;
}

export function toolCallSignature(toolName, input) {
  return `${toolName}:${JSON.stringify(canonicalize(input ?? {}))}`;
}

const FIRST_EDIT_TOOLS = new Set(['edit', 'write']);
const FINISH_TOOLS = new Set(['edit', 'write', 'submit_result', 'submit_repair']);

export class LoopGuard {
  constructor({ turnLimit = 100, repeatThreshold, requireComplexity = false, preComplexityAllowedTools = [], preComplexityTurnLimit = 8, requiredFirstReadPath = null }) {
    this.turnLimit = turnBudget(turnLimit);
    this.repeatThreshold = repeatLimit(repeatThreshold);
    this.requireComplexity = requireComplexity;
    this.preComplexityTurnLimit = turnBudget(preComplexityTurnLimit);
    this.preComplexityAllowedTools = new Set(preComplexityAllowedTools);
    this.requiredFirstReadPath = requiredFirstReadPath;
    this.requiredFirstReadDone = !requiredFirstReadPath;
    this.complexity = requireComplexity ? null : 'default';
    this.absoluteTurn = 0;
    this.lastTurnIndex = null;
    this.lastSignature = null;
    this.repeatCount = 0;
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

  onTurnStart(turnIndex) {
    if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) throw new Error('turnIndex must be a non-negative integer');
    if (this.lastTurnIndex == null) {
      this.absoluteTurn = turnIndex;
    } else if (turnIndex > this.lastTurnIndex) {
      this.absoluteTurn += turnIndex - this.lastTurnIndex;
    } else {
      // Pi restarts turnIndex at 0 after context compaction. Keep the guard
      // monotonic so compaction cannot reset global/orientation safety limits.
      this.absoluteTurn += 1;
    }
    this.lastTurnIndex = turnIndex;
  }

  onToolExecutionEnd(toolName, isError) {
    if (!isError && FIRST_EDIT_TOOLS.has(toolName)) this.repositoryEditSeen = true;
  }

  checkToolCall(toolName, input) {
    if (!this.requiredFirstReadDone) {
      const requestedPath = typeof input?.path === 'string' ? input.path : '';
      const allowed = toolName === 'read' && (requestedPath === this.requiredFirstReadPath || requestedPath.endsWith(`/${this.requiredFirstReadPath}`));
      if (!allowed) return { block: true, reason: `First read the required operating contract: ${this.requiredFirstReadPath}` };
      this.requiredFirstReadDone = true;
    }
    if (toolName === 'declare_task_complexity') return undefined;
    if (this.requireComplexity && this.complexity && this.complexity !== 'default' && !this.repositoryEditSeen &&
        !FIRST_EDIT_TOOLS.has(toolName)) {
      return { block: true, reason: 'Complexity is declared and the execution plan is fixed. The next tool call must make the first successful repository edit with edit or write; do not inspect, test, load skills, or continue analysis first.' };
    }
    if (this.requireComplexity && !this.complexity) {
      if (this.absoluteTurn >= this.preComplexityTurnLimit) {
        return { block: true, reason: `Startup orientation has already used ${this.preComplexityTurnLimit} model turns. Stop inspecting or reconsidering. Use the evidence already collected, state the short plan if needed, and call declare_task_complexity now.` };
      }
      if (!this.preComplexityAllowedTools.has(toolName)) {
        return { block: true, reason: 'Before complexity declaration, finish the required startup orientation and plan using only the allowed inspection tools. Repository edits, skills, submission, and other work require declare_task_complexity first.' };
      }
    }
    if (this.absoluteTurn >= this.turnLimit && !FINISH_TOOLS.has(toolName)) {
      return { block: true, reason: `Global execution limit reached (${this.turnLimit} turns). Exploration is closed. Finish using only edit/write and the terminal submit tool with the evidence already collected.` };
    }

    const signature = toolCallSignature(toolName, input);
    if (signature === this.lastSignature) this.repeatCount += 1;
    else {
      this.lastSignature = signature;
      this.repeatCount = 1;
    }
    if (this.repeatCount > this.repeatThreshold) {
      return { block: true, reason: `You already ran this exact ${toolName} call ${this.repeatCount - 1} times consecutively with the same arguments; reuse the earlier result or change strategy.` };
    }
    return undefined;
  }
}
