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
const WRITE_TOOLS = new Set(['write', 'edit']);
const READ_ONLY_BASH = /^\s*(?:pwd|ls(?:\s|$)|find(?:\s|$)|grep(?:\s|$)|rg(?:\s|$)|git\s+(?:log|status|show|diff|branch|rev-parse)(?:\s|$)|cat(?:\s|$)|head(?:\s|$)|tail(?:\s|$))/;
const VALIDATION_BASH = /(?:^|\s)(?:pytest|ruff|mypy|pyright|npm\s+test|npm\s+run\s+(?:test|lint|check)|gradle\w*\s+test|\.\/gradlew\s+\S*test)(?:\s|$)/;

export function toolPhase(toolName, input = {}) {
  if (toolName === 'submit_result') return 'submit';
  if (WRITE_TOOLS.has(toolName)) return 'implement';
  if (toolName === 'bash') {
    const command = String(input.command ?? '').trim();
    if (VALIDATION_BASH.test(command)) return 'validate';
    if (READ_ONLY_BASH.test(command)) return 'explore';
    return 'implement';
  }
  return 'explore';
}

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
  constructor({ turnLimit = 100, repeatThreshold, requireComplexity = false, reviewMode = false, reviewPathsJson = '[]' }) {
    this.defaultTurnLimit = turnBudget(turnLimit);
    this.repeatThreshold = repeatLimit(repeatThreshold);
    this.requireComplexity = requireComplexity;
    this.reviewMode = reviewMode;
    this.reviewPaths = new Set(JSON.parse(reviewPathsJson || '[]'));
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

  checkTrivialReviewScope(toolName, input = {}) {
    if (toolName === 'submit_result') return undefined;
    if (toolName.startsWith('searxng_') || toolName.includes('web_') || toolName.includes('search')) {
      return { block: true, reason: 'Trivial review is scoped to the linked issue, PR diff, and changed files; external or repository-wide search is not allowed.' };
    }
    if (toolName === 'read') {
      const path = String(input.path ?? '');
      if (path.endsWith('/agents/reviewer/AGENTS.md') || path === 'agents/reviewer/AGENTS.md') return undefined;
      if ([...this.reviewPaths].some(changed => path === changed || path.endsWith('/' + changed))) return undefined;
      return { block: true, reason: 'Trivial review may read only reviewer instructions and files changed by this PR.' };
    }
    if (toolName === 'bash') {
      const command = String(input.command ?? '');
      if (/git\s+(?:log|branch|config|remote|status|rev-parse)|(?:^|\s)(?:find|grep|rg|ls)(?:\s|$)|python(?:3)?\s+-c/.test(command)) {
        return { block: true, reason: 'Trivial review does not allow repository/history/config enumeration or ad-hoc verification scripts. Inspect the PR diff and changed files only.' };
      }
      if (/git\s+(?:diff|show)(?:\s|$)/.test(command)) return undefined;
      if (/gh\s+(?:issue|pr)\s+view(?:\s|$)/.test(command)) return undefined;
      if ([...this.reviewPaths].some(changed => command.includes(changed)) && /(?:cat|head|tail|od)(?:\s|$)/.test(command)) return undefined;
      return { block: true, reason: 'Trivial review bash is limited to the linked issue, PR diff, and changed-file inspection.' };
    }
    return { block: true, reason: 'This tool is outside the allowed scope of a trivial review. Use only the linked issue, PR diff, changed files, then submit_result.' };
  }

  checkToolCall(toolName, input) {
    if (toolName === 'declare_task_complexity') return undefined;
    if (!this.profile) return { block: true, reason: 'Declare task complexity first with declare_task_complexity (trivial, normal, or complex) before using implementation tools.' };

    if (this.reviewMode && this.complexity === 'trivial') {
      const blocked = this.checkTrivialReviewScope(toolName, input);
      if (blocked) return blocked;
    }
    const phase = toolPhase(toolName, input);
    // Only exploration consumes the exploration budget. Implementation,
    // focused validation, and submission remain available so the task can
    // converge after the context-gathering budget is exhausted.
    if (phase !== 'explore') return undefined;

    if (this.budgetTurn() >= this.profile.hardTurns) {
      return { block: true, reason: `Exploration budget exhausted for ${this.complexity} task (${this.profile.hardTurns} turns after complexity declaration). Do not inspect more context. Implement/validate only what is already known, then call submit_result.` };
    }
    const toolCallLimit = this.profile.toolCalls;
    if (this.explorationCalls >= toolCallLimit) {
      return { block: true, reason: `Exploration tool-call budget exhausted for ${this.complexity} task (${toolCallLimit} calls). Implement/validate only what is already known, then call submit_result.` };
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
