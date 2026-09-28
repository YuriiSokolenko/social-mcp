const COMPLEXITY_RANK = Object.freeze({ trivial: 0, normal: 1, complex: 2 });
export const RESPONSE_BUDGETS = Object.freeze({ short: 2048, normal: 4096, deep: 8192 });

const FINISH_TOOLS = new Set(['edit', 'write', 'submit_result', 'submit_repair']);
const PROGRESS_TOOLS = new Set(['edit', 'write', 'submit_result', 'submit_repair']);

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function canonicalize(value, key = '') {
  if (Array.isArray(value)) return value.map(item => canonicalize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonicalize(value[name], name)]));
  }
  if (typeof value === 'string' && key === 'command') return value.replace(/\s+/g, ' ').trim();
  return value;
}

export function toolCallSignature(toolName, input) {
  return `${toolName}:${JSON.stringify(canonicalize(input ?? {}))}`;
}

export function nextResponseBudgetLevel(currentLevel, outputTokens, budgets = RESPONSE_BUDGETS, { madeProgress = false } = {}) {
  const ceiling = budgets[currentLevel];
  if (!ceiling) throw new Error(`Unknown response budget: ${currentLevel}`);
  if (!Number.isFinite(outputTokens) || outputTokens < 0) throw new Error('outputTokens must be a non-negative number');
  if (outputTokens < ceiling || !madeProgress) return 'short';
  if (currentLevel === 'short') return 'normal';
  if (currentLevel === 'normal') return 'deep';
  return 'short';
}

export class ProgressController {
  constructor(config, env = process.env) {
    this.turnLimit = positiveInteger(Number(env.PI_MAX_TURNS ?? config.maxTurns ?? 100), 'PI_MAX_TURNS');
    this.repeatThreshold = positiveInteger(Number(env.PI_MAX_REPEAT_CALLS ?? config.repeatThreshold ?? 3), 'PI_MAX_REPEAT_CALLS');
    this.requireComplexity = env.PI_REQUIRE_TASK_COMPLEXITY === '1' || (env.PI_REQUIRE_TASK_COMPLEXITY == null && config.requireComplexity === true);
    this.preComplexityTurnLimit = positiveInteger(Number(env.PI_MAX_PRE_COMPLEXITY_TURNS ?? config.preComplexityTurnLimit ?? 8), 'PI_MAX_PRE_COMPLEXITY_TURNS');
    this.preComplexityAllowedTools = new Set(
      env.PI_PRE_COMPLEXITY_ALLOWED_TOOLS != null
        ? env.PI_PRE_COMPLEXITY_ALLOWED_TOOLS.split(',').map(x => x.trim()).filter(Boolean)
        : (config.preComplexityAllowedTools ?? []),
    );
    this.requiredFirstReadPath = env.PI_REQUIRED_FIRST_READ_PATH || config.requiredFirstReadPath || null;
    this.requiredFirstReadDone = !this.requiredFirstReadPath;

    this.fixedMaxTokens = Number(env.PI_FIXED_RESPONSE_MAX_TOKENS ?? config.fixedResponseMaxTokens ?? 0);
    if (this.fixedMaxTokens && (!Number.isSafeInteger(this.fixedMaxTokens) || this.fixedMaxTokens < 1)) {
      throw new Error('PI_FIXED_RESPONSE_MAX_TOKENS must be a positive integer');
    }
    this.budgets = {
      short: positiveInteger(Number(env.PI_RESPONSE_BUDGET_SHORT ?? RESPONSE_BUDGETS.short), 'PI_RESPONSE_BUDGET_SHORT'),
      normal: positiveInteger(Number(env.PI_RESPONSE_BUDGET_NORMAL ?? RESPONSE_BUDGETS.normal), 'PI_RESPONSE_BUDGET_NORMAL'),
      deep: positiveInteger(Number(env.PI_RESPONSE_BUDGET_DEEP ?? RESPONSE_BUDGETS.deep), 'PI_RESPONSE_BUDGET_DEEP'),
    };

    this.complexity = this.requireComplexity ? null : 'default';
    this.absoluteTurn = 0;
    this.lastTurnIndex = null;
    this.lastSignature = null;
    this.repeatCount = 0;
    this.level = 'short';
    this.turnLevel = 'short';
    this.explicitNextResponse = false;
    this.turnMadeProgress = false;
  }

  setComplexity(name) {
    if (!(name in COMPLEXITY_RANK)) throw new Error(`Unknown task complexity: ${name}`);
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
    if (this.lastTurnIndex == null) this.absoluteTurn = turnIndex;
    else if (turnIndex > this.lastTurnIndex) this.absoluteTurn += turnIndex - this.lastTurnIndex;
    else this.absoluteTurn += 1;
    this.lastTurnIndex = turnIndex;
    this.turnLevel = this.level;
    this.turnMadeProgress = false;
  }

  checkToolCall(toolName, input) {
    if (!this.requiredFirstReadDone) {
      const requestedPath = typeof input?.path === 'string' ? input.path : '';
      const allowed = toolName === 'read' &&
        (requestedPath === this.requiredFirstReadPath || requestedPath.endsWith(`/${this.requiredFirstReadPath}`));
      if (!allowed) return { block: true, reason: `First read the required operating contract: ${this.requiredFirstReadPath}` };
      this.requiredFirstReadDone = true;
    }

    if (toolName === 'declare_task_complexity') return undefined;

    if (this.requireComplexity && !this.complexity) {
      if (this.absoluteTurn >= this.preComplexityTurnLimit) {
        return { block: true, reason: `Startup orientation used ${this.preComplexityTurnLimit} model turns. Stop exploring and call declare_task_complexity now.` };
      }
      if (!this.preComplexityAllowedTools.has(toolName)) {
        return { block: true, reason: 'Before complexity declaration, use only the bounded orientation tools, then declare complexity and execute the plan.' };
      }
    }

    if (this.absoluteTurn >= this.turnLimit && !FINISH_TOOLS.has(toolName)) {
      return { block: true, reason: `Global execution limit reached (${this.turnLimit} turns). Exploration is closed; use only edit/write and the terminal submit tool to finish.` };
    }

    const signature = toolCallSignature(toolName, input);
    if (signature === this.lastSignature) this.repeatCount += 1;
    else {
      this.lastSignature = signature;
      this.repeatCount = 1;
    }
    if (this.repeatCount > this.repeatThreshold) {
      return { block: true, reason: `You already ran this exact ${toolName} call ${this.repeatCount - 1} times consecutively; reuse the result or change strategy.` };
    }
    return undefined;
  }

  onToolExecutionEnd(toolName, isError) {
    if (!isError && PROGRESS_TOOLS.has(toolName)) this.turnMadeProgress = true;
  }

  currentMaxTokens() {
    return this.fixedMaxTokens || this.budgets[this.level];
  }

  setBudget(level) {
    if (!(level in this.budgets)) throw new Error(`Unknown response budget: ${level}`);
    this.level = level;
    this.explicitNextResponse = true;
    return this.budgets[level];
  }

  modelFor(model, level = this.level) {
    if (!model) throw new Error('No active model is available for response budgeting');
    return { ...model, maxTokens: this.fixedMaxTokens || this.budgets[level] };
  }

  afterTurn(outputTokens) {
    if (this.fixedMaxTokens) return { changed: false, level: 'fixed', maxTokens: this.fixedMaxTokens };
    if (this.explicitNextResponse) {
      this.explicitNextResponse = false;
      return { changed: false, level: this.level, maxTokens: this.budgets[this.level], explicit: true };
    }
    const next = nextResponseBudgetLevel(this.turnLevel, outputTokens, this.budgets, { madeProgress: this.turnMadeProgress });
    this.level = next;
    return { changed: true, level: next, maxTokens: this.budgets[next], madeProgress: this.turnMadeProgress };
  }
}
