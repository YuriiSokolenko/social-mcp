const COMPLEXITY_RANK = Object.freeze({ trivial: 0, normal: 1, complex: 2 });
export const RESPONSE_BUDGETS = Object.freeze({ short: 2048, normal: 4096, deep: 8192 });

function safePathToken(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    !value.startsWith('-') &&
    !/[?*\[]/.test(value);
}

export function isBoundedDirectBash(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed || /[\n\r;&|><`$()]/.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/);

  if (parts[0] !== 'git') return false;

  let index = 1;
  if (parts[index] === '-C') {
    if (!safePathToken(parts[index + 1])) return false;
    index += 2;
  }
  if (parts[index] === '--no-pager') index += 1;

  const commandName = parts[index];
  if (commandName === 'diff') {
    const separator = parts.lastIndexOf('--');
    if (separator <= index || separator !== parts.length - 2 || !safePathToken(parts[separator + 1])) return false;
    const allowed = new Set(['--check', '--name-only', '--stat', '--numstat', '--cached', '--staged']);
    return parts.slice(index + 1, separator).every(part =>
      allowed.has(part) || /^-U\d+$/.test(part) || /^--unified=\d+$/.test(part)
    );
  }

  if (commandName === 'status') {
    return parts.length === index + 4 &&
      (parts[index + 1] === '--short' || parts[index + 1] === '--porcelain') &&
      parts[index + 2] === '--' &&
      safePathToken(parts[index + 3]);
  }

  return false;
}
const TERMINAL_TOOLS = new Set(['submit_result', 'submit_repair']);
const ROLLBACK_TOOL = 'rollback_last_mutation';
const MUTATION_TOOLS = new Set(['safe_edit', 'edit', 'write']);
const FINISH_TOOLS = new Set([...MUTATION_TOOLS, ROLLBACK_TOOL, ...TERMINAL_TOOLS]);
const PROGRESS_TOOLS = new Set([...MUTATION_TOOLS, ROLLBACK_TOOL, ...TERMINAL_TOOLS]);

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

export function nextActionResponseCap({
  baseCap,
  retryCap,
  outputTokens,
  actionRequired,
  attemptedTool,
  madeProgress,
}) {
  if (!actionRequired) return 0;
  const base = positiveInteger(Number(baseCap), 'actionResponseMaxTokens');
  const retry = positiveInteger(Number(retryCap ?? base), 'actionResponseRetryMaxTokens');
  if (retry < base) throw new Error('actionResponseRetryMaxTokens must be >= actionResponseMaxTokens');
  const cappedProseOnlyTurn =
    Number.isFinite(outputTokens) &&
    outputTokens >= base &&
    attemptedTool !== true &&
    madeProgress !== true;
  return cappedProseOnlyTurn ? retry : base;
}

export function nextResponseBudgetLevel(currentLevel, outputTokens, budgets = RESPONSE_BUDGETS, madeProgress = true) {
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
    this.preComplexityTransitionTools = new Set(
      env.PI_PRE_COMPLEXITY_TRANSITION_TOOLS != null
        ? env.PI_PRE_COMPLEXITY_TRANSITION_TOOLS.split(',').map(x => x.trim()).filter(Boolean)
        : (config.preComplexityTransitionTools ?? []),
    );
    this.requiredFirstReadPath = env.PI_REQUIRED_FIRST_READ_PATH || config.requiredFirstReadPath || null;
    this.requiredFirstReadDone = !this.requiredFirstReadPath;
    this.complexityTurnBase = this.requiredFirstReadDone ? 0 : null;
    this.delegatedTools = new Set(config.delegatedTools ?? []);
    this.delegationTool = config.delegationTool ?? 'subagent';
    this.boundedDirectBash = config.boundedDirectBash === true;
    this.singleUseTools = new Set(config.singleUseTools ?? []);
    this.usedSingleUseTools = new Set();

    this.productiveProgress = config.productiveProgress ?? null;
    this.productiveState = this.productiveProgress?.startState ?? 'inactive';
    this.productiveActivationTool = this.productiveProgress?.activationTool ?? null;
    this.productiveActivationReadSuffix = this.productiveProgress?.activationReadSuffix ?? null;
    this.productiveBlockerTool = this.productiveProgress?.blockerTool ?? null;
    this.productiveActionTools = new Set(this.productiveProgress?.actionTools ?? []);
    this.productiveControlTools = new Set(this.productiveProgress?.controlTools ?? []);
    this.productiveInitialEvidenceBudget = positiveInteger(
      Number(this.productiveProgress?.initialEvidenceBudget ?? 1),
      'productiveProgress.initialEvidenceBudget',
    );
    this.productiveEvidenceBudgetByComplexity = Object.fromEntries(
      Object.entries(this.productiveProgress?.initialEvidenceBudgetByComplexity ?? {}).map(([complexity, value]) => [
        complexity,
        positiveInteger(
          Number(value),
          `productiveProgress.initialEvidenceBudgetByComplexity.${complexity}`,
        ),
      ]),
    );
    this.productiveEvidenceRemaining = 0;
    this.lastEvidenceRequestSignature = null;
    this.evidenceUnlockUsedSinceProgress = false;
    this.recoveryMode = false;
    this.recoveryEvidenceRemaining = 0;
    this.mutatedPaths = new Set();
    this.pendingMutationPath = null;

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
    this.turnUsedTool = false;
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

  productiveProgressState() {
    return this.productiveState;
  }

  productiveInitialEvidenceBudgetForComplexity() {
    return this.productiveEvidenceBudgetByComplexity[this.complexity] ??
      this.productiveInitialEvidenceBudget;
  }

  onTurnStart(turnIndex) {
    if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) throw new Error('turnIndex must be a non-negative integer');
    if (this.lastTurnIndex == null) this.absoluteTurn = turnIndex;
    else if (turnIndex > this.lastTurnIndex) this.absoluteTurn += turnIndex - this.lastTurnIndex;
    else this.absoluteTurn += 1;
    this.lastTurnIndex = turnIndex;
    this.turnLevel = this.level;
    this.turnMadeProgress = false;
    this.turnUsedTool = false;
  }

  checkToolCall(toolName, input) {
    if (!this.requiredFirstReadDone) {
      const requestedPath = typeof input?.path === 'string' ? input.path : '';
      const allowed = toolName === 'read' &&
        (requestedPath === this.requiredFirstReadPath || requestedPath.endsWith(`/${this.requiredFirstReadPath}`));
      if (!allowed) return { block: true, reason: `First action must be read(path: "${this.requiredFirstReadPath}"). The path is exact and already known; do not search, list directories, inspect package docs, or guess another path.` };
      this.requiredFirstReadDone = true;
      this.complexityTurnBase = this.absoluteTurn;
      this.turnUsedTool = true;
      return undefined;
    }

    const pendingComplexityTransition =
      this.requireComplexity &&
      !this.complexity &&
      this.preComplexityTransitionTools.has(toolName);
    const terminalTool = TERMINAL_TOOLS.has(toolName);
    const finishTool = FINISH_TOOLS.has(toolName);

    if (this.requireComplexity && !this.complexity) {
      const preComplexityTurns = Math.max(0, this.absoluteTurn - (this.complexityTurnBase ?? this.absoluteTurn));
      const orientationDeadlineReached = preComplexityTurns >= this.preComplexityTurnLimit;
      if (orientationDeadlineReached && !pendingComplexityTransition && !terminalTool) {
        return {
          block: true,
          reason: `BLOCKED: ${toolName} did not execute. Startup orientation used ${this.preComplexityTurnLimit} model turns after the required contract read. Use only the configured preparation/classification action or terminal submit tool now.`,
        };
      }
      if (!orientationDeadlineReached && !pendingComplexityTransition && !this.preComplexityAllowedTools.has(toolName)) {
        return {
          block: true,
          reason: `BLOCKED: ${toolName} did not execute. Before complexity is recorded, use only initial-orientation tools or the configured preparation/classification action.`,
        };
      }
    }

    if (toolName === 'bash' && this.boundedDirectBash && !isBoundedDirectBash(input?.command)) {
      return { block: true, reason: 'Direct main-agent bash is limited to a bounded git diff/status on one known path. Delegate searches, tests, logs, and broader commands.' };
    }

    if (this.delegatedTools.has(toolName)) {
      return { block: true, reason: `The main agent must not use ${toolName} directly. Delegate repository inspection, search, diagnostics, and verification through ${this.delegationTool}.` };
    }

    if (this.singleUseTools.has(toolName)) {
      if (this.usedSingleUseTools.has(toolName)) {
        return { block: true, reason: `BLOCKED: ${toolName} is single-shot and has already been attempted in this session.` };
      }
      this.usedSingleUseTools.add(toolName);
    }

    if (this.productiveProgress) {
      const requestedPath = typeof input?.path === 'string' ? input.path : '';
      const activatesOnRead =
        this.productiveState === 'inactive' &&
        this.productiveActivationReadSuffix &&
        toolName === 'read' &&
        (requestedPath === this.productiveActivationReadSuffix ||
          requestedPath.endsWith(`/${this.productiveActivationReadSuffix}`));

      if (activatesOnRead) {
        this.productiveState = 'action_required';
      } else if (this.productiveState === 'recovery_evidence_allowed') {
        if (this.productiveBlockerTool && toolName === this.productiveBlockerTool) {
          return {
            block: true,
            reason: 'BLOCKED: recovery already allows one diagnostic evidence action. Use that evidence action, fix/rollback the failed mutation, or retry submit_result.',
          };
        }
        if (toolName === ROLLBACK_TOOL || TERMINAL_TOOLS.has(toolName)) {
          // Productive recovery actions are always allowed.
        } else if (MUTATION_TOOLS.has(toolName)) {
          const path = typeof input?.path === 'string' ? input.path : '';
          if (!this.mutatedPaths.has(path)) {
            return {
              block: true,
              reason: `BLOCKED: validation recovery may safe_edit/edit/write only files already mutated in this session. ${path || 'This path'} was not previously mutated. Use the single diagnostic evidence action, rollback_last_mutation, or retry submit_result.`,
            };
          }
        } else if (!this.productiveControlTools.has(toolName)) {
          this.recoveryEvidenceRemaining = Math.max(0, this.recoveryEvidenceRemaining - 1);
          if (this.recoveryEvidenceRemaining === 0) this.productiveState = 'recovery_action_required';
        }
      } else if (this.productiveState === 'recovery_action_required') {
        if (this.productiveBlockerTool && toolName === this.productiveBlockerTool) {
          return {
            block: true,
            reason: 'BLOCKED: validation recovery evidence is exhausted. Fix an already-mutated file, call rollback_last_mutation, or retry submit_result.',
          };
        }
        if (toolName === ROLLBACK_TOOL || TERMINAL_TOOLS.has(toolName)) {
          // Productive recovery actions are always allowed.
        } else if (MUTATION_TOOLS.has(toolName)) {
          const path = typeof input?.path === 'string' ? input.path : '';
          if (!this.mutatedPaths.has(path)) {
            return {
              block: true,
              reason: `BLOCKED: validation recovery may safe_edit/edit/write only files already mutated in this session. ${path || 'This path'} was not previously mutated. Fix the touched file, rollback_last_mutation, or retry submit_result.`,
            };
          }
        } else if (!this.productiveControlTools.has(toolName)) {
          return {
            block: true,
            reason: `BLOCKED: validation recovery requires action now. ${toolName} did not execute. Fix an already-mutated file, call rollback_last_mutation, or retry submit_result.`,
          };
        }
      } else if (this.productiveState === 'action_required') {
        if (this.productiveBlockerTool && toolName === this.productiveBlockerTool) {
          const blockerSignature = toolCallSignature(toolName, input);
          if (blockerSignature === this.lastEvidenceRequestSignature) {
            return {
              block: true,
              reason: 'BLOCKED: the same missing-evidence request was already used. Act on the evidence already gathered before requesting more.',
            };
          }
          if (this.evidenceUnlockUsedSinceProgress) {
            return {
              block: true,
              reason: 'BLOCKED: an extra evidence permit was already used since the last successful safe_edit/edit/write/submit_result. Act on the evidence already gathered before requesting more.',
            };
          }
          this.lastEvidenceRequestSignature = blockerSignature;
          this.evidenceUnlockUsedSinceProgress = true;
          this.productiveEvidenceRemaining = 1;
          this.productiveState = 'evidence_allowed';
        } else if (!this.productiveActionTools.has(toolName) && !this.productiveControlTools.has(toolName)) {
          return {
            block: true,
            reason: this.productiveBlockerTool
              ? `BLOCKED: productive progress requires an action now. ${toolName} did not execute. Use safe_edit/edit/write/submit_result, or call ${this.productiveBlockerTool} with one concrete missing fact to unlock exactly one evidence action.`
              : `BLOCKED: classification evidence is complete. ${toolName} did not execute. Call submit_result now.`,
          };
        }
      } else if (this.productiveState === 'evidence_allowed') {
        if (this.productiveBlockerTool && toolName === this.productiveBlockerTool) {
          return {
            block: true,
            reason: 'BLOCKED: one evidence action is already permitted. Execute that evidence action before declaring another blocker.',
          };
        }
        if (!this.productiveActionTools.has(toolName) && !this.productiveControlTools.has(toolName)) {
          // Consume bounded evidence budget at accepted call time. This still
          // prevents unbounded parallel exploration, while allowing a short
          // locate -> read -> anchor sequence before mutation is required.
          this.productiveEvidenceRemaining = Math.max(0, this.productiveEvidenceRemaining - 1);
          if (this.productiveEvidenceRemaining === 0) this.productiveState = 'action_required';
        }
      }
    }

    if (this.absoluteTurn >= this.turnLimit && !finishTool && !pendingComplexityTransition) {
      return {
        block: true,
        reason: `BLOCKED: ${toolName} did not execute. Global execution limit reached (${this.turnLimit} turns). Exploration is closed; use only the pending preparation/classification action or terminal submit tool to finish.`,
      };
    }

    if (MUTATION_TOOLS.has(toolName)) {
      this.pendingMutationPath = typeof input?.path === 'string' ? input.path : null;
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
    this.turnUsedTool = true;
    return undefined;
  }

  onToolExecutionEnd(toolName, isError) {
    if (this.productiveProgress && MUTATION_TOOLS.has(toolName)) {
      if (!isError && this.pendingMutationPath) this.mutatedPaths.add(this.pendingMutationPath);
      this.pendingMutationPath = null;
    }
    if (this.productiveProgress && TERMINAL_TOOLS.has(toolName) && isError) {
      this.recoveryMode = true;
      this.recoveryEvidenceRemaining = 1;
      this.productiveState = 'recovery_evidence_allowed';
      this.evidenceUnlockUsedSinceProgress = true;
    }
    if (!isError && this.productiveProgress && toolName === this.productiveActivationTool) {
      this.productiveEvidenceRemaining = this.productiveInitialEvidenceBudgetForComplexity();
      this.productiveState = 'evidence_allowed';
      this.evidenceUnlockUsedSinceProgress = false;
    }
    if (!isError && this.productiveProgress && this.productiveActionTools.has(toolName)) {
      if (toolName === ROLLBACK_TOOL) {
        this.recoveryMode = false;
        this.recoveryEvidenceRemaining = 0;
        this.evidenceUnlockUsedSinceProgress = false;
        this.productiveState = 'action_required';
      } else if (!this.recoveryMode) {
        this.evidenceUnlockUsedSinceProgress = false;
        if (this.productiveState === 'evidence_allowed') this.productiveState = 'action_required';
      } else if (TERMINAL_TOOLS.has(toolName)) {
        this.recoveryMode = false;
        this.recoveryEvidenceRemaining = 0;
      } else {
        this.productiveState = 'recovery_action_required';
      }
    }
    if (!isError && (PROGRESS_TOOLS.has(toolName) || this.preComplexityTransitionTools.has(toolName))) {
      this.turnMadeProgress = true;
    }
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
    const ceiling = this.budgets[this.turnLevel];
    const preserveElevatedToolTurn =
      this.turnLevel !== 'short' &&
      outputTokens < ceiling &&
      this.turnUsedTool;
    const next = preserveElevatedToolTurn
      ? this.turnLevel
      : nextResponseBudgetLevel(this.turnLevel, outputTokens, this.budgets, this.turnMadeProgress);
    this.level = next;
    return {
      changed: next !== this.turnLevel,
      level: next,
      maxTokens: this.budgets[next],
      madeProgress: this.turnMadeProgress,
      preservedForToolTurn: preserveElevatedToolTurn,
    };
  }
}
