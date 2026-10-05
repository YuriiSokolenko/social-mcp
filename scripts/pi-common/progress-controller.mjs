import { SessionTransitions } from './session-state.mjs';
const COMPLEXITY_RANK = Object.freeze({ trivial: 0, nontrivial: 1, normal: 1, complex: 2 });
// Ceiling for the one-shot elevated mutation response: generated source is embedded in
// tool-call arguments, so a small ceiling truncates a large `write`/`edit` before it executes.
// This budget is granted for exactly one response (see `largeMutationBudgetTool`); normal
// implementer turns use the small `RESPONSE_BUDGETS`/`actionResponseMaxTokens` ceiling.
export const IMPLEMENTER_RESPONSE_MAX_TOKENS = 16384;
export const RESPONSE_BUDGETS = Object.freeze({ short: 2048, normal: 4096, deep: 8192 });
// Planner infrastructure fallback gets a deterministic, bounded repository-orientation window.
// Two evidence attempts are enough to locate the canonical source/test layout without reopening
// general exploration; the first successful mutation closes the window early.
export const PREPARATION_FALLBACK_EVIDENCE_BUDGET = 2;

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
const ACCEPT_MUTATION_SCOPE_TOOL = 'accept_mutation_scope';
// `begin_coding_session` hands the rest of the work to a 16k fork of this session that mutates
// the worktree through the normal tools, so it earns the same progress/verification accounting.
const MUTATION_TOOLS = new Set(['structural_edit', 'safe_edit', 'edit', 'write', 'begin_coding_session', 'recover_worktree', 'undo_mutation']);
// Actual finish actions that consume a one-shot elevated mutation response.
export const FINISH_TOOLS = new Set([...MUTATION_TOOLS, ROLLBACK_TOOL, ...TERMINAL_TOOLS]);
// Scope declaration is a trusted prelude, not the mutation payload itself. It is allowed while
// an elevated mutation budget is active, but must not consume that budget before the real edit.
export const ELEVATED_MUTATION_TURN_TOOLS = new Set([...FINISH_TOOLS, ACCEPT_MUTATION_SCOPE_TOOL]);
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

function recoveryVerificationSignature(toolName, input) {
  const normalized = {};
  const kind = typeof input?.kind === 'string' ? input.kind.trim() : '';
  const profile = typeof input?.profile === 'string' ? input.profile.trim() : '';
  const normalizeList = value => [...new Set(
    (Array.isArray(value) ? value : [])
      .filter(item => typeof item === 'string' && item.trim())
      .map(item => item.trim()),
  )].sort();
  const paths = normalizeList(input?.paths);
  const targets = normalizeList(input?.targets);
  if (kind) normalized.kind = kind;
  if (profile) normalized.profile = profile;
  if (paths.length) normalized.paths = paths;
  if (targets.length) normalized.targets = targets;
  return toolCallSignature(toolName, normalized);
}

export function validateSingleEvidenceRequest(input = {}) {
  const missing = typeof input.missing === 'string' ? input.missing.trim() : '';
  if (!missing) return { ok: false, reason: 'need_more_evidence requires one concrete missing fact.' };

  // Natural-language fact counting is not reliable: punctuation, conjunctions, words such as
  // "plus", and multi-path comparisons all have legitimate single-fact uses. The enforceable
  // boundary is therefore operational, not lexical: one blocker invocation opens exactly one
  // evidence tool call, after which the controller returns to action_required.
  return { ok: true };
}

const TRUNCATED_TOOL_CALL_PATTERN = /output token limit|arguments may be truncated/i;

export function classifyTruncatedToolCall({ toolName, isError, text }) {
  if (!isError || !TRUNCATED_TOOL_CALL_PATTERN.test(String(text ?? ''))) return null;
  return { kind: 'tool_call_truncated', toolName };
}

const DIRECT_PAYLOAD_TOOLS = new Set(['structural_edit', 'safe_edit', 'edit', 'write']);

export function truncatedToolCallGuidance(toolName, { largeMutationBudgetTool = null, codingSessionTool = null } = {}) {
  if (codingSessionTool && DIRECT_PAYLOAD_TOOLS.has(toolName)) {
    return `Your previous "${toolName}" tool call was NOT executed: the response hit the completion-token limit, so its arguments were cut off and nothing was changed. `
      + 'The change is too large for the normal Implementer response. Do not regenerate the payload in this response. '
      + `Call ${codingSessionTool} now: the runtime continues this same session with a large output ceiling, `
      + 'where you write the code and tests, run checks, fix and submit.';
  }
  const splitAdvice = 'Make the next mutation smaller: split the change across several smaller write/edit/safe_edit calls '
    + '(for a new file, write a minimal skeleton first, then add sections with separate edits).';
  const budgetAdvice = largeMutationBudgetTool
    ? ` If the full payload genuinely needs more room, call ${largeMutationBudgetTool} first, then retry once in that one elevated response.`
    : '';
  return `Your previous "${toolName}" tool call was NOT executed: the response hit the completion-token limit, so its arguments were cut off and nothing was changed. `
    + `${splitAdvice}${budgetAdvice} Do not resend the same large call.`;
}

export function nextActionResponseCap({
  baseCap,
  retryCap,
  actionRequired,
  attemptedTool,
  madeProgress,
}) {
  if (!actionRequired) return 0;
  const base = positiveInteger(Number(baseCap), 'actionResponseMaxTokens');
  const corrective = positiveInteger(Number(retryCap ?? base), 'actionResponseRetryMaxTokens');
  const proseOnlyTurn = attemptedTool !== true && madeProgress !== true;
  // Corrective steering must never reduce the model below the normal action
  // budget: small retry caps can truncate reasoning before the tool call.
  return proseOnlyTurn ? Math.max(base, corrective) : base;
}

export function nextActionRequiredProseOnlyTurns(
  current,
  { actionRequired, attemptedTool, madeProgress, responseHitOutputCeiling = false },
) {
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error('action-required prose-only turn count must be a non-negative integer');
  }
  if (!actionRequired || attemptedTool === true || madeProgress === true) return 0;
  // A response that consumed the entire active output budget may contain a
  // truncated tool call that never reached the tool_call hook. Do not count
  // that turn as prose-only, but preserve any earlier prose-only strike.
  if (responseHitOutputCeiling === true) return current;
  return current + 1;
}

// Consecutive action-required responses that consumed the whole output ceiling without
// attempting any tool: typically code being drafted in reasoning (or a cut-off tool call).
// The prose-only counter above deliberately ignores such turns, so they need their own bound.
export const MAX_CEILING_WITHOUT_TOOL_TURNS = 3;

export function nextCeilingWithoutToolTurns(
  current,
  { actionRequired, attemptedTool, madeProgress, responseHitOutputCeiling },
) {
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error('ceiling-without-tool turn count must be a non-negative integer');
  }
  if (!actionRequired || attemptedTool === true || madeProgress === true) return 0;
  return responseHitOutputCeiling === true ? current + 1 : 0;
}

export function actionRequiredToolNames(
  activeToolNames,
  { actionTools = [], controlTools = [], blockerTool = null, verificationTools = [] } = {},
) {
  if (!Array.isArray(activeToolNames)) {
    throw new Error('activeToolNames must be an array');
  }
  const allowed = new Set([...actionTools, ...controlTools, ...verificationTools]);
  if (blockerTool) allowed.add(blockerTool);
  return activeToolNames.filter(name => allowed.has(name));
}

export function elevatedMutationTurnToolNames(activeToolNames, { blockerTool = null } = {}) {
  if (!Array.isArray(activeToolNames)) throw new Error('activeToolNames must be an array');
  const allowed = new Set(ELEVATED_MUTATION_TURN_TOOLS);
  if (blockerTool) allowed.add(blockerTool);
  return activeToolNames.filter(name => allowed.has(name));
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
    const configuredPreComplexityEvidenceBudget =
      env.PI_PRE_COMPLEXITY_EVIDENCE_BUDGET ?? config.preComplexityEvidenceBudget ?? null;
    this.preComplexityEvidenceBudget = configuredPreComplexityEvidenceBudget == null
      ? null
      : positiveInteger(Number(configuredPreComplexityEvidenceBudget), 'PI_PRE_COMPLEXITY_EVIDENCE_BUDGET');
    this.preComplexityEvidenceRemaining = this.preComplexityEvidenceBudget;
    this.requiredFirstReadPath = env.PI_REQUIRED_FIRST_READ_PATH || config.requiredFirstReadPath || null;
    this.requiredFirstReadDone = !this.requiredFirstReadPath;
    this.complexityTurnBase = this.requiredFirstReadDone ? 0 : null;
    this.delegatedTools = new Set(config.delegatedTools ?? []);
    this.delegationTool = config.delegationTool ?? 'subagent';
    this.boundedDirectBash = config.boundedDirectBash === true;
    this.singleUseTools = new Set(config.singleUseTools ?? []);
    this.usedSingleUseTools = new Set();
    this.transitions = new SessionTransitions();
    this.lastAlreadySatisfied = null;

    this.productiveProgress = config.productiveProgress ?? null;
    this.productiveState = this.productiveProgress?.startState ?? 'inactive';
    this.productiveActivationReadSuffix = this.productiveProgress?.activationReadSuffix ?? null;
    this.productiveBlockerTool = this.productiveProgress?.blockerTool ?? null;
    this.productiveActionTools = new Set(this.productiveProgress?.actionTools ?? []);
    this.productiveControlTools = new Set(this.productiveProgress?.controlTools ?? []);
    // Focused verification (run_check) is evidence about a mutation, not progress:
    // one permit is granted per successful mutation, so it cannot become an
    // unlimited escape hatch from the action-required state.
    this.productiveVerificationTool = this.productiveProgress?.verificationTool ?? null;
    this.verificationPermits = 0;
    this.verificationState = this.productiveVerificationTool ? 'not_yet_available' : null;
    // Terminal recovery may require one exact authoritative verification even after the
    // ordinary mutation-scoped verification permit was consumed. Keep this separate from
    // verificationPermits so recovery cannot reopen arbitrary run_check access.
    this.recoveryVerificationSignature = null;
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
    // Set by `setEvidenceBudget` from the planner's own per-task estimate. When present it
    // takes priority over the by-complexity table: complexity is not a valid proxy for how
    // much repository evidence a task actually needs before it is safe to mutate.
    this.productiveEvidenceBudgetOverride = null;
    this.lastEvidenceRequestSignature = null;
    this.evidenceUnlockUsedSinceProgress = false;
    // Snapshot only an accepted need_more_evidence transition. Blocked attempts may still
    // produce tool_execution_end(isError=true) in Pi core, so execution-end rollback must
    // never infer ownership from tool name alone.
    this.pendingEvidenceUnlock = null;
    // Distinguish the one-action escape hatch opened by need_more_evidence from the
    // planner/bootstrap evidence window, which may legitimately contain several actions.
    this.blockerEvidenceWindowActive = false;
    this.pendingEvidenceConsumptionNotice = null;
    this.semanticLookupAwaitingRead = false;
    this.semanticFallbackEvidenceUsed = false;
    this.requireLspStartBeforeFindSymbol = config.requireLspStartBeforeFindSymbol === true;
    this.lspServerStartPending = false;
    // One-shot elevated mutation budget: 'idle' (default) -> 'pending' (grant tool call just
    // succeeded; applies to the upcoming response) -> 'active' (the elevated response is the
    // one currently in flight) -> back to 'idle' after that single response, regardless of
    // whether it attempted the mutation it was granted for.
    this.largeMutationBudgetTool = this.productiveProgress?.largeMutationBudgetTool ?? null;
    this.largeMutationBudgetMaxTokens = this.productiveProgress?.largeMutationBudgetMaxTokens ?? null;
    this.largeMutationBudgetState = 'idle';
    this.largeMutationBudgetSource = null;
    // Planner-owned intent is separate from the pending/active grant so evidence turns
    // stay on the normal budget until the action phase is actually reached.
    this.automaticLargeMutationBudgetArmed = false;
    this.codingSessionTool = this.productiveProgress?.codingSessionTool ?? null;
    this.lspServerReady = !this.requireLspStartBeforeFindSymbol;

    this.fixedMaxTokens = Number(env.PI_FIXED_RESPONSE_MAX_TOKENS ?? config.fixedResponseMaxTokens ?? 0);
    if (this.fixedMaxTokens && (!Number.isSafeInteger(this.fixedMaxTokens) || this.fixedMaxTokens < 1)) {
      throw new Error('PI_FIXED_RESPONSE_MAX_TOKENS must be a positive integer');
    }
    this.budgets = {
      short: positiveInteger(Number(env.PI_RESPONSE_BUDGET_SHORT ?? RESPONSE_BUDGETS.short), 'PI_RESPONSE_BUDGET_SHORT'),
      normal: positiveInteger(Number(env.PI_RESPONSE_BUDGET_NORMAL ?? RESPONSE_BUDGETS.normal), 'PI_RESPONSE_BUDGET_NORMAL'),
      deep: positiveInteger(Number(env.PI_RESPONSE_BUDGET_DEEP ?? RESPONSE_BUDGETS.deep), 'PI_RESPONSE_BUDGET_DEEP'),
    };

    this.preparationState = 'PENDING';
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
    this.preparationState = 'PREPARED';
    this.complexity = name;
    return { complexity: name, previous, changed: previous !== name };
  }

  // Records the planner's own bounded evidence estimate for this task, independent of the
  // trivial/nontrivial complexity classification. `null` clears any override and restores
  // the by-complexity table as a fallback.
  setEvidenceBudget(value) {
    if (value == null) {
      this.productiveEvidenceBudgetOverride = null;
      return null;
    }
    const budget = Number(value);
    if (!Number.isSafeInteger(budget) || budget < 0) {
      throw new Error('evidence budget must be a non-negative integer');
    }
    this.productiveEvidenceBudgetOverride = budget;
    return budget;
  }

  verificationPermitted() {
    return this.verificationPermits > 0;
  }

  verificationLifecycleState() {
    return this.verificationState;
  }

  armRecoveryVerification(input) {
    if (!this.productiveVerificationTool) return false;
    this.recoveryVerificationSignature = recoveryVerificationSignature(this.productiveVerificationTool, input ?? {});
    return true;
  }

  recoveryVerificationArmed() {
    return this.recoveryVerificationSignature != null;
  }

  clearRecoveryVerification() {
    const armed = this.recoveryVerificationSignature != null;
    this.recoveryVerificationSignature = null;
    return armed;
  }

  commitRecoveryVerification(input) {
    if (!this.productiveVerificationTool || this.recoveryVerificationSignature == null) return false;
    const signature = recoveryVerificationSignature(this.productiveVerificationTool, input ?? {});
    if (signature !== this.recoveryVerificationSignature) return false;
    this.recoveryVerificationSignature = null;
    return true;
  }

  armAutomaticLargeMutationBudget(enabled) {
    if (!this.largeMutationBudgetTool) {
      this.automaticLargeMutationBudgetArmed = false;
      return false;
    }
    this.automaticLargeMutationBudgetArmed = enabled === true;
    return this.automaticLargeMutationBudgetArmed;
  }

  // Promote planner intent only after evidence is closed. The promoted grant reuses the
  // existing pending -> active -> idle one-shot lifecycle and mutation-only hard gate.
  maybeGrantAutomaticLargeMutationBudget() {
    if (!this.automaticLargeMutationBudgetArmed ||
        this.largeMutationBudgetState !== 'idle' ||
        this.productiveState !== 'action_required') {
      return false;
    }
    this.automaticLargeMutationBudgetArmed = false;
    this.largeMutationBudgetState = 'pending';
    this.largeMutationBudgetSource = 'automatic';
    return true;
  }

  largeMutationBudgetPending() {
    return this.largeMutationBudgetState === 'pending';
  }

  largeMutationBudgetActive() {
    return this.largeMutationBudgetState === 'active';
  }

  // Moves a granted-but-not-yet-applied large mutation budget from 'pending' to 'active' once
  // the runtime has actually applied the elevated ceiling to the upcoming response.
  activateLargeMutationBudget() {
    if (this.largeMutationBudgetState !== 'pending') return false;
    this.largeMutationBudgetState = 'active';
    return true;
  }

  // Ends the one-shot elevated window after the elevated response has happened, whether or
  // not it attempted the mutation/terminal action it was granted for. Returns whether a grant
  // was actually active, so the caller can log a policy-violation warning when it was not used.
  resetLargeMutationBudget() {
    const wasActive = this.largeMutationBudgetState === 'active';
    this.largeMutationBudgetState = 'idle';
    this.largeMutationBudgetSource = null;
    return wasActive;
  }

  yieldLargeMutationBudgetForEvidence() {
    if (this.largeMutationBudgetState !== 'active' || this.productiveState !== 'evidence_allowed' || !this.evidenceUnlockUsedSinceProgress) {
      return { yielded: false, rearmed: false };
    }
    const rearmed = this.largeMutationBudgetSource === 'automatic';
    this.largeMutationBudgetState = 'idle';
    this.largeMutationBudgetSource = null;
    if (rearmed) this.automaticLargeMutationBudgetArmed = true;
    return { yielded: true, rearmed };
  }

  productiveProgressState() {
    return this.productiveState;
  }

  evidenceUnlockAvailable() {
    return Boolean(
      this.productiveBlockerTool &&
      this.productiveState === 'action_required' &&
      !this.evidenceUnlockUsedSinceProgress
    );
  }

  consumeEvidenceActionNotice() {
    const notice = this.pendingEvidenceConsumptionNotice;
    this.pendingEvidenceConsumptionNotice = null;
    return notice;
  }

  restoreRuntimeBlockedEvidenceAction(notice) {
    if (!notice || !this.productiveProgress || !this.productiveBlockerTool) return false;
    // need_more_evidence grants exactly one executable evidence action. A harness/runtime policy
    // rejection is not an evidence attempt, so restore the same open permit instead of forcing the
    // model to lose it or request a second unlock.
    this.pendingEvidenceConsumptionNotice = null;
    this.productiveEvidenceRemaining = Math.max(1, this.productiveEvidenceRemaining);
    this.productiveState = 'evidence_allowed';
    this.blockerEvidenceWindowActive = true;
    return true;
  }

  complexityRecorded() {
    return !this.requireComplexity || Boolean(this.complexity);
  }

  // Preparation infrastructure can fail without producing a classification. Keep that
  // failure explicit rather than inventing complexity or successful planner output.
  preparationSatisfied() {
    return this.complexityRecorded() || this.preparationState === 'PREPARATION_FALLBACK';
  }

  // Bootstrap resolved planner infrastructure failure before the first provider request.
  installPreparationFallback() {
    this.preparationState = 'PREPARATION_FALLBACK';
    // No planner estimate is available, so grant a small deterministic orientation window
    // to establish the canonical source/test layout before mutation. The normal bounded
    // evidence state machine consumes this at accepted-call time, and any successful mutation
    // closes the window early in onToolExecutionEnd().
    this.productiveEvidenceRemaining = PREPARATION_FALLBACK_EVIDENCE_BUDGET;
    this.productiveState = 'evidence_allowed';
    this.evidenceUnlockUsedSinceProgress = false;
    return {
      preparationState: this.preparationState,
      complexity: this.complexity,
      evidenceBudget: PREPARATION_FALLBACK_EVIDENCE_BUDGET,
    };
  }

  // Installs a PreparedImplementation artifact resolved by the runtime bootstrap before the main
  // session's first provider request. Produces the same state a successful prepare_implementation
  // tool call used to produce: complexity, planner evidence budget, armed large-mutation intent and
  // the initial productive-progress state.
  applyPreparedImplementation(prepared) {
    if (prepared.status === 'fallback') {
      return { ...this.installPreparationFallback(), largeMutationArmed: false };
    }
    this.setComplexity(prepared.complexity);
    this.setEvidenceBudget(prepared.evidenceBudget);
    const largeMutationArmed = this.armAutomaticLargeMutationBudget(prepared.largeMutation);
    const evidenceBudget = this.productiveInitialEvidenceBudgetForComplexity();
    this.productiveEvidenceRemaining = evidenceBudget;
    // Zero planner-reported evidence need goes straight to action_required.
    this.productiveState = evidenceBudget > 0 ? 'evidence_allowed' : 'action_required';
    this.evidenceUnlockUsedSinceProgress = false;
    return {
      preparationState: this.preparationState,
      complexity: this.complexity,
      evidenceBudget,
      largeMutationArmed,
    };
  }

  preComplexityActionRequired() {
    if (this.preparationSatisfied() || !this.requiredFirstReadDone) return false;
    const preComplexityTurns = Math.max(
      0,
      this.absoluteTurn - (this.complexityTurnBase ?? this.absoluteTurn),
    );
    const turnDeadlineReached = preComplexityTurns >= this.preComplexityTurnLimit;
    const evidenceExhausted =
      this.preComplexityEvidenceBudget != null &&
      this.preComplexityEvidenceRemaining <= 0;
    return turnDeadlineReached || evidenceExhausted;
  }

  productiveInitialEvidenceBudgetForComplexity() {
    if (this.productiveEvidenceBudgetOverride != null) return this.productiveEvidenceBudgetOverride;
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
    const recoveryVerificationCall =
      Boolean(this.productiveVerificationTool) &&
      toolName === this.productiveVerificationTool &&
      this.recoveryVerificationSignature === recoveryVerificationSignature(toolName, input ?? {});

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

    // Absolute gate: while the one-shot elevated mutation budget is active, this response may
    // spend it on nothing but an actual mutation, rollback, or terminal submission. This is
    // the real guarantee; the runtime's tool-surface restriction is UX on top of it, not a
    // substitute for it.
    const elevatedEvidenceUnlock = Boolean(this.productiveBlockerTool && toolName === this.productiveBlockerTool);
    if (
      this.largeMutationBudgetTool &&
      this.largeMutationBudgetState === 'active' &&
      !ELEVATED_MUTATION_TURN_TOOLS.has(toolName) &&
      !elevatedEvidenceUnlock &&
      !recoveryVerificationCall
    ) {
      const blockerGuidance = this.productiveBlockerTool ? `, or ${this.productiveBlockerTool} for one concrete missing fact` : '';
      return {
        block: true,
        reason: `BLOCKED: ${toolName} did not execute. The elevated mutation budget is active this turn; only accept_mutation_scope, structural_edit, safe_edit, edit, write, rollback_last_mutation, a terminal submit action${blockerGuidance} are allowed.`,
      };
    }

    // A repeated one-shot transition is a deterministic no-op: it never reaches the underlying
    // tool, never counts as progress (blocked calls have no execution-end), and does not touch
    // the consecutive-repeat signature, so it cannot be mistaken for useful work.
    const transitionKey = this.transitions.keyFor(toolName, input);
    if (this.transitions.has(transitionKey)) {
      this.lastAlreadySatisfied = { tool: toolName, key: transitionKey };
      return {
        block: true,
        alreadySatisfied: true,
        reason: this.transitions.alreadySatisfiedReason(toolName, transitionKey, {
          actionRequired: this.productiveState === 'action_required',
          verificationTool: this.productiveVerificationTool,
          verificationState: this.verificationLifecycleState(),
        }),
      };
    }

    let acceptedEvidenceUnlock = null;
    const pendingComplexityTransition =
      this.requireComplexity &&
      !this.preparationSatisfied() &&
      this.preComplexityTransitionTools.has(toolName);
    const terminalTool = TERMINAL_TOOLS.has(toolName);
    const finishTool = FINISH_TOOLS.has(toolName);
    let acceptedVerificationCall = false;
    let acceptedRecoveryVerificationCall = false;

    const preComplexityEvidenceTool =
      this.requireComplexity &&
      !this.preparationSatisfied() &&
      !pendingComplexityTransition &&
      !terminalTool &&
      this.preComplexityAllowedTools.has(toolName);

    if (this.requireComplexity && !this.preparationSatisfied()) {
      const orientationDeadlineReached = this.preComplexityActionRequired();
      if (orientationDeadlineReached && !pendingComplexityTransition && !terminalTool) {
        const reason = this.preComplexityEvidenceBudget != null && this.preComplexityEvidenceRemaining <= 0
          ? `Startup orientation used its ${this.preComplexityEvidenceBudget} evidence actions after the required contract read.`
          : `Startup orientation used ${this.preComplexityTurnLimit} model turns after the required contract read.`;
        return {
          block: true,
          reason: `BLOCKED: ${toolName} did not execute. ${reason} Use only the configured preparation/classification action or terminal submit tool now.`,
        };
      }
      if (!orientationDeadlineReached && !pendingComplexityTransition && !this.preComplexityAllowedTools.has(toolName)) {
        return {
          block: true,
          reason: `BLOCKED: ${toolName} did not execute. Before complexity is recorded, use only initial-orientation tools or the configured preparation/classification action.`,
        };
      }
    }

    // The 16k coding phase starts only once preparation/evidence has established readiness:
    // never during startup orientation or while evidence gathering is still open.
    if (this.codingSessionTool && toolName === this.codingSessionTool && this.productiveState !== 'action_required') {
      return {
        block: true,
        reason: `BLOCKED: ${toolName} did not execute. The coding session starts only once evidence is complete (action_required); finish the exploration first.`,
      };
    }

    if (this.largeMutationBudgetTool && toolName === this.largeMutationBudgetTool) {
      if (this.largeMutationBudgetState !== 'idle') {
        return {
          block: true,
          reason: `BLOCKED: ${toolName} did not execute. A large mutation budget is already granted or active; use it for the pending mutation before requesting another.`,
        };
      }
      // Evidence is not yet exhausted: granting the elevated budget here would apply it to a
      // response that can still see the full evidence/search tool surface, defeating the
      // mutation-only guarantee. Require action_required first.
      if (this.productiveState !== 'action_required') {
        return {
          block: true,
          reason: `BLOCKED: ${toolName} did not execute. A large mutation budget can only be requested once productive progress is action_required; finish gathering evidence first.`,
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

    if (toolName === 'lsp_find_symbol' && this.lspServerStartPending) {
      return {
        block: true,
        reason: 'BLOCKED: lsp_start_server is still running. Wait for that control action to finish successfully, then call lsp_find_symbol in the next turn.',
      };
    }
    if (toolName === 'lsp_find_symbol' && this.requireLspStartBeforeFindSymbol && !this.lspServerReady) {
      return {
        block: true,
        reason: 'BLOCKED: cold name-only LSP lookup requires one successful lsp_start_server call after preparation before lsp_find_symbol can execute.',
      };
    }
    if (toolName === 'lsp_start_server' && this.lspServerStartPending) {
      return {
        block: true,
        reason: 'BLOCKED: lsp_start_server is already running. Reuse that startup result instead of starting the same cold server in parallel.',
      };
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
      } else if (this.productiveState === 'action_required') {
        if (this.productiveBlockerTool && toolName === this.productiveBlockerTool) {
          const evidenceRequest = validateSingleEvidenceRequest(input);
          if (!evidenceRequest.ok) {
            return { block: true, reason: `BLOCKED: ${evidenceRequest.reason}` };
          }
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
              reason: 'BLOCKED: an extra evidence permit was already used since the last successful structural_edit/safe_edit/edit/write/submit_result. Act on the evidence already gathered before requesting more.',
            };
          }
          acceptedEvidenceUnlock = {
            signature: blockerSignature,
            previous: {
              lastEvidenceRequestSignature: this.lastEvidenceRequestSignature,
              evidenceUnlockUsedSinceProgress: this.evidenceUnlockUsedSinceProgress,
              productiveEvidenceRemaining: this.productiveEvidenceRemaining,
              productiveState: this.productiveState,
              blockerEvidenceWindowActive: this.blockerEvidenceWindowActive,
            },
          };
        } else if (this.productiveVerificationTool && toolName === this.productiveVerificationTool) {
          if (recoveryVerificationCall) {
            acceptedRecoveryVerificationCall = true;
          } else if (this.recoveryVerificationSignature) {
            return {
              block: true,
              reason: `BLOCKED: terminal recovery requires the exact authoritative verification action; this ${toolName} input does not match it.`,
            };
          } else if (this.verificationPermits > 0) {
            acceptedVerificationCall = true;
          } else {
            return {
              block: true,
              reason: this.verificationState === 'exhausted'
                ? `BLOCKED: ${toolName} is exhausted for the current mutation state. A new successful mutation is required before another focused verification.`
                : `BLOCKED: ${toolName} is not yet available; it becomes available after a successful mutation.`,
            };
          }
        } else if (!this.productiveActionTools.has(toolName) && !this.productiveControlTools.has(toolName)) {
          return {
            block: true,
            reason: this.productiveBlockerTool
              ? `BLOCKED: productive progress requires an action now. ${toolName} did not execute. Use structural_edit/safe_edit/edit/write/submit_result, or call ${this.productiveBlockerTool} with one concrete missing fact to unlock exactly one evidence action.`
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
        if (this.productiveVerificationTool && toolName === this.productiveVerificationTool) {
          if (recoveryVerificationCall) {
            acceptedRecoveryVerificationCall = true;
          } else if (this.recoveryVerificationSignature) {
            return {
              block: true,
              reason: `BLOCKED: terminal recovery requires the exact authoritative verification action; this ${toolName} input does not match it.`,
            };
          } else if (this.verificationPermits > 0) {
            acceptedVerificationCall = true;
          } else {
            return {
              block: true,
              reason: this.verificationState === 'exhausted'
                ? `BLOCKED: ${toolName} is exhausted for the current mutation state. A new successful mutation is required before another focused verification.`
                : `BLOCKED: ${toolName} is not yet available; it becomes available after a successful mutation.`,
            };
          }
        } else if (!this.productiveActionTools.has(toolName) && !this.productiveControlTools.has(toolName)) {
          if (this.blockerEvidenceWindowActive) {
            // need_more_evidence is a strict one-action escape hatch: the first accepted
            // evidence call consumes the permit immediately, whatever evidence tool it is.
            this.productiveEvidenceRemaining = 0;
            this.productiveState = 'action_required';
            this.blockerEvidenceWindowActive = false;
            this.pendingEvidenceConsumptionNotice = { tool: toolName };
          } else {
            const semanticFallback = this.semanticLookupAwaitingRead &&
              !this.semanticFallbackEvidenceUsed &&
              toolName !== 'read' &&
              toolName !== 'lsp_find_symbol';
            if (semanticFallback) {
              // Planner/bootstrap evidence windows retain the deterministic semantic fallback.
              this.semanticFallbackEvidenceUsed = true;
            } else {
              this.productiveEvidenceRemaining = Math.max(0, this.productiveEvidenceRemaining - 1);
              if (this.productiveEvidenceRemaining === 0) this.productiveState = 'action_required';
            }
          }
        }
      }
    }

    if (
      this.absoluteTurn >= this.turnLimit &&
      !finishTool &&
      !pendingComplexityTransition &&
      !acceptedRecoveryVerificationCall
    ) {
      return {
        block: true,
        reason: `BLOCKED: ${toolName} did not execute. Global execution limit reached (${this.turnLimit} turns). Exploration is closed; use only the pending preparation/classification action or terminal submit tool to finish.`,
      };
    }

    const signature = toolCallSignature(toolName, input);
    if (acceptedRecoveryVerificationCall) {
      // The terminal obligation itself is fresh authoritative reason to retry this exact check.
      // Do not let the ordinary consecutive-call guard veto the one recovery permit.
      this.lastSignature = signature;
      this.repeatCount = 1;
    } else {
      if (signature === this.lastSignature) this.repeatCount += 1;
      else {
        this.lastSignature = signature;
        this.repeatCount = 1;
      }
      if (this.repeatCount > this.repeatThreshold) {
        return { block: true, reason: `You already ran this exact ${toolName} call ${this.repeatCount - 1} times consecutively; reuse the result or change strategy.` };
      }
    }
    if (preComplexityEvidenceTool && this.preComplexityEvidenceRemaining != null) {
      this.preComplexityEvidenceRemaining = Math.max(0, this.preComplexityEvidenceRemaining - 1);
    }
    if (toolName === 'lsp_start_server') this.lspServerStartPending = true;
    if (acceptedVerificationCall && !acceptedRecoveryVerificationCall) {
      this.verificationPermits -= 1;
      if (this.verificationPermits === 0) this.verificationState = 'exhausted';
    }
    if (acceptedEvidenceUnlock) {
      this.pendingEvidenceUnlock = acceptedEvidenceUnlock;
      this.lastEvidenceRequestSignature = acceptedEvidenceUnlock.signature;
      this.evidenceUnlockUsedSinceProgress = true;
      this.productiveEvidenceRemaining = 1;
      this.blockerEvidenceWindowActive = true;
      this.productiveState = 'evidence_allowed';
    }
    this.turnUsedTool = true;
    return undefined;
  }

  // Records a successful one-shot transition; returns its record only the first time.
  recordTransitionCompleted(toolName, input, isError) {
    if (isError) return null;
    const key = this.transitions.keyFor(toolName, input);
    if (key == null) return null;
    return this.transitions.complete(key, {
      tool: toolName,
      serverId: input?.server_id,
      workspaceRoot: input?.workspace_root,
    });
  }

  onToolExecutionEnd(toolName, isError, {
    madeProgress = true,
    input = null,
    strictBlockerEvidence = false,
    verificationEligible = madeProgress,
  } = {}) {
    if (this.productiveProgress && this.productiveBlockerTool && toolName === this.productiveBlockerTool) {
      const pending = this.pendingEvidenceUnlock;
      const executionSignature = input == null ? null : toolCallSignature(toolName, input);
      if (pending && executionSignature === pending.signature) {
        // Only the exact blocker call that opened this evidence window owns its rollback.
        // Pi core also emits tool_execution_end for locally blocked attempts; those calls
        // have no accepted-input record and therefore cannot reset the per-epoch limit.
        this.pendingEvidenceUnlock = null;
        if (isError) {
          this.lastEvidenceRequestSignature = pending.previous.lastEvidenceRequestSignature;
          this.evidenceUnlockUsedSinceProgress = pending.previous.evidenceUnlockUsedSinceProgress;
          this.productiveEvidenceRemaining = pending.previous.productiveEvidenceRemaining;
          this.productiveState = pending.previous.productiveState;
          this.blockerEvidenceWindowActive = pending.previous.blockerEvidenceWindowActive;
        }
      }
    }
    if (
      isError &&
      this.requireComplexity &&
      !this.preparationSatisfied() &&
      this.preComplexityEvidenceBudget != null &&
      this.preComplexityAllowedTools.has(toolName) &&
      !this.preComplexityTransitionTools.has(toolName)
    ) {
      this.preComplexityEvidenceRemaining = Math.min(
        this.preComplexityEvidenceBudget,
        this.preComplexityEvidenceRemaining + 1,
      );
    }
    if (toolName === 'lsp_start_server') {
      this.lspServerStartPending = false;
      if (this.requireLspStartBeforeFindSymbol) this.lspServerReady = !isError;
    }
    if (this.productiveProgress && toolName === 'lsp_find_symbol') {
      if (!isError && this.productiveState === 'evidence_allowed') {
        this.semanticLookupAwaitingRead = true;
        this.semanticFallbackEvidenceUsed = false;
      } else if (isError) {
        this.semanticLookupAwaitingRead = false;
        this.semanticFallbackEvidenceUsed = false;
        if (!strictBlockerEvidence) {
          // Planner/bootstrap evidence windows may recover from a failed semantic lookup.
          // A need_more_evidence window is different: its one accepted action is consumed
          // regardless of outcome, so failure must return to action_required.
          this.productiveEvidenceRemaining += 1;
          if (this.productiveState === 'action_required') this.productiveState = 'evidence_allowed';
        }
      }
    }
    if (this.productiveProgress && toolName === 'read' && !isError && this.semanticLookupAwaitingRead) {
      this.semanticLookupAwaitingRead = false;
      this.semanticFallbackEvidenceUsed = false;
      this.productiveEvidenceRemaining = 0;
      if (this.productiveState === 'evidence_allowed') this.productiveState = 'action_required';
    }
    if (!isError && this.automaticLargeMutationBudgetArmed &&
        (FINISH_TOOLS.has(toolName) || toolName === this.codingSessionTool)) {
      // If a productive action happened before the automatic grant could activate, discard
      // the intent rather than shifting its elevated response onto an unrelated later action.
      this.automaticLargeMutationBudgetArmed = false;
    }
    if (!isError && this.largeMutationBudgetTool && toolName === this.largeMutationBudgetTool) {
      this.automaticLargeMutationBudgetArmed = false;
      this.largeMutationBudgetState = 'pending';
      this.largeMutationBudgetSource = 'manual';
    }
    if (
      !isError &&
      verificationEligible === true &&
      this.productiveVerificationTool &&
      MUTATION_TOOLS.has(toolName)
    ) {
      this.verificationPermits = 1;
      this.verificationState = 'available';
    }
    if (!isError && this.productiveProgress && this.productiveActionTools.has(toolName)) {
      this.semanticLookupAwaitingRead = false;
      this.semanticFallbackEvidenceUsed = false;
      if (madeProgress) {
        this.evidenceUnlockUsedSinceProgress = false;
        this.blockerEvidenceWindowActive = false;
      }
      if (toolName === ROLLBACK_TOOL || this.productiveState === 'evidence_allowed') {
        this.productiveState = 'action_required';
      }
    }
    if (!isError && madeProgress && (PROGRESS_TOOLS.has(toolName) || this.preComplexityTransitionTools.has(toolName))) {
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
