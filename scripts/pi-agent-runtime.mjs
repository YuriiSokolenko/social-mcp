import fs from 'node:fs';
import { recordDescendantMetric, runStructuredSubagent } from './pi-common/structured-subagent.mjs';
import { readPreparedImplementation, bootstrapFailureFallback } from './pi-common/implementation-planner.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Type } from 'typebox';

import {
  FINISH_TOOLS,
  ProgressController,
  actionRequiredToolNames,
  elevatedMutationTurnToolNames,
  classifyTruncatedToolCall,
  MAX_CEILING_WITHOUT_TOOL_TURNS,
  nextActionRequiredProseOnlyTurns,
  nextCeilingWithoutToolTurns,
  nextActionResponseCap,
  truncatedToolCallGuidance,
} from './pi-common/progress-controller.mjs';
import { stageConfig } from './pi-common/stage-config.mjs';
import { activeToolGuidance, capabilitySnapshotGuidance, classifyMissingExecutor, mergeNewlyActiveTools, providerToolNames } from './pi-common/session-state.mjs';
import { repoSearch } from './pi-common/repo-search.mjs';
import { CHECK_KINDS, checkMetricRecord, runCheck, sandboxPreflight } from './pi-common/run-check.mjs';
import {
  appendCheckRecord,
  latestUnresolvedRunCheckFailure,
  normalizeScope,
  readValidationLedger,
  resolveValidationRunId,
  runCheckRequestForRecord,
} from './pi-common/validation-ledger.mjs';
import { safeEdit } from './pi-common/safe-edit.mjs';
import { structuralEdit } from './pi-common/structural-edit.mjs';
import {
  captureMutationSnapshot,
  detectNoOpWrite,
  mutationSnapshotChanged,
} from './pi-common/mutation-snapshot.mjs';
import {
  clearMutationJournalLocalOnly,
  currentMutationFingerprint,
  isMutationJournalCapacityError,
  markMutationJournalLocalOnly,
  mutationJournalCapacityStatus,
  mutationJournalState,
  recordSuccessfulMutation,
  snapshotFingerprint,
  undoMutation,
  writeMutationJournalFile,
} from './pi-common/mutation-journal.mjs';
import { baseRef, projectConfig } from './pi-common/project-config.mjs';
import {
  SemanticLoopGuard,
  isSemanticMutationTool,
  loopGuardLimits,
  mutationResolvesSubmissionObligation,
  repositoryStateFingerprint,
} from './pi-common/semantic-loop-guard.mjs';
import { zoektSearch } from './pi-common/zoekt-search.mjs';
import { classifyWorktreeDrift, recoverWorktree, worktreeChangedFiles } from './pi-common/worktree-recovery.mjs';
import {
  compactTerminalRecoveryPayload,
  recoveryCallMatchesPlan,
  selectTerminalRecovery,
  terminalRecoveryGuidance,
} from './pi-common/terminal-recovery-controller.mjs';
import { captureWorktreeBaseline, observeWorktreeDrift, readWorktreeBaseline, readWorktreeObserved } from './pi-common/worktree-baseline.mjs';
import { assertImplementerFileSet } from './pi-common/implementer-result.mjs';
import { MutationTargetRejected, resolveMutationTarget } from './pi-common/mutation-target.mjs';
import {
  assertMutationPathAuthorized,
  mutationScopeReceipt,
  registerMutationScope,
} from './pi-common/accepted-mutation-scope.mjs';
import {
  assertSuccessfulTerminalReceipt,
  invalidateTerminalReceipt,
} from './pi-common/terminal-receipt.mjs';
import { normalizeCodingSessionOutcome } from './pi-common/coding-session-outcome.mjs';
import {
  TRUSTED_RECOVERY_TOOLS,
  consumeUnavailableCapabilityAttempts,
  equivalentIncapableCodingSession,
  incapableCodingSessionRecord,
  recordUnavailableCapabilityAttempt,
} from './pi-common/coding-session-capability.mjs';
import {
  CODING_SESSION_USED_ENV,
  codingSessionSubmissionReadiness,
  invalidateCodingBehavioralValidation,
  recordCodingBehavioralValidation,
  repositoryFingerprintRequiresValidation,
  requiredPreparedOutputPaths,
} from './pi-common/coding-session-validation.mjs';

// Every tool whose effect is one target-file mutation: snapshot/rollback/no-op/progress apply.
const CONTENT_MUTATION_TOOLS = new Set(['structural_edit', 'safe_edit', 'edit', 'write']);
// Bash is not part of accepted-scope mutation accounting, but it can still
// change repository bytes. Conservatively invalidate an existing candidate
// receipt before any Implementer bash call; a later submit_result can rebind it.
const RECEIPT_INVALIDATING_TOOLS = new Set([...CONTENT_MUTATION_TOOLS, 'bash']);
const RETRY_FAILED_CHECK_TOOL = 'retry_last_failed_check';
const ACCEPT_MUTATION_SCOPE_TOOL = 'accept_mutation_scope';
const DETERMINISTIC_TERMINAL_RECOVERY_KINDS = new Set([
  'metadata',
  'validation',
  'prepared_outputs',
  'conflict',
  'file_set',
  'file_set_cleanup',
]);

// Trust boundary: the coding session's agent definition, tool allowlist and extensions come
// from THIS module's control checkout (the trusted harness), never from the issue worktree the
// Implementer can rewrite. It is registered in code through pi-subagents' runtime-agent
// registry; an explicit `extensions` list disables ambient (worktree/global) extensions for the
// fork, worktree `agentOverrides` can only narrow model/thinking for a runtime agent, and a
// same-name worktree agent collides and fails the launch closed. The fork runs this same
// runtime (in coding-session mode), so every runtime protection applies inside it unchanged.
const CONTROL_SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_AGENT_REGISTER_EVENT = 'pi-subagents:runtime-agent-register:v1';
const CODING_SESSION_SYSTEM_PROMPT = `You are the same Implementer, continuing your own session in its coding phase.

The conversation above is your session: the issue, your contract, the evidence you gathered and the implementation you decided. Exploration and implementation decisions are already complete. Do not re-plan, design or draft code in prose. Start by calling the appropriate coding tool.

Your normal turns had a small output ceiling; this coding session has a large one only so large code fits in tool arguments. Finish the task here under your normal contract and runtime rules. Use only tools currently exposed by the runtime; never invent helper names such as read_for_input. In action-required state, normal read may be hidden: if one concrete missing fact prevents the next safe action, call need_more_evidence with that missing fact and reason, then use the single evidence action the runtime exposes. Otherwise mutate, verify when a verification tool is exposed, fix reported failures, and finish through the exposed terminal action.`;

export function codingSessionAgentDefinition(tools, scriptsDir = CONTROL_SCRIPTS_DIR) {
  return {
    description: '16k coding-phase continuation forked from the Implementer session; implements, verifies and submits',
    systemPrompt: CODING_SESSION_SYSTEM_PROMPT,
    tools: [...tools],
    // Explicit list: ambient extensions are disabled for the fork; all paths are absolute paths
    // inside the trusted control checkout. The runtime enforces the same rules as in the parent.
    extensions: [
      path.join(scriptsDir, 'pi-bash-timeout.mjs'),
      path.join(scriptsDir, 'pi-agent-runtime.mjs'),
      path.join(scriptsDir, 'pi-implementer-result-tool.mjs'),
    ],
    systemPromptMode: 'append',
    inheritProjectContext: true,
    inheritGlobalContext: true,
    inheritSkills: false,
    defaultContext: 'fork',
    // The string "off" (pi-subagents 0.71.0 appends it as a :off model suffix); `false` would
    // add no suffix and leave the model's default reasoning on. Also prevents defaultThinking
    // from filling the field. The delegation request repeats it as an override, and the runtime
    // enforces it on the wire (see CODING_SESSION_PAYLOAD_PATCH).
    thinking: 'off',
  };
}

// Laguna (llama-server, openai-completions) reasons by default once tools are present, and pi's
// "off" level sends no reasoning field for this provider's compat. The coding session therefore
// disables thinking on every provider request itself; chat_template_kwargs.enable_thinking=false
// is honored by the Laguna chat template (live probe: 0 reasoning chars, immediate tool call).
export function disableThinkingInPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.messages)) return payload;
  return {
    ...payload,
    chat_template_kwargs: { ...(payload.chat_template_kwargs ?? {}), enable_thinking: false },
  };
}

// Both OpenAI-compatible Chat Completions and Responses requests accept tool_choice="required".
// The active Pi tool surface has already been reduced to the valid action_required tools before
// the request is built, so this forces a real tool call without choosing the tool on the model's
// behalf. The runtime keeps this request constraint armed until the provider emits a tool call;
// transport retries or ceiling-hit responses must not consume it. Pi surfaces rejected provider
// requests as turn_end error messages, so a forced 400/422 gets one runtime continuation without
// provider-level forcing. Other provider errors leave the requirement armed in case Pi itself retries.
export function requireToolChoiceInPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.tools) || payload.tools.length === 0) {
    return payload;
  }
  return { ...payload, tool_choice: 'required' };
}

export function providerErrorStatus(message) {
  if (message?.stopReason !== 'error') return null;

  const structuredCandidates = [
    message?.status,
    message?.statusCode,
    message?.error?.status,
    message?.error?.statusCode,
  ];
  for (const candidate of structuredCandidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }

  const text = String(message?.errorMessage ?? '').trim();
  // openai-completions surfaces OpenAI SDK Error.message strings such as
  // "400: <body>", "400 <json-body>", "400 status code (no body)", or
  // "BadRequestError: 422 ...". Keep this intentionally narrow: arbitrary prose such as
  // "Maximum context: 400 tokens" or "500 tokens exceeded" is not an HTTP status.
  const sdkMatch =
    /^(?:([45]\d{2})(?::(?:\s|$)|\s+(?=(?:status code\b|[\[{])))|[A-Za-z_$][\w.$]*Error:\s*([45]\d{2})(?=[:\s]|$))/.exec(text);
  if (sdkMatch) return Number(sdkMatch[1] ?? sdkMatch[2]);

  // openai-responses / azure-openai-responses / mistral use Pi's explicit API-error prefix.
  const apiMatch = /\bAPI error \((\d{3})\):/.exec(text);
  if (apiMatch) return Number(apiMatch[1]);

  return null;
}

// Set (only) for the forked coding session: switches this runtime into coding-session mode.
function codingSessionSpec(env = process.env) {
  try {
    const spec = JSON.parse(env.PI_CODING_SESSION ?? '');
    const maxTokens = Number(spec?.maxTokens);
    if (spec?.sessionId && Number.isSafeInteger(maxTokens) && maxTokens > 0) return { sessionId: String(spec.sessionId), maxTokens, failureFile: spec.failureFile, capabilityFile: spec.capabilityFile };
  } catch { /* parent session */ }
  return null;
}


function resultText(result) {
  if (typeof result === 'string') return result;
  const content = Array.isArray(result) ? result : result?.content;
  if (Array.isArray(content)) return content.map(part => part?.text ?? '').join('\n');
  return typeof result?.message === 'string' ? result.message : '';
}

// A fresh Implementer without a bootstrap artifact (not launched through the runner) fails soft into
// the same already-resolved fallback rather than being blocked; the runner always supplies one.
function loadPreparedImplementation(env = process.env) {
  const prepared = readPreparedImplementation(env.PI_PREPARED_IMPLEMENTATION_FILE);
  return prepared ?? bootstrapFailureFallback(process.cwd(), 'PreparedImplementation artifact is missing', env);
}

function logPreparedImplementation(prepared, applied) {
  const stage = 'implementer';
  const usage = prepared.plannerUsage ?? null;
  if (prepared.status === 'fallback') {
    console.warn(`PI_PREPARATION_FALLBACK ${JSON.stringify({
      stage,
      preparationState: applied.preparationState,
      evidenceBudget: applied.evidenceBudget,
      source: 'implementation-planner',
      failureClass: prepared.failureClass,
      recovery: 'continue_without_planner_output',
      reason: prepared.reason,
      plannerDurationMs: prepared.plannerDurationMs,
      evidenceUsed: prepared.plannerEvidenceUsed ?? null,
      evidenceCap: prepared.plannerEvidenceCap ?? null,
      providerTurns: prepared.plannerProviderTurns ?? null,
    })}`);
  } else {
    console.log(`PI_PLAN ${JSON.stringify({
      stage,
      steps: prepared.plan,
      repositoryFacts: prepared.repositoryFacts ?? [],
      complexity: prepared.complexity,
      evidenceBudget: prepared.evidenceBudget,
      largeMutation: prepared.largeMutation,
      largeMutationArmed: applied.largeMutationArmed,
      reason: prepared.reason,
      usage,
      plannerDurationMs: prepared.plannerDurationMs,
      evidenceUsed: prepared.plannerEvidenceUsed ?? null,
      evidenceCap: prepared.plannerEvidenceCap ?? null,
      providerTurns: prepared.plannerProviderTurns ?? null,
    })}`);
    if (applied.largeMutationArmed) {
      console.log(`PI_LARGE_MUTATION_BUDGET ${JSON.stringify({ stage, phase: 'auto_armed', source: 'implementation-planner' })}`);
    }
    console.log(`PI_COMPLEXITY ${JSON.stringify({
      stage,
      complexity: prepared.complexity,
      evidenceBudget: prepared.evidenceBudget,
      largeMutation: prepared.largeMutation,
      reason: prepared.reason,
      usage,
      source: 'implementation-planner',
    })}`);
  }
  console.log(`PI_BOOTSTRAP ${JSON.stringify({ phase: 'prepared_state_applied', status: prepared.status, beforeFirstProviderRequest: true })}`);
}

function codingSessionLog(phase, fields) {
  const line = `PI_CODING_SESSION ${JSON.stringify({ phase, ...fields })}`;
  if (['failed', 'rejected', 'cancelled'].includes(phase)) console.warn(line);
  else console.log(line);
}


// Single runtime controller for every model-driven stage. It owns orientation,
// task-complexity declaration, repeat/turn safety and per-response output budget.
export default function (pi) {
  const stage = process.env.PI_STAGE;
  // Inside the forked coding session this same runtime enforces the same rules, with the
  // large ceiling on every response and no nested transition or legacy grant.
  const codingSession = stage === 'implementer' ? codingSessionSpec() : null;
  const baseConfig = stageConfig(stage);
  const config = codingSession
    ? {
        ...baseConfig,
        fixedResponseMaxTokens: codingSession.maxTokens,
        productiveProgress: {
          ...baseConfig.productiveProgress,
          actionResponseMaxTokens: codingSession.maxTokens,
          actionResponseRetryMaxTokens: codingSession.maxTokens,
          codingSessionTool: null,
          largeMutationBudgetTool: null,
        },
      }
    : baseConfig;
  const resumePatch = stage === 'implementer' ? process.env.PI_RESUME_PATCH : null;
  const resumedImplementer = process.env.PI_RESUME_ACTIVE != null
    ? process.env.PI_RESUME_ACTIVE === 'true'
    : Boolean(
        resumePatch &&
        fs.existsSync(resumePatch) &&
        fs.statSync(resumePatch).size > 0
      );
  const validationRepair = stage === 'implementer' && process.env.PI_VALIDATION_REPAIR === 'true';
  // A coding session is already prepared: it starts directly in the action phase.
  const directActionImplementer = resumedImplementer || validationRepair || Boolean(codingSession);
  const controller = new ProgressController(
    directActionImplementer
      ? {
          ...config,
          requireComplexity: false,
          productiveProgress: config.productiveProgress
            ? { ...config.productiveProgress, startState: 'action_required' }
            : null,
        }
      : config
  );
  const loopGuard = stage === 'implementer'
    ? new SemanticLoopGuard(loopGuardLimits())
    : null;

  // Fresh work only: planning already ran in the runner's bootstrap session, so this session is born
  // prepared and its first provider request already carries the plan (see the stage prompt). Restored
  // work, validation repair and coding sessions keep their direct-action paths and never re-plan.
  if (stage === 'implementer' && !directActionImplementer) {
    const preparedImplementation = loadPreparedImplementation();
    const applied = controller.applyPreparedImplementation(preparedImplementation);
    logPreparedImplementation(preparedImplementation, applied);
  }

  let appliedActionCap = 0;
  let actionTurnAttemptedTool = false;
  let actionRequiredProseOnlyTurns = 0;
  let ceilingWithoutToolTurns = 0;
  let requireToolOnNextProviderRequest = false;
  let forcedProviderRequestInFlight = false;
  let loopGuardSteeredThisTurn = false;
  let terminalRecoveryState = null;
  let terminalRecoveryRequiredTool = null;
  let terminalRecoveryAttemptToolCallId = null;
  let unrestrictedActiveTools = null;
  let unavailableToolAttempts = 0;
  let unavailableCapabilityAttemptedThisTurn = false;
  let unavailableCapabilityKindThisTurn = null;
  let consecutiveUnavailableCapabilityTurns = 0;
  let providerRequestSequence = 0;
  let providerCapabilitySnapshot = null;
  // Successful trusted recovery transitions in this process; releases the incapable-fork guard.
  let trustedRecoveryEpoch = 0;
  let lastProviderProductiveState = null;
  // True only when this runtime itself removed the verification tool from the model
  // surface (permit exhaustion or exact-retry substitution). A later valid
  // permit may restore it only in that case; unrelated removals stay removed.
  let verificationToolHiddenByPermitGate = false;
  // Tracks whether the current turn attempted one of the finish tools (mutation, rollback,
  // or terminal submission) it was granted a one-shot elevated mutation budget for.
  let elevatedTurnAttemptedFinishTool = false;
  let elevatedTurnAttemptedScopePrelude = false;
  let elevatedTurnAttemptedEvidenceUnlock = false;
  let elevatedScopePreludeUsed = false;

  function validationRunId() {
    return resolveValidationRunId(process.env);
  }

  function validationAttemptId() {
    if (process.env.PI_VALIDATION_REPAIR === 'true') {
      return `validation-repair:${process.env.PI_VALIDATION_REPAIR_ATTEMPT ?? '1'}`;
    }
    return 'primary';
  }

  function failedCheckRecoveryState() {
    if (stage !== 'implementer') return { failure: null, request: null, corrupted: false };
    const { records, corrupted } = readValidationLedger(process.env.PI_VALIDATION_LEDGER_FILE);
    if (corrupted) return { failure: null, request: null, corrupted: true };

    const failure = latestUnresolvedRunCheckFailure(records, {
      runId: validationRunId(),
      stage,
    });
    if (!failure) return { failure: null, request: null, corrupted: false };

    try {
      return {
        failure,
        request: runCheckRequestForRecord(failure),
        corrupted: false,
      };
    } catch {
      // Malformed/legacy ledger history must never hide ordinary run_check or
      // create a retry tool that cannot execute. Final verification still
      // sees the original record and remains fail-closed.
      return { failure: null, request: null, corrupted: false };
    }
  }

  function controllerToolName(toolName) {
    return toolName === RETRY_FAILED_CHECK_TOOL ? 'run_check' : toolName;
  }

  function syncProductiveState() {
    const state = controller.productiveProgressState();
    process.env.PI_PRODUCTIVE_STATE = state;
    return state;
  }

  let lastSurfaceSignature = null;
  let lastCodingSubmissionGuardSignature = null;

  function codingSubmissionReadiness() {
    if (!codingSession) return { ready: true, missing_outputs: [] };
    const prepared = readPreparedImplementation(process.env.PI_PREPARED_IMPLEMENTATION_FILE);
    if (!requiredPreparedOutputPaths(prepared).length) return { ready: true, missing_outputs: [] };
    return codingSessionSubmissionReadiness({
      prepared,
      cwd: process.cwd(),
      resumed: resumedImplementer,
      validationRepair,
    });
  }

  function setSurface(names, reason) {
    pi.setActiveTools(names);
    const actual = pi.getActiveTools();
    const signature = actual.join(',');
    if (signature !== lastSurfaceSignature) {
      console.log(`PI_TOOL_SURFACE_UPDATE ${JSON.stringify({ stage, reason, active: actual })}`);
      lastSurfaceSignature = signature;
    }
  }

  function syncActionToolSurface(productiveState) {
    const preComplexityRequired =
      config.preComplexityActionResponseMaxTokens != null &&
      controller.preComplexityActionRequired();
    const productiveActionRequired =
      stage === 'implementer' &&
      config.productiveProgress &&
      productiveState === 'action_required';
    // Exact retry is an action-phase substitution for run_check. Outside
    // action_required we do not impose the recovery gate; after the relevant
    // mutation the controller always returns to action_required and the exact
    // retry becomes the verification action for that permit.
    const recoveryState = failedCheckRecoveryState();
    const failedCheckRecovery = productiveActionRequired ? recoveryState.failure : null;
    const recoveryLedgerCorrupted = recoveryState.corrupted;
    const recoveryRetryReady = Boolean(
      productiveActionRequired &&
      failedCheckRecovery &&
      !recoveryLedgerCorrupted &&
      controller.verificationPermitted()
    );

    const largeMutationBudgetActive = stage === 'implementer' && controller.largeMutationBudgetActive();
    // Completed one-shot control tools disappear. Enabled tools such as `subagent` are shown only
    // where the controller gate lets them execute (evidence_allowed), never in action_required.
    const satisfied = controller.transitions.satisfiedToolNames();
    const current = pi.getActiveTools();
    const verificationTool = config.productiveProgress?.verificationTool ?? null;
    // Ledger corruption affects the final verification verdict, not whether
    // the implementer may gather new local evidence. Keep ordinary run_check
    // usable; only exact retry is disabled because its historical scope cannot
    // be reconstructed safely from an incomplete ledger.
    const verificationPermitted = controller.verificationPermitted();
    const recoveryVerificationArmed = controller.recoveryVerificationArmed();
    const verificationVisible = verificationPermitted || recoveryVerificationArmed;
    const currentWithPermittedVerification =
      verificationTool &&
      verificationVisible &&
      verificationToolHiddenByPermitGate &&
      !current.includes(verificationTool)
        ? [...current, verificationTool]
        : current;
    // Exact retry substitutes for an existing verification capability; it must
    // never resurrect verification after another owner deliberately removed
    // run_check. Runtime-owned hiding is tracked explicitly and may restore it.
    const verificationCapabilityOwned = Boolean(
      verificationTool &&
      (current.includes(verificationTool) || verificationToolHiddenByPermitGate)
    );
    const currentWithRecoveryRetry =
      recoveryRetryReady &&
      verificationCapabilityOwned &&
      !currentWithPermittedVerification.includes(RETRY_FAILED_CHECK_TOOL)
        ? [...currentWithPermittedVerification, RETRY_FAILED_CHECK_TOOL]
        : currentWithPermittedVerification;

    // Tools added by a control transition appear in the live list but not in the saved baseline.
    if (unrestrictedActiveTools != null) {
      unrestrictedActiveTools = mergeNewlyActiveTools(unrestrictedActiveTools, currentWithRecoveryRetry);
      // If some other runtime/control transition removed run_check while we were not hiding it,
      // honor that removal instead of resurrecting it from the saved unrestricted baseline.
      if (
        verificationTool &&
        !current.includes(verificationTool) &&
        !verificationToolHiddenByPermitGate
      ) {
        unrestrictedActiveTools = unrestrictedActiveTools.filter(name => name !== verificationTool);
      }
    }
    const submissionReadiness = codingSubmissionReadiness();
    const guardSignature = submissionReadiness.ready ? 'ready' : submissionReadiness.missing_outputs.join('\0');
    if (guardSignature !== lastCodingSubmissionGuardSignature) {
      lastCodingSubmissionGuardSignature = guardSignature;
      if (!submissionReadiness.ready) {
        console.warn(`PI_CODING_SUBMIT_GUARD ${JSON.stringify({
          stage,
          reason: 'prepared_outputs_missing',
          missingOutputs: submissionReadiness.missing_outputs,
          terminalOutcomesRemainAvailable: true,
        })}`);
      }
    }
    const visible = names => names.filter(name =>
      !satisfied.has(name) &&
      (!verificationTool || name !== verificationTool || (verificationVisible && !recoveryRetryReady)) &&
      (name !== RETRY_FAILED_CHECK_TOOL || recoveryRetryReady)
    );
    const applySurface = (names, reason) => {
      if (verificationTool) {
        if (
          current.includes(verificationTool) &&
          !names.includes(verificationTool) &&
          (!verificationVisible || recoveryRetryReady)
        ) {
          verificationToolHiddenByPermitGate = true;
        } else if (verificationVisible && !recoveryRetryReady && names.includes(verificationTool)) {
          verificationToolHiddenByPermitGate = false;
        }
      }
      setSurface(names, reason);
    };

    if (preComplexityRequired || productiveActionRequired) {
      if (unrestrictedActiveTools == null) unrestrictedActiveTools = currentWithRecoveryRetry;
      const restricted = preComplexityRequired
        ? unrestrictedActiveTools.filter(name =>
            new Set([
              ...(config.preComplexityTransitionTools ?? []),
              'submit_result',
              'submit_repair',
            ]).has(name)
          )
        : largeMutationBudgetActive && !recoveryVerificationArmed
          // UX on top of the controller's own hard gate: while the elevated budget is active,
          // don't even show tools this turn is not allowed to call. Exact terminal recovery
          // verification is a separate one-shot gate and temporarily supersedes this surface.
          ? elevatedMutationTurnToolNames(unrestrictedActiveTools, {
              blockerTool: controller.evidenceUnlockAvailable()
                ? config.productiveProgress.blockerTool
                : null,
            })
          : actionRequiredToolNames(unrestrictedActiveTools, {
            actionTools: config.productiveProgress.actionTools,
            controlTools: config.productiveProgress.controlTools,
            blockerTool: controller.evidenceUnlockAvailable()
              ? config.productiveProgress.blockerTool
              : null,
            verificationTools: recoveryRetryReady
              ? [RETRY_FAILED_CHECK_TOOL]
              : verificationVisible
                ? [config.productiveProgress.verificationTool].filter(Boolean)
                : [],
          });
      applySurface(visible(restricted), 'restricted');
      return;
    }

    if (unrestrictedActiveTools != null) {
      applySurface(visible(unrestrictedActiveTools), 'restored');
      unrestrictedActiveTools = null;
      return;
    }
    const remaining = visible(currentWithRecoveryRetry);
    // Preserve tool ordering as part of the model-visible surface; only update when the ordered
    // list actually changes, not merely when the list length changes.
    if (remaining.join('\0') !== current.join('\0')) applySurface(remaining, 'transition_complete');
  }

  // Materialize a newly completed one-shot transition into durable runtime state, the active
  // tool surface, and the next model request (a steering message the model sees in history).
  async function announceTransition(record, productiveState) {
    console.log(`PI_STATE_TRANSITION_COMPLETE ${JSON.stringify({ stage, ...record })}`);
    syncActionToolSurface(productiveState);
    const activeToolNames = pi.getActiveTools();
    const verification = {
      verificationTool: config.productiveProgress?.verificationTool ?? null,
      verificationState: controller.verificationLifecycleState(),
      activeToolNames,
    };
    const block = controller.transitions.stateBlock(verification);
    console.log(`PI_SESSION_STATE ${JSON.stringify({ stage, completed: [...controller.transitions.completed.keys()], block, activeTools: activeToolNames })}`);
    await pi.sendUserMessage(
      `${controller.transitions.transitionNotice(record, verification)}\n\n${block}`,
      { deliverAs: 'steer' },
    );
  }

  function recordRuntimeAbort(failureCode, reason, details = {}) {
    const record = {
      ...details,
      schema_version: 1,
      stage,
      failure_class: 'model_execution_abort',
      failure_code: failureCode,
      reason,
    };
    if (details.failure_class === 'infrastructure') record.failure_class = 'infrastructure';
    // A coding-session fork is recoverable by its parent Implementer. Keep its abort in logs,
    // but never let a nested fork leave job-level failure provenance behind.
    if (codingSession) {
      console.error(`PI_RUNTIME_FAILURE_NESTED ${JSON.stringify(record)}`);
      if (failureCode !== 'PI_TOOL_CONTRACT_FAILURE' || !codingSession.failureFile) return;
    }
    const failureFile = String(codingSession?.failureFile ?? process.env.PI_RUNTIME_FAILURE_FILE ?? '').trim();
    if (!failureFile) return;
    try {
      fs.mkdirSync(path.dirname(failureFile), { recursive: true });
      const tempFile = `${failureFile}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tempFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tempFile, failureFile);
      console.error(`PI_RUNTIME_FAILURE ${JSON.stringify(record)}`);
    } catch (error) {
      // Failure classification is best-effort metadata; it must never suppress the watchdog abort.
      console.error(`PI_RUNTIME_FAILURE_WRITE_ERROR ${JSON.stringify({ stage, failureCode, error: String(error?.message ?? error) })}`);
    }
  }

  // Missing-executor errors are terminal for this runtime, regardless of which
  // event arrives first or whether both hooks report the same tool call.
  let toolContractAborted = false;
  async function abortToolContract(toolName, ctx, reason = `Advertised tool ${toolName} cannot execute; runtime repair required.`) {
    if (toolContractAborted) return;
    toolContractAborted = true;
    recordRuntimeAbort('PI_TOOL_CONTRACT_FAILURE', reason, { failure_class: 'infrastructure', tool: toolName });
    await ctx.abort();
  }

  // pi reports `Tool X not found` through tool_execution_end and/or tool_result for the same call.
  // Only a tool the authoritative request snapshot advertised is a real contract failure; returns
  // replacement guidance for the other (recoverable) classes.
  const missingExecutorCalls = new Map();
  async function handleMissingExecutor(event, ctx) {
    const kind = classifyMissingExecutor(event.toolName, providerCapabilitySnapshot);
    if (kind === 'contract_failure') {
      await abortToolContract(event.toolName, ctx);
      return null;
    }
    const snapshot = providerCapabilitySnapshot;
    const guidance = kind === 'deferred'
      ? `LIFECYCLE: ${event.toolName} became active after provider request ${snapshot.request} was built, so it is not executable in this response. Do not retry it in this response. On a later request, call it only if that request exposes it (its tool list, and CURRENTLY EXPOSED TOOLS when given). ${capabilitySnapshotGuidance(snapshot.executableTools)}`
      : `BLOCKED: ${event.toolName} is not exposed by the runtime. ${capabilitySnapshotGuidance(snapshot.executableTools)}`;
    const key = event.toolCallId ?? `${snapshot.request}:${event.toolName}`;
    if (!missingExecutorCalls.has(key)) {
      missingExecutorCalls.set(key, kind);
      // pi returns its own immediate "not found" result without running tool_result, so the
      // replacement text may never reach the model. A steer lands on the next provider request.
      // It must not promise that request's surface: another tool in this response may still
      // change state and remove the deferred tool again, so the guidance stays conditional on
      // the authoritative snapshot of the request that carries it.
      if (kind === 'deferred') {
        await pi.sendUserMessage(
          `RUNTIME: ${event.toolName} became active after provider request ${snapshot.request} was built, so that call could not execute. Do not retry it in this response. On the next request, call it only if that request exposes it (its tool list, and CURRENTLY EXPOSED TOOLS when given) and it is still needed; the surface may change again before then.`,
          { deliverAs: 'steer' },
        );
      }
      if (kind === 'unavailable') unavailableToolAttempts += 1;
      console.warn(`${kind === 'deferred' ? 'PI_CAPABILITY_LIFECYCLE_MISMATCH' : 'PI_UNAVAILABLE_TOOL_ATTEMPT'} ${JSON.stringify({
        stage,
        kind: kind === 'deferred' ? 'deferred_tool_called' : 'executor_not_found',
        attemptedTool: event.toolName,
        request: snapshot.request,
        requestTools: snapshot.executableTools,
        deferredTools: snapshot.deferredTools,
        ...(kind === 'unavailable' ? { count: unavailableToolAttempts } : {}),
      })}`);
    }
    return guidance;
  }

  function terminalInputForLoop(tool, input) {
    if (!['submit_result', 'submit_repair'].includes(tool)) return null;
    return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  }

  function terminalRecoveryPlan(loopResult, terminalInput, ctx) {
    let currentChangedFiles = [];
    let drift = [];
    let acceptedPaths = [];
    let repositoryFactsAvailable = true;
    try {
      currentChangedFiles = worktreeChangedFiles(ctx.cwd, baseRef());
      const evidence = driftEvidence(ctx.cwd);
      acceptedPaths = [...evidence.acceptedPaths];
      drift = classifyWorktreeDrift({
        cwd: ctx.cwd,
        changed: currentChangedFiles,
        expectedFiles: Array.isArray(terminalInput?.files) ? terminalInput.files : [],
        ...evidence,
      });
    } catch (error) {
      repositoryFactsAvailable = false;
      console.warn('PI_TERMINAL_RECOVERY_FACTS_FAILED ' + JSON.stringify({
        stage,
        obligationKey: loopResult.obligation?.key ?? null,
        error: String(error?.message ?? error),
      }));
    }
    let recoveryActiveTools = pi.getActiveTools();
    const verificationTool = config.productiveProgress?.verificationTool ?? null;
    if (
      loopResult.obligation?.kind === 'validation' &&
      verificationTool &&
      verificationToolHiddenByPermitGate &&
      !recoveryActiveTools.includes(verificationTool)
    ) {
      recoveryActiveTools = [...recoveryActiveTools, verificationTool];
    }
    return selectTerminalRecovery({
      obligation: loopResult.obligation,
      terminalInput,
      activeToolNames: recoveryActiveTools,
      currentChangedFiles,
      drift,
      acceptedPaths,
      repositoryFactsAvailable,
    });
  }

  function terminalObligationSummary(obligation) {
    if (!obligation || typeof obligation !== 'object') return null;
    const summary = {
      key: obligation.key ?? null,
      kind: obligation.kind ?? null,
      code: obligation.code ?? null,
    };
    for (const key of ['paths', 'conflictPaths', 'missingFields', 'requiredTargets', 'missingOutputs']) {
      if (!Array.isArray(obligation[key])) continue;
      summary[key] = obligation[key].slice(0, 20);
      if (obligation[key].length > 20) summary[key + 'Count'] = obligation[key].length;
    }
    return summary;
  }

  function terminalRecoveryPlanSummary(plan) {
    if (!plan || typeof plan !== 'object') return null;
    return {
      status: plan.status ?? null,
      obligationKey: plan.obligationKey ?? null,
      obligationKind: plan.obligationKind ?? null,
      kind: plan.kind ?? null,
      tool: plan.tool ?? null,
      target: plan.target ?? null,
      requiredTool: plan.requiredTool ?? null,
      reason: plan.reason ?? null,
    };
  }

  function abortTerminalRecovery(loopResult, plan, metric, ctx) {
    controller.clearRecoveryVerification();
    const reason = plan?.status === 'blocked'
      ? plan.reason
      : 'The same terminal obligation persisted after a deterministic repair was selected without obligation-reducing progress.';
    const details = {
      unresolved_obligation: terminalObligationSummary(loopResult.obligation),
      selected_repair: terminalRecoveryPlanSummary(plan),
      checkpoint: {
        repository_state: loopResult.repositoryState ?? null,
        worktree_preserved: true,
      },
    };
    recordRuntimeAbort('PI_TERMINAL_RECOVERY_BLOCKED', reason, details);
    console.error('PI_TERMINAL_RECOVERY_BLOCKED ' + JSON.stringify({ ...metric, ...details, reason }));
    ctx.abort();
  }

  async function handleLoopResult(loopResult, ctx, { terminalInput = null } = {}) {
    if (!loopResult?.tripped) return;
    const metric = {
      stage: loopResult.stage,
      tool: loopResult.tool,
      reason: loopResult.reason,
      fingerprintClass: loopResult.fingerprintClass,
      repositoryState: loopResult.repositoryState,
      revisitCount: loopResult.revisitCount,
      window: loopResult.window,
      classification: loopResult.classification,
      noOp: loopResult.noOp,
      repeatedObservation: loopResult.repeatedObservation,
      repeatedFailure: loopResult.repeatedFailure,
      returnedToSeenState: loopResult.returnedToSeenState,
      action: loopResult.action,
      obligationKey: loopResult.obligation?.key ?? null,
      obligationKind: loopResult.obligation?.kind ?? null,
    };
    console.log('PI_LOOP_GUARD ' + JSON.stringify(metric));

    const terminalFailure =
      loopResult.reason === 'repeated_failed_strategy' &&
      loopResult.repeatedFailure === true &&
      loopResult.obligation?.key &&
      DETERMINISTIC_TERMINAL_RECOVERY_KINDS.has(loopResult.obligation?.kind) &&
      ['submit_result', 'submit_repair'].includes(loopResult.tool);

    if (terminalFailure && loopResult.action === 'steer') {
      const retainedRecovery =
        terminalRecoveryState?.obligationKey === loopResult.obligation.key
          ? terminalRecoveryState
          : null;
      const recoveryTerminalInput = retainedRecovery?.terminalInput ?? terminalInput;
      let plan = retainedRecovery?.plan ?? terminalRecoveryPlan(loopResult, recoveryTerminalInput, ctx);
      controller.clearRecoveryVerification();
      if (plan.status === 'repair' && plan.kind === 'exact_validation') {
        if (controller.largeMutationBudgetPending() || controller.largeMutationBudgetActive()) {
          controller.resetLargeMutationBudget();
          elevatedScopePreludeUsed = false;
        }
        if (!controller.armRecoveryVerification(plan.args)) {
          plan = {
            status: 'blocked',
            obligationKey: plan.obligationKey,
            obligationKind: plan.obligationKind,
            reason: 'The exact validation recovery action is available as a runtime tool, but the progress controller has no verification tool configured for this stage.',
            requiredTool: plan.tool,
          };
        }
      }
      terminalRecoveryState = {
        obligationKey: loopResult.obligation.key,
        obligation: loopResult.obligation,
        plan,
        // Preserve the payload that actually produced this obligation. A later locally-blocked
        // retry has no terminal diagnostics and must never become the new metadata baseline.
        terminalInput:
          recoveryTerminalInput && typeof recoveryTerminalInput === 'object' && !Array.isArray(recoveryTerminalInput)
            ? structuredClone(recoveryTerminalInput)
            : recoveryTerminalInput,
      };
      if (plan.status === 'blocked') {
        abortTerminalRecovery(loopResult, plan, metric, ctx);
        return;
      }
      terminalRecoveryRequiredTool = plan.tool;
      requireToolOnNextProviderRequest = true;
      loopGuardSteeredThisTurn = true;
      const guidance = terminalRecoveryGuidance(plan);
      console.warn('PI_TERMINAL_RECOVERY_SELECTED ' + JSON.stringify({
        ...metric,
        plan: terminalRecoveryPlanSummary(plan),
        activeTools: pi.getActiveTools(),
      }));
      await pi.sendUserMessage(guidance, { deliverAs: 'steer' });
      return;
    }

    if (terminalFailure && loopResult.action === 'abort') {
      const plan = terminalRecoveryState?.obligationKey === loopResult.obligation.key
        ? terminalRecoveryState.plan
        : terminalRecoveryPlan(loopResult, terminalInput, ctx);
      abortTerminalRecovery(loopResult, plan, metric, ctx);
      return;
    }

    if (loopResult.action === 'steer') {
      loopGuardSteeredThisTurn = true;
      console.warn('PI_LOOP_GUARD_STEER ' + JSON.stringify(metric));
      const steerMessage = loopResult.reason === 'repeated_no_evidence'
        ? 'RUNTIME LOOP GUARD: repeated evidence calls completed successfully but returned no usable evidence. Do not repeat the same empty lookup. Change the evidence target/query, take a productive action from what is already known, or submit/stop if the task is complete or genuinely blocked.'
        : 'RUNTIME LOOP GUARD: the current strategy is cycling through previously seen evidence or repository state. Do not repeat or cosmetically vary the same approach. Choose a genuinely different action that can create new evidence/state, or submit/stop if the task is already complete or blocked.';
      await pi.sendUserMessage(
        steerMessage,
        { deliverAs: 'steer' },
      );
    } else {
      console.error('PI_LOOP_GUARD_ABORT ' + JSON.stringify(metric));
      ctx.abort();
    }
  }

  async function applyBudget(level, ctx) {
    if (!ctx.model) throw new Error('No active model is available for response budgeting');
    const budgetedModel = controller.modelFor(ctx.model, level);
    process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = String(budgetedModel.maxTokens);
    const changed = await pi.setModel(budgetedModel);
    if (!changed) throw new Error(`Failed to apply ${level} response budget`);
  }

  async function applyTokenCap(maxTokens, ctx) {
    if (!ctx.model) throw new Error('No active model is available for response budgeting');
    const cappedModel = { ...ctx.model, maxTokens };
    process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = String(maxTokens);
    const changed = await pi.setModel(cappedModel);
    if (!changed) throw new Error(`Failed to apply action-required response cap of ${maxTokens} tokens`);
  }

  function truncationGuidance(toolName) {
    return truncatedToolCallGuidance(toolName, {
      largeMutationBudgetTool: controller.largeMutationBudgetTool,
      codingSessionTool: config.productiveProgress?.codingSessionTool ?? null,
    });
  }

  function finalValidationGuidance() {
    const checks = (projectConfig().checks?.final ?? []).map(step => step.name).filter(Boolean);
    return checks.length
      ? `Authoritative final checks still run automatically after submit_result and before publication: ${checks.join(' -> ')}.`
      : 'Authoritative final validation still runs automatically after submit_result and before publication.';
  }

  function verificationLifecycleGuidance() {
    const verificationTool = config.productiveProgress?.verificationTool;
    if (!verificationTool) return finalValidationGuidance();
    const state = controller.verificationLifecycleState();
    const lifecycle = state === 'available'
      ? `${verificationTool} is available once for the current mutation state.`
      : state === 'exhausted'
        ? `${verificationTool} is exhausted for the current mutation state and is unavailable now. Do not call it again unless a new successful mutation grants a new focused check.`
        : `${verificationTool} is not yet available; it becomes available after a successful mutation.`;
    return `${lifecycle} ${finalValidationGuidance()}`;
  }

  function taskSpecificToolGuidance(activeToolNames, {
    ceilingHit = false,
    preComplexityRequired = false,
    postComplexityRequired = false,
  } = {}) {
    const active = new Set(activeToolNames);
    const hints = [];

    if (preComplexityRequired && active.has('declare_task_complexity')) {
      hints.push('Call declare_task_complexity immediately with the classification already supported by the current evidence.');
    }

    if (stage === 'reviewer' && postComplexityRequired) {
      if (active.has('submit_result')) {
        hints.push('If the current issue, diff, and changed code are sufficient, call submit_result now with PASS or CHANGES_REQUESTED.');
      }
      const reviewerEvidenceTools = activeToolNames.filter(name =>
        !['submit_result', 'declare_task_complexity', 'set_response_budget'].includes(name)
      );
      if (reviewerEvidenceTools.length > 0) {
        hints.push('Otherwise use exactly one currently exposed evidence tool for the unresolved review question, then decide.');
      }
    }

    if (stage === 'implementer') {
      const codingSessionTool = config.productiveProgress?.codingSessionTool;
      if (ceilingHit && codingSessionTool && active.has(codingSessionTool)) {
        hints.push(`If the implementation is large, call ${codingSessionTool} now; it keeps the current context and provides the large coding ceiling instead of drafting code here.`);
      }
      if (active.has(ACCEPT_MUTATION_SCOPE_TOOL)) {
        hints.push('Before mutating a new publishable path, call accept_mutation_scope with that path and a task-specific rationale. Register scratch/probe paths as temporary; temporary paths must be removed before submission.');
      }
      if (active.has('submit_result')) {
        hints.push('If explicit written requirements or constraints are mutually incompatible and no compliant mutation exists, call submit_result with blocked_reason now.');
      }
      const blockerTool = config.productiveProgress?.blockerTool;
      if (blockerTool && active.has(blockerTool)) {
        hints.push(`Call ${blockerTool} only when exactly one concrete missing fact prevents the next safe action.`);
        if (codingSession && !active.has('read')) {
          hints.push(`This coding session is action-required: read is not exposed now. Do not invent helper tools such as read_for_input; request the one missing fact through ${blockerTool}, or continue with an exposed mutation/terminal tool.`);
        }
      }
      if (active.has(RETRY_FAILED_CHECK_TOOL)) {
        hints.push(`Use ${RETRY_FAILED_CHECK_TOOL} to rerun the exact unresolved failed verification scope after fixing it.`);
      }
    }

    return hints.join(' ');
  }

  syncProductiveState();

  // The run_check sandbox is a hard dependency of stages that expose it. Prove it works before any
  // agent turn is spent, and fail the stage as an infrastructure error rather than let the agent
  // discover a broken runner mid-task and go looking for an unrestricted shell.
  async function preflightRunCheckSandbox() {
    const result = await sandboxPreflight();
    const record = result.ok
      ? { ...result, stage, ok: true }
      : { stage, ok: false, summary: result.summary, infrastructure: result.infrastructure, stderr_tail: result.stderr_tail };
    console[result.ok ? 'info' : 'error'](`PI_RUN_CHECK_PREFLIGHT ${JSON.stringify(record)}`);
    if (!result.ok) throw new Error(`run_check sandbox preflight failed: ${result.summary}`);
  }

  // The request boundary is the capability authority. Re-synchronize the surface immediately
  // before every Implementer provider request, filter payload.tools to that surface, snapshot the
  // executable definitions, and constrain the first request that enters action_required. This
  // includes the first coding-session request, so inherited parent history cannot spend a turn
  // attempting a read/cleanup tool that the fork does not expose yet.
  let codingReadyAt = null;
  let codingFirstToolLogged = false;
  let codingFirstResponseLogged = false;
  let codingResponseNumber = 0;
  let codingProviderRequestStartedAt = null;
  if (stage === 'implementer') {
    let patchedThinkingRequests = 0;
    pi.on('before_provider_request', (event) => {
      forcedProviderRequestInFlight = false;
      if (codingSession) codingProviderRequestStartedAt = Date.now();
      const productiveState = syncProductiveState();
      syncActionToolSurface(productiveState);

      let patched = codingSession ? disableThinkingInPayload(event.payload) : event.payload;
      if (terminalRecoveryState) {
        patched = compactTerminalRecoveryPayload(patched, terminalRecoveryState);
      }
      if (codingSession && patched !== event.payload && ++patchedThinkingRequests === 1) {
        codingSessionLog('thinking_disabled', {
          side: 'fork',
          sessionId: codingSession.sessionId,
          enableThinking: patched.chat_template_kwargs.enable_thinking,
          maxTokens: patched.max_completion_tokens ?? patched.max_tokens ?? null,
        });
      }

      if (Array.isArray(patched?.tools)) {
        const active = new Set(pi.getActiveTools());
        let tools = patched.tools.filter(tool => active.has(tool.function?.name ?? tool.name));
        if (terminalRecoveryRequiredTool) {
          const selected = tools.filter(tool =>
            controllerToolName(tool.function?.name ?? tool.name) === terminalRecoveryRequiredTool
          );
          if (selected.length) {
            tools = selected;
            requireToolOnNextProviderRequest = true;
            console.warn('PI_TERMINAL_RECOVERY_TOOL_SURFACE ' + JSON.stringify({
              stage,
              obligationKey: terminalRecoveryState?.obligationKey ?? null,
              tool: terminalRecoveryRequiredTool,
            }));
          } else {
            console.warn('PI_TERMINAL_RECOVERY_TOOL_DEFERRED ' + JSON.stringify({
              stage,
              obligationKey: terminalRecoveryState?.obligationKey ?? null,
              tool: terminalRecoveryRequiredTool,
            }));
          }
        }
        if (
          tools.length !== patched.tools.length ||
          tools.some((tool, index) => tool !== patched.tools[index])
        ) {
          patched = { ...patched, tools };
        }

        // pi resolves this turn's tool calls against the context captured with this payload, so
        // the payload's definitions are the executable surface of this request. A tool activated
        // after assembly (for example by the sync above) cannot execute in this turn even if its
        // definition were added here; pi exposes it from the next request. Record it as deferred
        // instead of advertising it.
        const executableTools = providerToolNames(patched);
        const liveActiveTools = pi.getActiveTools();
        const deferredTools = liveActiveTools.filter(name => !executableTools.includes(name));
        providerCapabilitySnapshot = {
          request: ++providerRequestSequence,
          productiveState,
          activeTools: executableTools,
          executableTools,
          liveActiveTools,
          deferredTools,
        };
        console.log(`PI_PROVIDER_CAPABILITY_SNAPSHOT ${JSON.stringify({ stage, ...providerCapabilitySnapshot })}`);
        if (deferredTools.length) {
          console.warn(`PI_PROVIDER_CAPABILITY_DEFERRED ${JSON.stringify({
            stage,
            request: providerCapabilitySnapshot.request,
            executableTools,
            activeTools: liveActiveTools,
            deferredTools,
          })}`);
        }

        const enteringActionRequired =
          productiveState === 'action_required' &&
          lastProviderProductiveState !== 'action_required' &&
          executableTools.length > 0;
        if (enteringActionRequired) {
          requireToolOnNextProviderRequest = true;
          console.warn(`PI_ACTION_REQUIRED_TOOL_CHOICE_ARMED ${JSON.stringify({
            stage,
            reason: codingSession && lastProviderProductiveState == null
              ? 'coding_session_first_request'
              : 'action_required_entry',
            activeTools: executableTools,
          })}`);
        }
        lastProviderProductiveState = productiveState;
      }

      if (requireToolOnNextProviderRequest) {
        if (productiveState !== 'action_required') {
          requireToolOnNextProviderRequest = false;
          console.warn(`PI_ACTION_REQUIRED_TOOL_CHOICE_CLEARED ${JSON.stringify({ stage, reason: 'state_changed', productiveState })}`);
        } else {
          const constrained = requireToolChoiceInPayload(patched);
          if (constrained !== patched) {
            forcedProviderRequestInFlight = true;
            console.warn(`PI_ACTION_REQUIRED_TOOL_CHOICE ${JSON.stringify({
              stage,
              mode: 'required',
              request: providerCapabilitySnapshot?.request ?? null,
              activeTools: providerCapabilitySnapshot?.executableTools ?? pi.getActiveTools(),
            })}`);
            patched = constrained;
          }
        }
      }
      return patched;
    });
  }

  // Registers the trusted coding-session agent with pi-subagents (synchronous event contract).
  let codingSessionAgent = null;
  function ensureCodingSessionAgent() {
    if (codingSessionAgent?.ok) return codingSessionAgent;
    // Registry inventory includes hidden tools; the current action surface does not.
    const executable = (pi.getAllTools?.() ?? pi.getActiveTools().map(name => ({ name }))).map(tool => tool.name);
    const allowed = config.productiveProgress.codingSessionTools ?? [];
    const definition = codingSessionAgentDefinition(allowed.filter(name => executable.includes(name)));
    const request = { version: 1, name: config.productiveProgress.codingSessionAgent, definition };
    pi.events?.emit?.(RUNTIME_AGENT_REGISTER_EVENT, request);
    codingSessionAgent = request.result
      ? (request.result.ok
        ? { ok: true, tools: [...definition.tools] }
        : { ok: false, error: String(request.result.error?.message ?? request.result.error) })
      : { ok: false, error: 'pi-subagents did not handle runtime agent registration' };
    codingSessionLog(codingSessionAgent.ok ? 'agent_registered' : 'agent_unavailable', {
      agent: request.name, source: 'runtime', thinking: definition.thinking, tools: definition.tools, extensions: definition.extensions,
      ...(codingSessionAgent.ok ? {} : { error: codingSessionAgent.error }),
    });
    return codingSessionAgent;
  }

  // Trusted ownership evidence for unjournaled cleanup (#438): record the run-start untracked set
  // before the model can act. Exclusive create, so forks and later hooks never overwrite it.
  function driftEvidence(cwd) {
    const journal = mutationJournalState(cwd, process.env);
    const journalPaths = new Map();
    for (const entry of journal.entries) journalPaths.set(entry.path, entry.id);
    const receipt = mutationScopeReceipt(cwd, process.env);
    return {
      baseline: readWorktreeBaseline(process.env),
      observed: readWorktreeObserved(process.env),
      acceptedPaths: new Set((receipt.accepted ?? []).map(item => item.path)),
      journalPaths,
    };
  }

  function observeDriftSafely(cwd, phase) {
    try { observeWorktreeDrift(cwd, process.env, phase); } catch (error) {
      console.warn(`PI_WORKTREE_OBSERVE_FAILED ${JSON.stringify({ phase, message: String(error?.message ?? error) })}`);
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    if (stage === 'implementer') {
      try { captureWorktreeBaseline(ctx.cwd, process.env); } catch (error) {
        console.warn(`PI_WORKTREE_BASELINE_CAPTURE_FAILED ${JSON.stringify({ message: String(error?.message ?? error) })}`);
      }
    }
    // The sandbox preflight is the first hard gate: nothing else starts if it fails.
    if (config.productiveProgress?.verificationTool === 'run_check') await preflightRunCheckSandbox();
    if (stage === 'implementer' && config.productiveProgress?.codingSessionTool) ensureCodingSessionAgent();
    await applyBudget('short', ctx);
    syncActionToolSurface(syncProductiveState());
    if (codingSession) {
      const entries = ctx.sessionManager?.getEntries?.() ?? [];
      codingReadyAt = Date.now();
      codingSessionLog('session_ready', {
        side: 'fork',
        sessionId: codingSession.sessionId,
        maxTokens: Number(ctx.model?.maxTokens) || null,
        thinkingLevel: pi.getThinkingLevel?.() ?? null,
        activeTools: pi.getActiveTools(),
        inheritedEntries: entries.length,
        inheritedToolResults: entries.filter(entry => entry?.message?.role === 'toolResult').length,
        forkedFromParent: Boolean(ctx.sessionManager?.getHeader?.()?.parentSession),
      });
    }
  });

  if (controller.requireComplexity && !config.implementationPlannerAgent) {
    pi.registerTool({
      name: 'declare_task_complexity',
      label: 'Declare task complexity',
      description: 'Record the trivial, normal, or complex classification. Complexity is planning metadata only; it does not change tool quotas or response budgets.',
      parameters: Type.Object({
        complexity: Type.Union([
          Type.Literal('trivial'),
          Type.Literal('normal'),
          Type.Literal('complex'),
        ]),
        reason: Type.String({ description: 'One short sentence explaining the classification' }),
      }),
      async execute(_toolCallId, params) {
        const result = controller.setComplexity(params.complexity);
        return {
          content: [{
            type: 'text',
            text: result.changed
              ? `Complexity set to ${result.complexity}. Execute the plan; escalate only if the actual scope expands.`
              : `Complexity remains ${result.complexity}.`,
          }],
          details: { ...result, reason: params.reason },
        };
      },
    });
  }

  if (config.productiveProgress?.blockerTool) {
    pi.registerTool({
      name: config.productiveProgress.blockerTool,
      label: 'Request one evidence action',
      description: 'Use only when one concrete missing fact prevents the next productive action. This unlocks exactly one evidence-gathering tool call; after that call runtime returns to action-required state.',
      parameters: Type.Object({
        missing: Type.String({ minLength: 1, maxLength: 300 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_toolCallId, params) {
        return {
          content: [{
            type: 'text',
            text: `One evidence action unlocked for: ${params.missing}. After that evidence call, runtime returns to action-required state.`,
          }],
          details: params,
        };
      },
    });
  }

  const pendingMutationSnapshots = new Map();
  // Truncated calls already guided, whichever of tool_result / tool_execution_end fired first.
  const truncationGuidedCalls = new Set();
  const pendingLoopCalls = new Map();
  const pendingToolInputs = new Map();
  const pendingEvidenceConsumptionNotices = new Map();
  const pendingBashValidationFingerprints = new Map();
  let lastSuccessfulMutationSnapshot = null;
  let lastSuccessfulMutationLocalOnlyMarkerId = null;

  // Initialize the shared sidecar before the first mutation. Parent, coding forks and restored
  // attempts all read the same bounded journal rather than relying on process-local snapshots.
  if (stage === 'implementer') mutationJournalState(process.cwd(), process.env);

  if (stage === 'implementer') {
    pi.registerTool({
      name: ACCEPT_MUTATION_SCOPE_TOOL,
      label: 'Accept mutation scope',
      description: 'Record task-related mutation intent in trusted runtime state before changing a new path. disposition=publishable authorizes the path for the final diff only when accepted before it becomes changed. disposition=temporary permits scratch/probe work but the path must be removed before final validation/publication. A path that is already changed cannot be retroactively made publishable.',
      parameters: Type.Object({
        paths: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 20 }),
        disposition: Type.Union([
          Type.Literal('publishable'),
          Type.Literal('temporary'),
        ]),
        rationale: Type.String({ minLength: 8, maxLength: 500 }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = registerMutationScope({
          cwd: ctx.cwd,
          paths: params.paths,
          disposition: params.disposition,
          rationale: params.rationale,
          env: process.env,
        });
        return {
          content: [{
            type: 'text',
            text: params.disposition === 'publishable'
              ? `Accepted publishable mutation scope: ${result.paths.join(', ')}. Mutate only the accepted task-related paths.`
              : `Registered temporary mutation scope: ${result.paths.join(', ')}. These paths must be removed or restored before submit_result can publish.`,
          }],
          details: result,
        };
      },
    });

    pi.registerTool({
      name: 'structural_edit',
      label: 'Structural AST edit',
      description: 'Preferred source-code mutation when one exact syntax node can be described with an ast-grep pattern/rewrite. ast-grep infers the language from the target file, dry-runs the rewrite, requires exactly one AST match, verifies the matched byte range is still current, then writes that one replacement atomically. Use metavariables to preserve untouched code instead of reproducing neighboring statements. Use safe_edit for bounded text/config edits or when structural matching is not a good fit.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 1000 }),
        pattern: Type.String({ minLength: 1, maxLength: 20000 }),
        rewrite: Type.String({ minLength: 1, maxLength: 20000 }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = structuralEdit(ctx.cwd, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        };
      },
    });

    pi.registerTool({
      name: 'safe_edit',
      label: 'Safe line edit',
      description: 'Deterministic current-worktree mutation by 1-based line/range. Prefer it for bounded insert/replace changes when reproducing multiline oldText would be brittle. It re-reads the file immediately before writing, validates an optional expected marker, preserves newline style/final-newline state, writes atomically, returns a bounded post-edit preview of what landed on disk, and participates in normal rollback/progress handling. A result with changed=false means no edit occurred. Do not re-read merely to verify a successful change.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 1000 }),
        operation: Type.Union([
          Type.Literal('insert_before'),
          Type.Literal('insert_after'),
          Type.Literal('replace'),
        ]),
        start_line: Type.Integer({ minimum: 1 }),
        end_line: Type.Optional(Type.Integer({ minimum: 1 })),
        text: Type.String({ minLength: 1, maxLength: 20000 }),
        expected_marker: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = safeEdit(ctx.cwd, params);
        return {
          content: [{
            type: 'text',
            text: result.changed
              ? JSON.stringify(result)
              : `NO CHANGE: replacement is identical to the existing content. ${JSON.stringify(result)}`,
          }],
          details: result,
        };
      },
    });

    async function executeAuthoritativeRunCheck(params, ctx, { retry = false } = {}) {
      const result = await runCheck(ctx.cwd, params);
      const scope = normalizeScope(params, ctx.cwd);
      const codingValidation = recordCodingBehavioralValidation({
        scope,
        result,
        env: process.env,
        cwd: ctx.cwd,
      });
      if (codingValidation) {
        console.info(`PI_CODING_TARGETED_PYTEST ${JSON.stringify({
          stage,
          status: 'pass',
          targets: codingValidation.targets,
        })}`);
      }
      console.info(`PI_RUN_CHECK ${JSON.stringify(checkMetricRecord(result, { backend: 'pi', stage }))}`);
      const appendedRecord = appendCheckRecord(process.env.PI_VALIDATION_LEDGER_FILE, {
        kind: result.kind,
        scope,
        status: result.status,
        exit_code: result.exit_code,
        source: 'run_check',
        stage,
        backend: 'pi',
        run_id: validationRunId(),
        attempt_id: validationAttemptId(),
        diagnostics_count: result.diagnostics.length,
        summary: result.summary,
        infrastructure: result.infrastructure ?? null,
      });
      if (retry) {
        console.info(`PI_RUN_CHECK_RETRY ${JSON.stringify({ stage, kind: result.kind, scope, status: result.status })}`);
      }
      // Re-read recovery state after appending the result. Emit retry guidance
      // only when this exact failed record became the active deterministic
      // recovery obligation and its scope can actually be reconstructed.
      const recoveryAfterAppend = failedCheckRecoveryState();
      const exactRetryAvailable = Boolean(
        result.status === 'fail' &&
        stage === 'implementer' &&
        config.productiveProgress?.verificationTool === 'run_check' &&
        recoveryAfterAppend.request &&
        recoveryAfterAppend.failure?.seq === appendedRecord.seq &&
        recoveryAfterAppend.failure?.run_id === appendedRecord.run_id &&
        recoveryAfterAppend.failure?.stage === appendedRecord.stage &&
        (
          pi.getActiveTools().includes('run_check') ||
          verificationToolHiddenByPermitGate
        )
      );
      const response = exactRetryAvailable
        ? {
            ...result,
            recovery: {
              required: true,
              tool: RETRY_FAILED_CHECK_TOOL,
              kind: result.kind,
              scope,
              instruction: 'Fix the reported failure with a relevant mutation, then call retry_last_failed_check. Broader or different run_check scopes do not resolve this failure.',
            },
          }
        : result;
      return { result, response };
    }

    pi.registerTool({
      name: 'run_check',
      label: 'Run focused check',
      description: 'Focused local verification without shell access. kind=python_compile|ruff take paths (files/dirs in the worktree); kind=pytest takes targets (test files or node ids); kind=profile takes profile=node_tests|pytest_all. Returns {status: pass|fail|timeout|invalid|infra_error, summary, diagnostics[{file,line,column,code,message}], stdout_tail, stderr_tail}. A failing check creates an exact kind+scope recovery requirement: fix the diagnostic with a mutation, then use retry_last_failed_check; broader or different scopes cannot resolve it. status=infra_error means the runner could not run the check (sandbox or tool missing): it says nothing about your change, so do not retry, do not look for a shell workaround, and report it as an infrastructure blocker. Available once after each successful mutation; the permit is consumed when the call is accepted regardless of the check outcome. Passing does not replace final validation; still call submit_result.',
      parameters: Type.Object({
        kind: Type.Union(CHECK_KINDS.map(kind => Type.Literal(kind))),
        paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 })),
        targets: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 })),
        profile: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const { result, response } = await executeAuthoritativeRunCheck(params, ctx);
        return { content: [{ type: 'text', text: JSON.stringify(response) }], details: result };
      },
    });

    pi.registerTool({
      name: RETRY_FAILED_CHECK_TOOL,
      label: 'Retry failed check',
      description: 'Deterministically rerun the exact kind+scope of the unresolved authoritative run_check failure recorded in the validation ledger. It takes no scope arguments and is exposed only after a successful mutation grants a verification permit. Use it instead of choosing a broader or different run_check scope.',
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const recoveryState = failedCheckRecoveryState();
        if (recoveryState.corrupted) {
          const result = { status: 'invalid', summary: 'The validation ledger is corrupted; exact failed-scope recovery cannot be reconstructed safely.' };
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        }
        const failed = recoveryState.failure;
        if (!failed) {
          const result = { status: 'invalid', summary: 'No unresolved failed run_check scope is available to retry.' };
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        }
        const params = runCheckRequestForRecord(failed);
        const { result, response } = await executeAuthoritativeRunCheck(params, ctx, { retry: true });
        return { content: [{ type: 'text', text: JSON.stringify(response) }], details: result };
      },
    });

    pi.registerTool({
      name: 'recover_worktree',
      label: 'Recover accidental worktree changes',
      description: 'Delete one untracked file or restore one tracked file to HEAD without a shell or coding session. delete_untracked and revert_tracked work only on paths the runtime can prove changed during this stage (clean/absent in the run-start baseline, not journaled, delete also not in accepted scope); pre-existing, journaled (use undo_mutation) and protected paths are refused with a precise code. Refuses escapes, symlinks, ignored files, .git and .gitignore. A file-set mismatch lists each remaining path under file_set.drift with its exact recovery action. Returns the current changed files and validates them against expected_files immediately; pass the intended final file set. A mismatch is recoverable: clean remaining accidental files, then submit_result.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('delete_untracked'), Type.Literal('revert_tracked')]),
        path: Type.String({ minLength: 1, maxLength: 1000 }),
        expected_files: Type.Array(Type.String(), { maxItems: 200 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const result = recoverWorktree({
          ...params,
          cwd: ctx.cwd,
          base: baseRef(),
          ledgerPath: process.env.PI_VALIDATION_LEDGER_FILE,
          ...driftEvidence(ctx.cwd),
        });
        invalidateTerminalReceipt(process.env);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });

    pi.registerTool({
      name: 'undo_mutation',
      label: 'Undo a recorded mutation',
      description: 'Selectively undo one recorded structural_edit/safe_edit/edit/write by mutation_id. The runtime restores exact prior bytes/mode or deletes a file only when that mutation proved it created the file. It compares the current file with the recorded post-fingerprint first and refuses stale/conflicting, symlink, hard-link, out-of-worktree and protected control-plane targets. Pass the intended final file set so cleanup is validated immediately.',
      parameters: Type.Object({
        mutation_id: Type.String({ minLength: 1, maxLength: 80 }),
        expected_files: Type.Array(Type.String(), { maxItems: 200 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        let result;
        try {
          result = undoMutation({
            cwd: ctx.cwd,
            mutationId: params.mutation_id,
            reason: params.reason,
            ledgerPath: process.env.PI_VALIDATION_LEDGER_FILE,
            env: process.env,
          });
        } catch (error) {
          // mutation_undo_persist_failed means the repository bytes were already restored even
          // though the durable journal still needs the same-id retry. Invalidate immediately so
          // no pre-undo terminal receipt can survive that partial success.
          if (error?.code === 'mutation_undo_persist_failed') invalidateTerminalReceipt(process.env);
          throw error;
        }
        // Repository bytes are already changed at this point. Invalidate before file-set/ledger
        // bookkeeping so a diagnostics persistence failure cannot leave a pre-undo receipt alive.
        invalidateTerminalReceipt(process.env);
        let fileSet;
        try {
          const changed = worktreeChangedFiles(ctx.cwd, baseRef());
          try {
            assertImplementerFileSet(changed, params.expected_files);
            fileSet = { status: 'pass', changed_files: changed };
          } catch (error) {
            fileSet = {
              status: 'invalid',
              changed_files: changed,
              summary: error.message,
              drift: classifyWorktreeDrift({ cwd: ctx.cwd, changed, expectedFiles: params.expected_files, ...driftEvidence(ctx.cwd) }),
            };
          }
        } catch (error) {
          fileSet = { status: 'infra_error', summary: error.message };
        }
        result.file_set = fileSet;
        if (process.env.PI_VALIDATION_LEDGER_FILE) {
          appendCheckRecord(process.env.PI_VALIDATION_LEDGER_FILE, {
            run_id: validationRunId(),
            attempt_id: validationAttemptId(),
            stage: 'implementer',
            backend: 'pi',
            source: 'mutation_undo',
            kind: 'undo_mutation',
            scope: { paths: [result.path], mutation_id: result.mutation_id },
            status: 'pass',
            summary: params.reason,
            mutation: result,
          });
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });

    pi.registerTool({
      name: 'rollback_last_mutation',
      label: 'Rollback last mutation',
      description: 'Fast shortcut for undoing the shared latest structural_edit/safe_edit/edit/write. Persistent journal order is authoritative across parent/coding-session processes and uses compare-before-undo. After bounded-journal degradation, rollback is available only in the process that made the local-only mutation; other processes refuse instead of selecting an older mutation. After resume the barrier is intentionally stale because no process owns its prior-byte snapshot, so this shortcut continues to refuse until a new journaled mutation supersedes the barrier or explicit targeted recovery resolves the state. The local-only path also refuses if later bytes changed.',
      parameters: Type.Object({
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const journal = mutationJournalState(ctx.cwd, process.env);
        const localOnlyBarrier = journal.local_only_barrier ?? null;

        if (localOnlyBarrier) {
          const snapshot = lastSuccessfulMutationSnapshot;
          const ownsLatestLocalOnly = Boolean(
            snapshot &&
            lastSuccessfulMutationLocalOnlyMarkerId === localOnlyBarrier.id
          );
          if (!ownsLatestLocalOnly) {
            const error = new Error(JSON.stringify({
              code: 'mutation_rollback_latest_local_only_unavailable',
              marker_id: localOnlyBarrier.id,
              path: localOnlyBarrier.path,
              recovery: 'The shared latest mutation was degraded to process-local rollback in another coding session/process. Refusing to roll back an older journal entry. Continue with an explicit targeted recovery/edit instead.',
            }));
            error.code = 'mutation_rollback_latest_local_only_unavailable';
            throw error;
          }

          const current = currentMutationFingerprint(ctx.cwd, localOnlyBarrier.path);
          const prior = snapshotFingerprint(snapshot);
          const sameFingerprint = (left, right) => (
            left?.exists === right?.exists &&
            (!left?.exists || (
              left.mode === right.mode &&
              left.size === right.size &&
              left.sha256 === right.sha256
            ))
          );

          let alreadyRestored = false;
          if (sameFingerprint(current, localOnlyBarrier.post)) {
            if (snapshot.existed) {
              fs.mkdirSync(path.dirname(snapshot.absolutePath), { recursive: true });
              fs.writeFileSync(snapshot.absolutePath, snapshot.content);
              if (snapshot.mode != null) fs.chmodSync(snapshot.absolutePath, snapshot.mode);
            } else if (fs.existsSync(snapshot.absolutePath)) {
              fs.rmSync(snapshot.absolutePath, { force: true });
            }
          } else if (sameFingerprint(current, prior)) {
            alreadyRestored = true;
          } else {
            const error = new Error(JSON.stringify({
              code: 'mutation_rollback_conflict',
              marker_id: localOnlyBarrier.id,
              path: localOnlyBarrier.path,
              expected_post: localOnlyBarrier.post,
              expected_prior: prior,
              actual: current,
              recovery: 'The local-only mutation target changed after degradation; refusing to overwrite later bytes.',
            }));
            error.code = 'mutation_rollback_conflict';
            throw error;
          }

          try {
            clearMutationJournalLocalOnly({
              cwd: ctx.cwd,
              markerId: localOnlyBarrier.id,
              env: process.env,
            });
          } catch (error) {
            // The file may already be restored while the marker remains durable. Keep local state
            // so retry can recognize the prior fingerprint and finish clearing the same marker.
            invalidateTerminalReceipt(process.env);
            throw error;
          }

          lastSuccessfulMutationSnapshot = null;
          lastSuccessfulMutationLocalOnlyMarkerId = null;
          invalidateTerminalReceipt(process.env);
          return {
            content: [{
              type: 'text',
              text: `Rolled back the latest local-only mutation on ${localOnlyBarrier.path}. Continue from the restored repository state.`,
            }],
            details: {
              path: localOnlyBarrier.path,
              marker_id: localOnlyBarrier.id,
              reason: params.reason,
              journaled: false,
              already_restored: alreadyRestored,
            },
          };
        }

        // Persistent sidecar order is the only authority for journaled mutations. Never let stale
        // process-local identity outrank mutations added later by a coding-session fork.
        const mutationId = journal.entries.at(-1)?.id ?? null;
        if (!mutationId) {
          throw new Error('No successful structural_edit/safe_edit/edit/write is available to roll back');
        }

        let result;
        try {
          result = undoMutation({
            cwd: ctx.cwd,
            mutationId,
            reason: params.reason,
            ledgerPath: process.env.PI_VALIDATION_LEDGER_FILE,
            env: process.env,
          });
        } catch (error) {
          if (error?.code === 'mutation_undo_persist_failed') invalidateTerminalReceipt(process.env);
          throw error;
        }
        // The persistent undo already changed repository state. Clear stale local rollback state
        // and invalidate the terminal receipt before ledger persistence, which may itself fail.
        lastSuccessfulMutationSnapshot = null;
        lastSuccessfulMutationLocalOnlyMarkerId = null;
        invalidateTerminalReceipt(process.env);
        if (process.env.PI_VALIDATION_LEDGER_FILE) {
          appendCheckRecord(process.env.PI_VALIDATION_LEDGER_FILE, {
            run_id: validationRunId(),
            attempt_id: validationAttemptId(),
            stage: 'implementer',
            backend: 'pi',
            source: 'mutation_undo',
            kind: 'rollback_last_mutation',
            scope: { paths: [result.path], mutation_id: result.mutation_id },
            status: 'pass',
            summary: params.reason,
            mutation: result,
          });
        }
        return {
          content: [{
            type: 'text',
            text: `Rolled back shared latest recorded mutation ${result.mutation_id} on ${result.path}. Continue from the restored repository state.`,
          }],
          details: result,
        };
      },
    });

    if (controller.largeMutationBudgetTool) {
      pi.registerTool({
        name: controller.largeMutationBudgetTool,
        label: 'Request large mutation budget',
        description: `LEGACY: prefer begin_coding_session. Grant the next mutation response a ${controller.largeMutationBudgetMaxTokens}-token completion ceiling for one large write/edit/safe_edit/structural_edit payload that would not fit in the normal small action budget. Do not call this for extra reasoning/planning room. If the target path still needs accepted scope, call accept_mutation_scope first; that declaration preserves the elevated budget for the following real mutation. The budget collapses after the actual mutation/rollback/submit action or after unrelated use.`,
        parameters: Type.Object({
          reason: Type.String({ minLength: 1, maxLength: 300, description: 'One short sentence on why the next mutation needs the larger budget' }),
        }),
        async execute(_toolCallId, params) {
          return {
            content: [{
              type: 'text',
              text: `Large mutation budget armed (${controller.largeMutationBudgetMaxTokens} max output tokens). If needed, call accept_mutation_scope first; the runtime preserves this budget across that scope-only response. Then use it for one structural_edit/safe_edit/edit/write/rollback_last_mutation/submit_result call.`,
            }],
            details: { reason: params.reason, maxTokens: controller.largeMutationBudgetMaxTokens },
          };
        },
      });
    }

    const codingSessionTool = config.productiveProgress?.codingSessionTool;
    if (codingSessionTool && config.productiveProgress?.codingSessionAgent) {
      const sessionConfig = config.productiveProgress;
      const maxSessions = Number(sessionConfig.codingSessionMaxSessions ?? 2);
      let sessionsStarted = 0;
      // Runtime-owned: set when a fork ended without submission after attempting capabilities
      // outside the coding-session contract. Independent of model-declared required_capability.
      let lastIncapableCodingSession = null;
      pi.registerTool({
        name: codingSessionTool,
        label: 'Begin coding session',
        description: `Call once exploration is done and you know what to implement, in particular when the code will not fit your normal ${sessionConfig.actionResponseMaxTokens}-token response. The runtime continues THIS session (same conversation, evidence and decisions) as a coding session with a ${sessionConfig.codingSessionMaxTokens}-token response ceiling under the same runtime rules. Inside the fork, use only the tool surface exposed there. Call it as soon as you are ready; do NOT draft the code here first. Small changes can stay direct.`,
        parameters: Type.Object({
          reason: Type.Optional(Type.String({ maxLength: 300, description: 'Optional one-line note for logs' })),
          required_capability: Type.Optional(Type.String({
            maxLength: 100,
            description: 'Set only when the purpose of the fork is to obtain one named capability hidden in the parent. Runtime rejects the launch if the coding session can never expose it.',
          })),
        }),
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
          const sessionId = randomUUID();
          const base = { sessionId, session: sessionsStarted + 1, side: 'parent' };
          codingSessionLog('requested', {
            ...base,
            parentRunId: ctx.sessionManager?.getSessionId?.() ?? null,
            parentMaxTokens: Number(ctx.model?.maxTokens) || null,
            codingMaxTokens: sessionConfig.codingSessionMaxTokens,
            preparationState: controller.preparationState,
            reason: params?.reason ?? null,
          });
          const refuse = (reason, message, details = {}) => {
            codingSessionLog('rejected', { ...base, reason, ...details });
            const error = new Error(message);
            error.code = reason;
            throw error;
          };
          if (sessionsStarted >= maxSessions) {
            refuse('max_sessions', `The coding session limit (${maxSessions}) for this run is reached. Finish with direct edits or submit_result.`);
          }
          // The fork inherits the persisted parent transcript. Without one there is no
          // same-context session to run, and a fresh prompt is not an acceptable stand-in.
          const parentSessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
          if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
            refuse('fork_unavailable', 'This session is not persisted, so it cannot continue as a coding session. Implement with direct edits.');
          }
          const agentReady = ensureCodingSessionAgent();
          if (!agentReady.ok) {
            refuse('agent_unavailable', `The trusted coding-session agent is not registered (${agentReady.error}). Implement with direct edits.`);
          }

          const requiredCapability = String(params?.required_capability ?? '').trim();
          if (requiredCapability && !agentReady.tools.includes(requiredCapability)) {
            refuse(
              'required_capability_unavailable',
              `The coding session cannot expose required capability "${requiredCapability}", so it was not launched. ${capabilitySnapshotGuidance(agentReady.tools)} Use a currently exposed trusted recovery/action instead.`,
            );
          }
          const equivalentIncapable = equivalentIncapableCodingSession(lastIncapableCodingSession, {
            contractTools: agentReady.tools,
            recoveryEpoch: trustedRecoveryEpoch,
          });
          if (equivalentIncapable) {
            refuse(
              'repeated_incapable_session',
              `The previous coding session ended without a result after attempting ${equivalentIncapable.unreachable.join(', ')}, which the coding session can never expose, and no trusted recovery has succeeded since. An equivalent session was not launched. ${capabilitySnapshotGuidance(pi.getActiveTools())} Use a currently exposed trusted recovery/action instead.`,
              { unreachable: equivalentIncapable.unreachable, contractTools: equivalentIncapable.contractTools },
            );
          }
          sessionsStarted += 1;
          // Durable in the parent process: if the fork returns without terminal submission,
          // parent-side run_check/mutations/submit_result remain under the same behavioral
          // validation contract.
          process.env[CODING_SESSION_USED_ENV] = 'true';
          const terminalFile = process.env.PI_TERMINAL_RESULT_FILE || null;
          const contractFile = `${process.env.PI_RUNTIME_FAILURE_FILE || terminalFile || parentSessionFile}.${sessionId}.contract.json`;
          const capabilityFile = `${contractFile}.capabilities.json`;
          const inheritedMutationJournalFile = String(process.env.PI_MUTATION_JOURNAL_FILE ?? '').trim();
          const fallbackMutationJournalFile = inheritedMutationJournalFile
            ? null
            : `${contractFile}.mutation-journal.json`;
          const codingMutationJournalFile = inheritedMutationJournalFile || fallbackMutationJournalFile;
          if (fallbackMutationJournalFile) {
            writeMutationJournalFile(
              ctx.cwd,
              fallbackMutationJournalFile,
              mutationJournalState(ctx.cwd, process.env),
            );
          }
          const startedAt = Date.now();
          codingSessionLog('started', { ...base, context: 'fork', agent: sessionConfig.codingSessionAgent, codingMaxTokens: sessionConfig.codingSessionMaxTokens });
          let response = null;
          let sessionError = null;
          try {
            response = await runStructuredSubagent(pi, ctx, {
              agent: sessionConfig.codingSessionAgent,
              nodeId: `coding-session-${toolCallId}`,
              task: 'Coding phase: continue this Implementer session and finish the issue. Implement the code and tests where needed using only tools exposed on each fork request. Inherited parent tool names are historical context, not current capability authority. Verify when verification is exposed, fix failures, and finish through the exposed terminal action. Write code directly in tool arguments.',
              timeoutMs: Number(sessionConfig.codingSessionTimeoutMs ?? 5400000),
              maxTokens: sessionConfig.codingSessionMaxTokens,
              // No tool budget: the runtime inside the fork applies the normal progress/loop rules.
              toolBudget: null,
              thinking: 'off',
              context: 'fork',
              childEnv: {
                PI_CODING_SESSION: JSON.stringify({ sessionId, maxTokens: sessionConfig.codingSessionMaxTokens, failureFile: contractFile, capabilityFile }),
                PI_ACCEPTED_MUTATION_SCOPE_STATE: JSON.stringify(mutationScopeReceipt(ctx.cwd, process.env)),
                ...(process.env.PI_ACCEPTED_MUTATION_SCOPE_FILE
                  ? { PI_ACCEPTED_MUTATION_SCOPE_FILE: process.env.PI_ACCEPTED_MUTATION_SCOPE_FILE }
                  : {}),
                PI_MUTATION_JOURNAL_FILE: codingMutationJournalFile,
              },
            }, signal);
          } catch (error) {
            sessionError = error;
          } finally {
            if (fallbackMutationJournalFile) {
              try {
                if (!fs.existsSync(fallbackMutationJournalFile)) {
                  throw new Error('coding-session fallback mutation journal disappeared');
                }
                // Reload child journal mutations into the parent process cache before deleting
                // the transport sidecar. Subsequent parent tools then see the fork's chronology.
                mutationJournalState(ctx.cwd, {
                  ...process.env,
                  PI_MUTATION_JOURNAL_FILE: fallbackMutationJournalFile,
                });
              } catch (error) {
                if (!sessionError) sessionError = error;
                else {
                  console.warn(`PI_CODING_MUTATION_JOURNAL_REFRESH_FAILED ${JSON.stringify({
                    sessionId,
                    error: String(error?.message ?? error),
                  })}`);
                }
              } finally {
                fs.rmSync(fallbackMutationJournalFile, { force: true });
              }
            }
          }
          let contractFailure = null;
          try {
            if (fs.existsSync(contractFile)) contractFailure = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
          } catch (error) {
            // Advisory provenance must not replace the original delegation error.
            contractFailure = null;
            console.warn(`PI_CODING_CONTRACT_METADATA_INVALID ${JSON.stringify({ sessionId, error: String(error?.message ?? error) })}`);
          } finally {
            fs.rmSync(contractFile, { force: true });
          }
          // Read before any early exit so the sidecar never outlives this tool call.
          let attemptedTools = [];
          try {
            attemptedTools = consumeUnavailableCapabilityAttempts(capabilityFile);
          } catch (error) {
            console.warn(`PI_CODING_CAPABILITY_RECORD_INVALID ${JSON.stringify({ sessionId, error: String(error?.message ?? error) })}`);
          }
          if (contractFailure?.failure_code === 'PI_TOOL_CONTRACT_FAILURE') {
            // This exit still owns whatever usage the child accrued; account it before aborting.
            recordDescendantMetric({
              call: 'coding', scope: 'session', childSession: sessionId, parentSession: ctx.sessionManager.getSessionId(),
              status: 'contract_failure', usage: response?.usage ?? sessionError?.delegationUsage ?? null,
            });
            await abortToolContract(contractFailure.tool, ctx, contractFailure.reason);
            throw new Error(`PI_TOOL_CONTRACT_FAILURE: ${contractFailure.reason}`);
          }
          if (signal?.aborted) {
            recordDescendantMetric({
              call: 'coding', scope: 'session', childSession: sessionId, parentSession: ctx.sessionManager.getSessionId(),
              status: 'cancelled', usage: response?.usage ?? sessionError?.delegationUsage ?? null,
            });
            codingSessionLog('cancelled', { ...base, durationMs: Date.now() - startedAt });
            throw sessionError ?? new Error('coding session was cancelled');
          }
          let receiptResult = null;
          let receiptError = null;
          const markerPresent = Boolean(terminalFile && fs.existsSync(terminalFile) && fs.statSync(terminalFile).size > 0);
          if (markerPresent) {
            try {
              receiptResult = assertSuccessfulTerminalReceipt({
                cwd: ctx.cwd,
                resultFile: process.env.PI_IMPLEMENTER_RESULT_FILE,
                env: process.env,
                expectedSessionId: sessionId,
              });
            } catch (error) {
              receiptError = error;
            }
          }
          if (receiptError) invalidateTerminalReceipt(process.env);
          const outcome = normalizeCodingSessionOutcome({
            submitted: Boolean(receiptResult),
            sessionError,
            receiptError,
          });
          const submitted = outcome.successful_final_submission;
          const incapable = incapableCodingSessionRecord({
            submitted,
            attemptedTools,
            contractTools: agentReady.tools,
            recoveryEpoch: trustedRecoveryEpoch,
          });
          if (!submitted) lastIncapableCodingSession = incapable;
          const delegationUsage = response?.usage ?? sessionError?.delegationUsage ?? null;
          recordDescendantMetric({
            call: 'coding', scope: 'session', childSession: sessionId, parentSession: ctx.sessionManager.getSessionId(),
            status: sessionError?.delegationStatus ?? (submitted ? 'completed' : sessionError ? 'error' : 'ended_without_submit'),
            usage: delegationUsage,
          });
          codingSessionLog(submitted ? 'completed' : 'ended_without_submit', {
            ...base,
            durationMs: Date.now() - startedAt,
            usage: delegationUsage,
            ...outcome,
            ...(incapable ? { unreachableCapabilities: incapable.unreachable } : {}),
          });
          if (submitted) {
            return {
              content: [{ type: 'text', text: 'Coding session completed the implementation and submitted the result. The work is done: stop now.' }],
              details: {
                ...base,
                submitted: true,
                successful_final_submission: true,
                recovered_errors: outcome.recovered_errors,
                unresolved_terminal_error: outcome.unresolved_terminal_error,
              },
              // The fork already called submit_result; end this session without another turn.
              terminate: true,
            };
          }
          const remaining = maxSessions - sessionsStarted;
          const activeToolNames = pi.getActiveTools();
          const terminalStatus = activeToolNames.includes('submit_result')
            ? 'Coding session ended without submit_result'
            : 'Coding session ended without a terminal result';
          const continuation =
            remaining > 0 && codingSessionTool && activeToolNames.includes(codingSessionTool)
              ? `You may call ${codingSessionTool} once more (${remaining} left). `
              : '';
          const terminalDiagnostic = sessionError ?? receiptError;
          const message = `${terminalStatus}${terminalDiagnostic ? ` (${String(terminalDiagnostic?.message ?? terminalDiagnostic)})` : ''}. Its repository changes, if any, are in the worktree. ${continuation}${activeToolGuidance(activeToolNames)} ${taskSpecificToolGuidance(activeToolNames)}`.trim();
          // A real session/delegation error is still terminal for this tool call.
          // A stale/invalid receipt is recoverable: return control so the parent
          // can submit the current tree again instead of converting consistency
          // drift into an execution failure.
          if (sessionError) throw new Error(message);
          return {
            content: [{ type: 'text', text: message }],
            details: { ...base, ...outcome, submitted: false },
          };
        },
      });
    }

    if (process.env.PI_ZOEKT_URL) {
      pi.registerTool({
        name: 'indexed_repo_search',
        label: 'Indexed repository search',
        description: 'Fast read-only search against the configured Zoekt index of dev. Prefer it for literal/path discovery when the source symbol/path is not already known. For a known source-code symbol, use semantic LSP lookup first. Results may lag the current worktree, so use direct read/repo_search for exact post-mutation verification.',
        parameters: Type.Object({
          kind: Type.Optional(Type.Union([
            Type.Literal('content'),
            Type.Literal('path'),
            Type.Literal('symbol'),
          ])),
          query: Type.String({ minLength: 1, maxLength: 300 }),
          pathPrefix: Type.Optional(Type.String({ maxLength: 300 })),
          extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 12 })),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        }),
        async execute(_toolCallId, params) {
          const startedAt = performance.now();
          const result = await zoektSearch({
            endpoint: process.env.PI_ZOEKT_URL,
            repository: process.env.PI_ZOEKT_REPOSITORY || '',
            timeoutMs: Number(process.env.PI_ZOEKT_TIMEOUT_MS || 3000),
            ...params,
          });
          console.info(`indexed_repo_search backend=zoekt query=${JSON.stringify(params.query)} matches=${result.matches.length} durationMs=${Math.round(performance.now() - startedAt)}`);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        },
      });
    }

    pi.registerTool({
      name: 'repo_search',
      label: 'Repository search',
      description: 'Cheap deterministic literal search over tracked repository paths or content in the current worktree. Use before scout for mechanical discovery; no child model is launched.',
      parameters: Type.Object({
        kind: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('path')])),
        query: Type.String({ minLength: 1, maxLength: 300 }),
        pathPrefix: Type.Optional(Type.String({ maxLength: 300 })),
        extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 12 })),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = repoSearch(ctx.cwd, params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });

  }

  if (!controller.fixedMaxTokens) {
    pi.registerTool({
      name: 'set_response_budget',
      label: 'Set response budget',
      description: `Set the maximum output for the NEXT model response only: short (${controller.budgets.short}), normal (${controller.budgets.normal}), or deep (${controller.budgets.deep}). Use the smallest sufficient level; automatic budget escalation is driven by hitting the active ceiling.`,
      parameters: Type.Object({
        level: Type.Union([Type.Literal('short'), Type.Literal('normal'), Type.Literal('deep')]),
        reason: Type.String({ description: 'One short sentence explaining why the next response needs this budget' }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const maxTokens = controller.setBudget(params.level);
        await applyBudget(params.level, ctx);
        return {
          content: [{ type: 'text', text: `Response budget set to ${params.level.toUpperCase()} (${maxTokens} max output tokens) for the next response only.` }],
          details: { budget: params.level, maxTokens, reason: params.reason },
        };
      },
    });
  }

  pi.on('turn_start', (event) => {
    actionTurnAttemptedTool = false;
    unavailableCapabilityAttemptedThisTurn = false;
    unavailableCapabilityKindThisTurn = null;
    elevatedTurnAttemptedFinishTool = false;
    elevatedTurnAttemptedScopePrelude = false;
    elevatedTurnAttemptedEvidenceUnlock = false;
    loopGuardSteeredThisTurn = false;
    controller.onTurnStart(event.turnIndex);
    const productiveState = syncProductiveState();
    syncActionToolSurface(productiveState);
    console.log(`PI_BUDGET ${JSON.stringify({
      turn: event.turnIndex,
      stage,
      budget: controller.fixedMaxTokens ? 'fixed' : controller.turnLevel,
      maxTokens: appliedActionCap || controller.fixedMaxTokens || controller.budgets[controller.turnLevel],
      productiveState,
      actionCapApplied: appliedActionCap > 0,
      largeMutationBudget: controller.largeMutationBudgetState,
    })}`);
  });

  pi.on('tool_call', async (event, ctx) => {
    if (codingSession && !codingFirstToolLogged) {
      codingFirstToolLogged = true;
      codingSessionLog('first_tool_call', { side: 'fork', sessionId: codingSession.sessionId, tool: event.toolName, msSinceReady: codingReadyAt ? Date.now() - codingReadyAt : null });
    }
    const productiveState = controller.productiveProgressState();
    const activeToolNames = pi.getActiveTools();
    const largeMutationActiveAtCall = controller.largeMutationBudgetActive();
    const transitionKey = controller.transitions.keyFor(event.toolName, event.input);
    const alreadySatisfiedTransition = controller.transitions.has(transitionKey);

    // Provider forcing is transport-level: any emitted tool call proves tool_choice=required
    // was satisfied. Local policy may still reject that call as hidden/already-satisfied, but
    // forcing must not remain stuck across the next provider request.
    const satisfiedProviderForcing = requireToolOnNextProviderRequest;
    if (satisfiedProviderForcing) requireToolOnNextProviderRequest = false;
    // getActiveTools() and tool_call.event.toolName are both provider-facing names. Keep this
    // comparison before controllerToolName(): retry_last_failed_check is only canonicalized to
    // run_check for controller policy after visibility has been checked.
    // retry_last_failed_check is a runtime-owned recovery pseudo-tool. Even while hidden,
    // it must reach the recovery policy below so callers get the deterministic recovery-state
    // reason (corrupt ledger / no pending failure / not available in this action state) rather
    // than being misclassified as an ordinary unavailable-tool attempt.
    const recoveryPolicyTool = event.toolName === RETRY_FAILED_CHECK_TOOL;
    const enforceActiveSurface =
      lastSurfaceSignature !== null &&
      !alreadySatisfiedTransition &&
      !recoveryPolicyTool &&
      !activeToolNames.includes(event.toolName);
    if (enforceActiveSurface) {
      unavailableToolAttempts += 1;
      unavailableCapabilityAttemptedThisTurn = true;
      const presentAtRequestStart = providerCapabilitySnapshot?.executableTools?.includes(event.toolName) === true;
      unavailableCapabilityKindThisTurn = presentAtRequestStart
        ? 'stale_after_capability_transition'
        : 'not_exposed_in_provider_request';
      const unavailable = {
        block: true,
        reason: presentAtRequestStart
          ? `BLOCKED: capability lifecycle changed after provider request ${providerCapabilitySnapshot.request}: ${event.toolName} was executable at request start but an earlier tool/state transition in this response removed it. Do not retry the stale call. ${capabilitySnapshotGuidance(activeToolNames)}`
          : `BLOCKED: that tool is not currently exposed by the runtime. ${capabilitySnapshotGuidance(activeToolNames)}`,
      };
      console.warn(`${presentAtRequestStart ? 'PI_CAPABILITY_LIFECYCLE_MISMATCH' : 'PI_UNAVAILABLE_TOOL_ATTEMPT'} ${JSON.stringify({
        stage,
        count: unavailableToolAttempts,
        productiveState,
        attemptedTool: event.toolName,
        request: providerCapabilitySnapshot?.request ?? null,
        requestTools: providerCapabilitySnapshot?.executableTools ?? null,
        activeTools: activeToolNames,
      })}`);
      if (codingSession?.capabilityFile) {
        try {
          recordUnavailableCapabilityAttempt(codingSession.capabilityFile, event.toolName);
        } catch (error) {
          console.warn(`PI_CODING_CAPABILITY_RECORD_FAILED ${JSON.stringify({ sessionId: codingSession.sessionId, error: String(error?.message ?? error) })}`);
        }
      }
      if (satisfiedProviderForcing) {
        console.warn(`PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED ${JSON.stringify({
          stage,
          tool: event.toolName,
          alreadySatisfied: false,
          unavailable: true,
        })}`);
      }
      if (loopGuard) {
        const loopResult = loopGuard.observe({
          stage,
          tool: event.toolName,
          input: event.input ?? {},
          result: unavailable,
          blocked: true,
          productiveState,
          repositoryRoot: ctx.cwd,
        });
        await handleLoopResult(loopResult, ctx, {
          terminalInput: terminalInputForLoop(event.toolName, event.input),
        }).catch(error => {
          console.error('PI_LOOP_GUARD_HANDLER_ERROR ' + String(error?.message ?? error));
        });
      }
      return unavailable;
    }
    const recoveryState = failedCheckRecoveryState();
    const failedCheckRecovery = recoveryState.failure;
    const recoveryRetryReady = Boolean(
      productiveState === 'action_required' &&
      failedCheckRecovery &&
      !recoveryState.corrupted &&
      controller.verificationPermitted()
    );
    let recoveryBlocked = null;
    let canonicalInput = event.input ?? {};
    if (
      event.toolName === ACCEPT_MUTATION_SCOPE_TOOL &&
      controller.largeMutationBudgetActive() &&
      elevatedScopePreludeUsed
    ) {
      recoveryBlocked = {
        block: true,
        reason: 'BLOCKED: this elevated mutation budget already used its one accept_mutation_scope prelude. Execute the accepted mutation now; a second scope-only turn is not allowed for the same grant.',
      };
    } else if (event.toolName === RETRY_FAILED_CHECK_TOOL && recoveryState.corrupted) {
      recoveryBlocked = {
        block: true,
        reason: 'BLOCKED: retry_last_failed_check cannot execute because the validation ledger is corrupted and the exact authoritative failed scope cannot be reconstructed safely.',
      };
    } else if (event.toolName === RETRY_FAILED_CHECK_TOOL && !failedCheckRecovery) {
      recoveryBlocked = {
        block: true,
        reason: 'BLOCKED: retry_last_failed_check did not execute because there is no unresolved failed run_check scope.',
      };
    } else if (
      event.toolName === RETRY_FAILED_CHECK_TOOL &&
      !pi.getActiveTools().includes(RETRY_FAILED_CHECK_TOOL)
    ) {
      recoveryBlocked = {
        block: true,
        reason: 'BLOCKED: retry_last_failed_check is not available in the current action state. Continue with the visible tools; the exact retry is exposed only when recovery is actionable.',
      };
    } else if (recoveryRetryReady && event.toolName === 'run_check') {
      recoveryBlocked = {
        block: true,
        reason: `BLOCKED: run_check did not execute. The failed ${failedCheckRecovery.kind} scope ${JSON.stringify(failedCheckRecovery.scope)} has an exact retry ready now; call retry_last_failed_check so the same kind+scope consumes this verification permit.`,
      };
    }

    if (!recoveryBlocked && event.toolName === RETRY_FAILED_CHECK_TOOL && failedCheckRecovery) {
      canonicalInput = recoveryState.request;
    }

    const canonicalToolName = controllerToolName(event.toolName);
    if (
      !recoveryBlocked &&
      terminalRecoveryRequiredTool === canonicalToolName &&
      terminalRecoveryState?.plan &&
      !recoveryCallMatchesPlan(terminalRecoveryState.plan, canonicalToolName, canonicalInput)
    ) {
      recoveryBlocked = {
        block: true,
        reason: `BLOCKED: ${event.toolName} did not execute. Terminal recovery requires the selected deterministic repair arguments; this call does not match the pending recovery plan.`,
      };
    }
    const blocked = recoveryBlocked ?? controller.checkToolCall(canonicalToolName, canonicalInput);
    if (blocked?.alreadySatisfied) {
      blocked.reason = `ALREADY_SATISFIED: ${event.toolName} is single-shot and already completed; it did not execute. ${activeToolGuidance(activeToolNames)}`;
    }
    if (satisfiedProviderForcing) {
      console.warn(`PI_ACTION_REQUIRED_TOOL_CHOICE_SATISFIED ${JSON.stringify({
        stage,
        tool: event.toolName,
        alreadySatisfied: blocked?.alreadySatisfied === true,
        unavailable: false,
      })}`);
    }
    if (!blocked?.alreadySatisfied) {
      actionTurnAttemptedTool = true;
    }
    if (blocked) {
      if (blocked.alreadySatisfied) {
        console.warn(`PI_ALREADY_SATISFIED ${JSON.stringify({ stage, ...controller.lastAlreadySatisfied, suppressed: true, productive: false })}`);
      }
      if (loopGuard) {
        const loopResult = loopGuard.observe({
          stage,
          tool: canonicalToolName,
          input: canonicalInput,
          result: blocked,
          blocked: true,
          productiveState,
          repositoryRoot: ctx.cwd,
        });
        // A blocked tool has no tool_execution_end event, so classify it here.
        await handleLoopResult(loopResult, ctx, {
          terminalInput: terminalInputForLoop(canonicalToolName, canonicalInput),
        }).catch(error => {
          console.error('PI_LOOP_GUARD_HANDLER_ERROR ' + String(error?.message ?? error));
        });
      }
      if (terminalRecoveryRequiredTool === canonicalToolName) {
        // The selected recovery tool was emitted but rejected by local policy (for example,
        // wrong run_check arguments). Keep the exact recovery state armed for the next request.
        requireToolOnNextProviderRequest = true;
      }
      return blocked;
    }

    // Capture the controller notice now, but publish it only for this exact toolCallId after
    // execution. Any later runtime-side block simply drops this local value.
    const evidenceConsumptionNotice = controller.consumeEvidenceActionNotice();
    const restoreRuntimeBlockedEvidence = () => {
      if (evidenceConsumptionNotice) {
        controller.restoreRuntimeBlockedEvidenceAction(evidenceConsumptionNotice);
      }
      if (terminalRecoveryRequiredTool === canonicalToolName) {
        // The provider satisfied tool_choice, but the runtime refused execution after the
        // controller gate. Keep the selected recovery armed and force it again next request.
        requireToolOnNextProviderRequest = true;
      }
    };
    try {
    // Only a call the controller actually let through counts as an attempted finish tool: a
    // blocked call never reached execution, so it must not suppress the violation warning.
    if (FINISH_TOOLS.has(event.toolName)) elevatedTurnAttemptedFinishTool = true;
    if (largeMutationActiveAtCall && event.toolName === config.productiveProgress?.blockerTool) {
      elevatedTurnAttemptedEvidenceUnlock = true;
    }
    if (event.toolName === ACCEPT_MUTATION_SCOPE_TOOL) {
      elevatedTurnAttemptedScopePrelude = true;
      if (controller.largeMutationBudgetActive()) elevatedScopePreludeUsed = true;
    }

    const cwd = ctx?.cwd || process.cwd();
    let mutationAuthorization = null;

    // `write` always overwrites unconditionally, unlike `edit` (which already refuses a
    // same-content replacement before touching disk) and `safe_edit` (which compares bytes
    // itself). Prove byte equality here and skip the real tool entirely so an identical write
    // never bumps mtime or resets rollback/progress state. Reuses the same blocked-call path
    // as checkToolCall above, so repeated no-op writes still accumulate toward loop/stall
    // detection without counting as productive progress.
    if (stage === 'implementer' && event.toolName === 'write' && detectNoOpWrite(cwd, event.input)) {
      const noOpBlocked = {
        block: true,
        reason: `NO CHANGE: write content for ${event.input?.path} is already identical to the existing file; no write performed.`,
      };
      if (loopGuard) {
        const loopResult = loopGuard.observe({
          stage,
          tool: event.toolName,
          input: event.input ?? {},
          result: noOpBlocked,
          blocked: true,
          productiveState,
          repositoryRoot: ctx.cwd,
        });
        await handleLoopResult(loopResult, ctx, {
          terminalInput: terminalInputForLoop(event.toolName, event.input),
        }).catch(error => {
          console.error('PI_LOOP_GUARD_HANDLER_ERROR ' + String(error?.message ?? error));
        });
      }
      restoreRuntimeBlockedEvidence();
      return noOpBlocked;
    }

    // Trusted containment and accepted-scope authorization for every file mutation,
    // direct or inside the coding session. A new publishable path must be accepted
    // before its first mutation; an already-changed path cannot be laundered later.
    if (stage === 'implementer' && CONTENT_MUTATION_TOOLS.has(event.toolName)) {
      try {
        resolveMutationTarget(cwd, event.input?.path);
        mutationAuthorization = assertMutationPathAuthorized({
          cwd,
          requestedPath: event.input?.path,
          env: process.env,
        });
      } catch (error) {
        if (!(error instanceof MutationTargetRejected) && !String(error?.code ?? '').startsWith('scope_') && error?.code !== 'mutation_scope_required') {
          throw error;
        }
        const containmentBlocked = { block: true, reason: `BLOCKED: ${event.toolName} did not execute. ${error.message}` };
        console.warn(`PI_MUTATION_BLOCKED ${JSON.stringify({ stage, tool: event.toolName, reason: error.code, path: event.input?.path ?? null })}`);
        restoreRuntimeBlockedEvidence();
        return containmentBlocked;
      }
    }

    if (stage === 'implementer' && RECEIPT_INVALIDATING_TOOLS.has(event.toolName)) {
      invalidateTerminalReceipt(process.env);
    }
    if (stage === 'implementer' && event.toolName === 'bash') observeDriftSafely(cwd, 'before');

    const semanticMutation = loopGuard && isSemanticMutationTool(event.toolName);
    const repositoryStateBefore = semanticMutation
      ? repositoryStateFingerprint(cwd)
      : null;

    if (stage === 'implementer' && CONTENT_MUTATION_TOOLS.has(event.toolName)) {
      try {
        const snapshot = captureMutationSnapshot(cwd, event.input?.path);
        const capacity = mutationJournalCapacityStatus({ cwd, snapshot, env: process.env });
        pendingMutationSnapshots.set(event.toolCallId, {
          snapshot,
          disposition: mutationAuthorization?.disposition ?? 'unknown',
          journalable: capacity.journalable,
          journalReason: capacity.reason,
        });
        if (!capacity.journalable) {
          // Selective undo is a recovery convenience, never a prerequisite for productive work.
          // Once the bounded journal is full (or one prior snapshot is too large), continue the
          // mutation and retain only the process-local last-mutation snapshot for fast rollback.
          console.warn('PI_MUTATION_JOURNAL_DEGRADED ' + JSON.stringify({
            tool: event.toolName,
            path: snapshot.path,
            code: capacity.code,
            reason: capacity.reason,
          }));
        }
      } catch (error) {
        const reason = String(error?.message ?? error);
        console.warn('PI_MUTATION_JOURNAL_BLOCKED ' + JSON.stringify({
          tool: event.toolName,
          reason,
        }));
        restoreRuntimeBlockedEvidence();
        return {
          block: true,
          reason: `BLOCKED: ${event.toolName} did not execute because mutation provenance is corrupt or unavailable for a non-capacity reason. ${reason}`,
        };
      }
    }
    if (stage === 'implementer' && canonicalToolName === 'bash') {
      pendingBashValidationFingerprints.set(event.toolCallId, repositoryStateFingerprint(cwd));
    }

    // Finish all setup that can still reject/throw before committing terminal recovery.
    // In particular, structuredClone can fail on malformed synthetic/runtime inputs; such a
    // failure must leave the exact validation permit and forced recovery directive intact.
    const clonedCanonicalInput = structuredClone(canonicalInput);

    if (terminalRecoveryRequiredTool === canonicalToolName) {
      const plan = terminalRecoveryState?.plan ?? null;
      if (plan?.kind === 'exact_validation' && !controller.commitRecoveryVerification(canonicalInput)) {
        restoreRuntimeBlockedEvidence();
        return {
          block: true,
          reason: 'BLOCKED: exact terminal recovery verification was authorized but its one-shot permit could not be committed at the execution boundary.',
        };
      }
      console.log('PI_TERMINAL_RECOVERY_TOOL_ATTEMPT ' + JSON.stringify({
        stage,
        obligationKey: terminalRecoveryState?.obligationKey ?? null,
        tool: event.toolName,
      }));
      terminalRecoveryAttemptToolCallId = event.toolCallId ?? null;
      terminalRecoveryRequiredTool = null;
      controller.clearRecoveryVerification();
      // Consume recovery only at the actual execution boundary, after controller policy,
      // argument matching, containment, no-op, provenance and clone setup have all succeeded.
      terminalRecoveryState = null;
    }

    pendingToolInputs.set(event.toolCallId, clonedCanonicalInput);
    if (evidenceConsumptionNotice) {
      pendingEvidenceConsumptionNotices.set(event.toolCallId, evidenceConsumptionNotice);
    }
    if (loopGuard) {
      pendingLoopCalls.set(event.toolCallId, {
        cwd,
        toolName: canonicalToolName,
        input: clonedCanonicalInput,
        productiveState,
        repositoryStateBefore,
      });
    }
    return undefined;
    } catch (error) {
      // The controller has already converted the one-action evidence window back to
      // action_required by this point. If trusted runtime setup throws before execution,
      // restore that same permit so a harness failure cannot silently consume it.
      restoreRuntimeBlockedEvidence();
      throw error;
    }
  });
  pi.on('tool_execution_end', async (event, ctx) => {
    const consumedEvidence = pendingEvidenceConsumptionNotices.get(event.toolCallId) ?? null;
    pendingEvidenceConsumptionNotices.delete(event.toolCallId);
    const bashValidationFingerprintBefore = pendingBashValidationFingerprints.get(event.toolCallId) ?? null;
    pendingBashValidationFingerprints.delete(event.toolCallId);
    if (event.isError && /^Tool .+ not found$/m.test(resultText(event.result ?? event).trim())) {
      if (consumedEvidence) controller.restoreRuntimeBlockedEvidenceAction(consumedEvidence);
      await handleMissingExecutor(event, ctx);
      return;
    }
    if (!event.isError && TRUSTED_RECOVERY_TOOLS.has(event.toolName)) trustedRecoveryEpoch += 1;
    if (stage === 'implementer' && event.toolName === 'bash') observeDriftSafely(ctx.cwd, 'after');
    // pi rejects a call whose arguments were cut off at the output ceiling before execution and
    // may not route that rejection through tool_result; steer from here so the truncation
    // guidance (begin the coding session instead of regenerating) still reaches the model once.
    const truncatedText = resultText(event.result);
    const truncated = classifyTruncatedToolCall({ toolName: event.toolName, isError: event.isError, text: truncatedText });
    if (truncated && !truncationGuidedCalls.has(event.toolCallId)) {
      truncationGuidedCalls.add(event.toolCallId);
      console.log(`PI_TOOL_CALL_TRUNCATED ${JSON.stringify({ stage, ...truncated, source: 'tool_execution_end' })}`);
      await pi.sendUserMessage(`RUNTIME: ${truncationGuidance(event.toolName)}`, { deliverAs: 'steer' });
    }
    const pendingLoopCall = pendingLoopCalls.get(event.toolCallId) ?? null;
    const contentMutation =
      stage === 'implementer' &&
      CONTENT_MUTATION_TOOLS.has(event.toolName);
    const pendingMutation = contentMutation
      ? (pendingMutationSnapshots.get(event.toolCallId) ?? null)
      : null;
    const mutationSnapshot = pendingMutation?.snapshot ?? null;

    let mutationChanged = null;
    let mutationAfterSnapshot = null;
    if (contentMutation && pendingLoopCall && mutationSnapshot) {
      try {
        mutationAfterSnapshot = captureMutationSnapshot(
          pendingLoopCall.cwd,
          mutationSnapshot.path,
        );
        mutationChanged = mutationSnapshotChanged(mutationSnapshot, mutationAfterSnapshot);
      } catch (error) {
        console.warn('PI_MUTATION_SNAPSHOT_UNAVAILABLE ' + JSON.stringify({
          tool: event.toolName,
          reason: String(error?.message ?? error),
        }));
      }
    }

    let repositoryStateAfter = null;
    if (loopGuard && pendingLoopCall && isSemanticMutationTool(event.toolName)) {
      repositoryStateAfter = repositoryStateFingerprint(pendingLoopCall.cwd);
      // Compare fingerprints only when both are known. A failed fingerprint
      // (null) means "unknown", not "unchanged": keep mutationChanged null so
      // progress accounting is not downgraded to a no-op.
      if (
        mutationChanged == null &&
        pendingLoopCall.repositoryStateBefore &&
        repositoryStateAfter
      ) {
        mutationChanged = pendingLoopCall.repositoryStateBefore !== repositoryStateAfter;
      }
    }

    if (contentMutation) {
      console.log(`PI_MUTATION ${JSON.stringify({
        stage,
        tool: event.toolName,
        mode: codingSession ? 'coding_session' : 'direct',
        path: mutationSnapshot?.path ?? null,
        isError: event.isError === true,
        changed: mutationChanged,
      })}`);
      if (!event.isError && mutationChanged !== false) {
        if (invalidateCodingBehavioralValidation(process.env)) {
          console.info(`PI_CODING_TARGETED_PYTEST ${JSON.stringify({
            stage,
            status: mutationChanged === true ? 'invalidated_by_mutation' : 'invalidated_by_unknown_mutation',
            path: mutationSnapshot?.path ?? null,
          })}`);
        }
      }
      if (!event.isError && mutationChanged === true && mutationSnapshot && mutationAfterSnapshot) {
        const mutationCwd = pendingLoopCall?.cwd ?? ctx?.cwd ?? process.cwd();

        const restorePreMutationSnapshot = () => {
          if (mutationSnapshot.existed) {
            fs.mkdirSync(path.dirname(mutationSnapshot.absolutePath), { recursive: true });
            fs.writeFileSync(mutationSnapshot.absolutePath, mutationSnapshot.content);
            if (mutationSnapshot.mode != null) fs.chmodSync(mutationSnapshot.absolutePath, mutationSnapshot.mode);
          } else {
            fs.rmSync(mutationSnapshot.absolutePath, { recursive: false, force: true });
          }
        };

        const revertForProvenanceFailure = async error => {
          restorePreMutationSnapshot();
          mutationChanged = false;
          repositoryStateAfter = repositoryStateFingerprint(mutationCwd);
          const reason = String(error?.message ?? error);
          console.error(`PI_MUTATION_JOURNAL_REVERTED ${JSON.stringify({
            stage,
            tool: event.toolName,
            path: mutationSnapshot.path,
            reason,
          })}`);
          await pi.sendUserMessage(
            `RUNTIME: your ${event.toolName} change to ${mutationSnapshot.path} was reverted because the trusted runtime could not persist mutation provenance for a non-capacity reason. Do not assume that edit is present. Retry only after addressing this runtime error: ${reason}`,
          );
        };

        const degradeToLocalSnapshot = reason => {
          // The prior bytes remain process-local, but a tiny shared marker makes chronology
          // durable across parent/fork processes. Other sessions must refuse rollback_last_mutation
          // rather than falling through to an older journal entry.
          const marker = markMutationJournalLocalOnly({
            cwd: mutationCwd,
            after: mutationAfterSnapshot,
            tool: event.toolName,
            env: process.env,
          });
          lastSuccessfulMutationSnapshot = mutationSnapshot;
          lastSuccessfulMutationLocalOnlyMarkerId = marker.id;
          console.warn(`PI_MUTATION_JOURNAL_LOCAL_FALLBACK ${JSON.stringify({
            stage,
            tool: event.toolName,
            path: mutationSnapshot.path,
            markerId: marker.id,
            reason,
          })}`);
        };

        if (pendingMutation?.journalable === false) {
          try {
            degradeToLocalSnapshot(pendingMutation.journalReason ?? 'bounded journal capacity unavailable');
          } catch (error) {
            await revertForProvenanceFailure(error);
          }
        } else {
          try {
            const journalEntry = recordSuccessfulMutation({
              cwd: mutationCwd,
              before: mutationSnapshot,
              after: mutationAfterSnapshot,
              tool: event.toolName,
              disposition: pendingMutation?.disposition ?? 'unknown',
              env: process.env,
            });
            // Persistent journal state is authoritative for normal mutations; keep no stale
            // process-local mutation identity that could outrank a later coding-session edit.
            lastSuccessfulMutationSnapshot = null;
            lastSuccessfulMutationLocalOnlyMarkerId = null;
            console.log(`PI_MUTATION_JOURNAL ${JSON.stringify({
              stage,
              mutationId: journalEntry.id,
              tool: event.toolName,
              path: journalEntry.path,
              disposition: journalEntry.disposition,
            })}`);
          } catch (error) {
            if (isMutationJournalCapacityError(error)) {
              // A concurrent parent/fork mutation may consume the remaining capacity after the
              // preflight check. Capacity exhaustion still degrades instead of reverting work,
              // but the shared local-only marker must itself persist.
              try {
                degradeToLocalSnapshot(String(error?.message ?? error));
              } catch (markerError) {
                await revertForProvenanceFailure(markerError);
              }
            } else {
              await revertForProvenanceFailure(error);
            }
          }
        }
      }
      pendingMutationSnapshots.delete(event.toolCallId);
    }

    const effectiveProgress = !event.isError && (mutationChanged == null || mutationChanged);
    const canonicalToolName = controllerToolName(event.toolName);
    if (stage === 'implementer' && canonicalToolName === 'bash') {
      const bashValidationFingerprintAfter = repositoryStateFingerprint(ctx?.cwd ?? process.cwd());
      const bashRequiresValidation = repositoryFingerprintRequiresValidation(
        bashValidationFingerprintBefore,
        bashValidationFingerprintAfter,
      );
      if (bashRequiresValidation && invalidateCodingBehavioralValidation(process.env)) {
        const knownChange = Boolean(
          bashValidationFingerprintBefore &&
          bashValidationFingerprintAfter &&
          bashValidationFingerprintBefore !== bashValidationFingerprintAfter
        );
        console.info(`PI_CODING_TARGETED_PYTEST ${JSON.stringify({
          stage,
          status: knownChange ? 'invalidated_by_bash_change' : 'invalidated_by_bash_unknown',
        })}`);
      }
    }
    if (!event.isError && ['rollback_last_mutation', 'recover_worktree', 'undo_mutation'].includes(canonicalToolName)) {
      if (invalidateCodingBehavioralValidation(process.env)) {
        console.info(`PI_CODING_TARGETED_PYTEST ${JSON.stringify({
          stage,
          status: 'invalidated_by_recovery_mutation',
          tool: canonicalToolName,
        })}`);
      }
    }
    const acceptedToolInput = pendingToolInputs.get(event.toolCallId) ?? null;
    const outstandingTerminalObligation = loopGuard?.terminalObligation ?? null;
    const terminalObligationHasExactMutationPaths =
      Array.isArray(outstandingTerminalObligation?.paths) &&
      outstandingTerminalObligation.paths.length > 0;
    const verificationEligible =
      effectiveProgress &&
      (
        !terminalObligationHasExactMutationPaths ||
        mutationResolvesSubmissionObligation(
          outstandingTerminalObligation,
          pendingLoopCall?.input ?? acceptedToolInput,
          event.result,
          ctx.cwd,
        )
      );
    controller.onToolExecutionEnd(canonicalToolName, event.isError, {
      madeProgress: effectiveProgress,
      input: acceptedToolInput,
      strictBlockerEvidence: consumedEvidence?.tool === canonicalToolName,
      verificationEligible,
    });
    const autoLargeMutationPending = controller.maybeGrantAutomaticLargeMutationBudget();
    if (autoLargeMutationPending) {
      console.log(`PI_LARGE_MUTATION_BUDGET ${JSON.stringify({
        stage,
        phase: 'auto_pending',
        source: 'implementation-planner',
      })}`);
    }
    const transitionRecord = controller.recordTransitionCompleted(canonicalToolName, pendingToolInputs.get(event.toolCallId) ?? {}, event.isError);
    pendingToolInputs.delete(event.toolCallId);
    const productiveState = syncProductiveState();
    syncActionToolSurface(productiveState);
    if (consumedEvidence) {
      const activeToolNames = pi.getActiveTools();
      console.info(`PI_EVIDENCE_PERMIT_CONSUMED ${JSON.stringify({
        stage,
        tool: consumedEvidence.tool,
        productiveState,
        activeTools: activeToolNames,
      })}`);
      await pi.sendUserMessage(
        `RUNTIME EVIDENCE PERMIT CONSUMED: the one evidence action (${consumedEvidence.tool}) is complete. read/search evidence and repeated need_more_evidence are unavailable until successful productive progress. ${activeToolGuidance(activeToolNames)} ${taskSpecificToolGuidance(activeToolNames)}`.trim(),
        { deliverAs: 'steer' },
      );
    }
    if (transitionRecord) await announceTransition(transitionRecord, productiveState);

    if (loopGuard && pendingLoopCall) {
      const loopResult = loopGuard.observe({
        stage,
        tool: pendingLoopCall.toolName ?? controllerToolName(event.toolName),
        input: pendingLoopCall.input,
        result: event.result,
        isError: event.isError,
        productiveState: pendingLoopCall.productiveState,
        repositoryStateBefore: pendingLoopCall.repositoryStateBefore,
        repositoryStateAfter,
        mutationChanged,
        repositoryRoot: ctx.cwd,
      });
      pendingLoopCalls.delete(event.toolCallId);

      await handleLoopResult(loopResult, ctx, {
        terminalInput: terminalInputForLoop(pendingLoopCall.toolName, pendingLoopCall.input),
      });
      if (terminalRecoveryAttemptToolCallId === event.toolCallId) {
        console.log('PI_TERMINAL_RECOVERY_TOOL_SETTLED ' + JSON.stringify({
          stage,
          tool: pendingLoopCall.toolName,
          isError: event.isError === true,
        }));
        terminalRecoveryAttemptToolCallId = null;
      }
    }
  });

  pi.on('tool_result', async (event, ctx) => {
    if (event.isError && /^Tool .+ not found$/m.test(resultText(event.result ?? event).trim())) {
      const guidance = await handleMissingExecutor(event, ctx);
      return guidance ? { content: [{ type: 'text', text: guidance }], isError: true } : undefined;
    }
    const text = resultText(event);
    const truncated = classifyTruncatedToolCall({ toolName: event.toolName, isError: event.isError, text });
    if (!truncated) return undefined;
    if (event.toolCallId) {
      if (truncationGuidedCalls.has(event.toolCallId)) return undefined;
      truncationGuidedCalls.add(event.toolCallId);
    }
    console.log(`PI_TOOL_CALL_TRUNCATED ${JSON.stringify({ stage, ...truncated, source: 'tool_result' })}`);
    const guidance = truncationGuidance(event.toolName);
    return {
      content: [{ type: 'text', text: `${guidance}\n\n${text}` }],
      isError: true,
    };
  });

  pi.on('turn_end', async (event, ctx) => {
    if (codingSession) {
      codingResponseNumber += 1;
      recordDescendantMetric({
        call: 'coding', childSession: codingSession.sessionId, response: codingResponseNumber,
        usage: event.message?.usage ?? null,
        responseMs: codingProviderRequestStartedAt == null ? 0 : Math.max(0, Date.now() - codingProviderRequestStartedAt),
        ...(event.message?.usage ? {} : { reason: 'provider_usage_unavailable' }),
      });
      codingProviderRequestStartedAt = null;
    }
    const status = providerErrorStatus(event.message);
    const forcedRequestErrored = event.message?.stopReason === 'error' && forcedProviderRequestInFlight;
    forcedProviderRequestInFlight = false;

    // Pi 0.79.4 surfaces provider 4xx failures as assistant error turns; its
    // after_provider_response hook is not emitted on this path. An error turn is transport
    // failure, not model prose, so it must not consume the prose/ceiling watchdogs.
    if (forcedRequestErrored && [400, 422].includes(status)) {
      requireToolOnNextProviderRequest = false;
      console.warn(`PI_ACTION_REQUIRED_TOOL_CHOICE_CLEARED ${JSON.stringify({
        stage,
        reason: 'provider_request_rejected',
        status,
        source: 'turn_end',
      })}`);
      // Rarely, Pi may also classify the 400/422 body text as retryable; in that case this
      // queued steer can be delivered in addition to Pi's own retry. The forcing flag is already
      // cleared, so the overlap is bounded and cannot create a forced-request loop.
      const activeToolNames = pi.getActiveTools();
      await pi.sendUserMessage(
        `RUNTIME: the provider rejected the provider-level required-tool request. Retry the pending action without provider-level forcing. ${activeToolGuidance(activeToolNames)} ${taskSpecificToolGuidance(activeToolNames)}`.trim(),
        { deliverAs: 'steer' },
      );
      // Pi continues because sendUserMessage() queues a steer consumed by its post-agent-run loop;
      // turn_end return values are not part of that continuation contract.
      return undefined;
    }
    if (event.message?.stopReason === 'error') {
      // Provider/transport error turns are not model attempts: do not consume prose/ceiling
      // watchdogs or one-shot mutation budget. Any active grant remains available if Pi retries.
      console.warn(`PI_PROVIDER_ERROR_TURN ${JSON.stringify({ stage, status, forced: forcedRequestErrored })}`);
      return undefined;
    }

    const outputTokens = Number(event.message?.usage?.output || 0);
    if (codingSession && !codingFirstResponseLogged) {
      codingFirstResponseLogged = true;
      codingSessionLog('first_response', { side: 'fork', sessionId: codingSession.sessionId, outputTokens, attemptedTool: actionTurnAttemptedTool });
    }
    const activeResponseCap =
      appliedActionCap || controller.fixedMaxTokens || controller.budgets[controller.turnLevel];
    const responseHitOutputCeiling =
      activeResponseCap > 0 && outputTokens >= activeResponseCap;
    const next = controller.afterTurn(outputTokens);
    const productiveState = syncProductiveState();
    syncActionToolSurface(productiveState);

    // Scope acceptance may be the necessary first call before a large new-file mutation.
    // Preserve the one-shot elevated budget across that declaration-only turn; consume it only
    // after a real mutation/rollback/terminal action, or collapse it on unrelated/no-action use.
    let preserveElevatedAfterScopePrelude = false;
    if (stage === 'implementer' && controller.largeMutationBudgetActive()) {
      const evidenceYield = elevatedTurnAttemptedEvidenceUnlock
        ? controller.yieldLargeMutationBudgetForEvidence()
        : { yielded: false, rearmed: false };
      if (evidenceYield.yielded) {
        console.log(`PI_LARGE_MUTATION_BUDGET ${JSON.stringify({
          stage,
          phase: 'yielded_for_evidence',
          ...evidenceYield,
          outputTokens,
        })}`);
        elevatedScopePreludeUsed = false;
        syncActionToolSurface(productiveState);
      } else if (elevatedTurnAttemptedFinishTool) {
        console.log(`PI_LARGE_MUTATION_BUDGET ${JSON.stringify({
          stage,
          phase: 'consumed',
          attemptedFinishTool: true,
          scopePrelude: elevatedTurnAttemptedScopePrelude,
          outputTokens,
        })}`);
        controller.resetLargeMutationBudget();
        elevatedScopePreludeUsed = false;
        syncActionToolSurface(productiveState);
      } else if (elevatedTurnAttemptedScopePrelude) {
        preserveElevatedAfterScopePrelude = true;
        console.log(`PI_LARGE_MUTATION_BUDGET ${JSON.stringify({
          stage,
          phase: 'scope_prelude',
          preserved: true,
          outputTokens,
        })}`);
      } else {
        console.log(`PI_LARGE_MUTATION_BUDGET ${JSON.stringify({
          stage,
          phase: 'consumed',
          attemptedFinishTool: false,
          scopePrelude: false,
          outputTokens,
        })}`);
        console.warn('PI_LARGE_MUTATION_BUDGET_VIOLATION: elevated mutation response attempted no accept_mutation_scope/structural_edit/safe_edit/edit/write/rollback_last_mutation/submit_result; collapsing to the normal budget');
        controller.resetLargeMutationBudget();
        elevatedScopePreludeUsed = false;
        syncActionToolSurface(productiveState);
      }
    }

    const preComplexityRequired =
      config.preComplexityActionResponseMaxTokens != null &&
      controller.preComplexityActionRequired();
    const postComplexityRequired =
      config.postComplexityActionResponseMaxTokens != null &&
      controller.complexityRecorded();
    const productiveActionRequired = productiveState === 'action_required';
    const runtimeActionRequired =
      preComplexityRequired || postComplexityRequired || productiveActionRequired;
    const actionCap = Number(
      preComplexityRequired
        ? (config.preComplexityActionResponseMaxTokens ?? 0)
        : postComplexityRequired
          ? (config.postComplexityActionResponseMaxTokens ?? 0)
          : (config.productiveProgress?.actionResponseMaxTokens ?? 0)
    );
    const actionRetryCap = Number(
      preComplexityRequired
        ? (config.preComplexityActionResponseRetryMaxTokens ?? actionCap)
        : postComplexityRequired
          ? (config.postComplexityActionResponseRetryMaxTokens ?? actionCap)
          : (config.productiveProgress?.actionResponseRetryMaxTokens ?? actionCap)
    );
    const effectiveAttemptedTool = actionTurnAttemptedTool || unavailableCapabilityAttemptedThisTurn;
    const unavailableCapabilityStrike =
      runtimeActionRequired &&
      unavailableCapabilityAttemptedThisTurn &&
      !controller.turnMadeProgress &&
      unavailableCapabilityKindThisTurn !== 'stale_after_capability_transition';
    if (unavailableCapabilityStrike) {
      consecutiveUnavailableCapabilityTurns += 1;
    } else {
      // "Consecutive" is literal: any non-strike turn resets the streak. A tool that was valid at
      // provider-request start but became stale after an earlier same-response transition is a
      // benign lifecycle race, not a model-error strike.
      consecutiveUnavailableCapabilityTurns = 0;
    }
    if (consecutiveUnavailableCapabilityTurns >= 2) {
      const reason = `second consecutive unavailable capability turn (${unavailableCapabilityKindThisTurn ?? 'unknown'}); aborting stage`;
      recordRuntimeAbort(
        'PI_UNAVAILABLE_CAPABILITY_ABORT',
        reason,
        {
          unavailableToolAttempts,
          consecutiveUnavailableCapabilityTurns,
          unavailableCapabilityKind: unavailableCapabilityKindThisTurn,
        },
      );
      console.error(`PI_UNAVAILABLE_CAPABILITY_ABORT: ${reason}`);
      ctx.abort();
      return;
    }

    actionRequiredProseOnlyTurns = nextActionRequiredProseOnlyTurns(
      actionRequiredProseOnlyTurns,
      {
        actionRequired: runtimeActionRequired,
        attemptedTool: effectiveAttemptedTool,
        madeProgress: controller.turnMadeProgress,
        responseHitOutputCeiling,
      },
    );

    if (actionRequiredProseOnlyTurns >= 2) {
      recordRuntimeAbort(
        'PI_ACTION_REQUIRED_ABORT',
        'second consecutive prose-only action-required turn; aborting stage',
        { actionRequiredProseOnlyTurns, ceilingWithoutToolTurns },
      );
      console.error('PI_ACTION_REQUIRED_ABORT: second consecutive prose-only action-required turn; aborting stage');
      ctx.abort();
      return;
    }

    // The first genuine prose-only violation in the productive Implementer state gets one
    // provider-level retry constraint. Output-ceiling turns are handled by their independent
    // watchdog and are intentionally not converted into prose strikes.
    if (
      stage === 'implementer' &&
      productiveActionRequired &&
      actionRequiredProseOnlyTurns === 1 &&
      !responseHitOutputCeiling &&
      !actionTurnAttemptedTool &&
      !controller.turnMadeProgress
    ) {
      requireToolOnNextProviderRequest = true;
      console.warn('PI_ACTION_REQUIRED_TOOL_CHOICE_ARMED: next provider request requires one exposed tool call');
    }

    ceilingWithoutToolTurns = nextCeilingWithoutToolTurns(ceilingWithoutToolTurns, {
      actionRequired: runtimeActionRequired,
      attemptedTool: effectiveAttemptedTool,
      madeProgress: controller.turnMadeProgress,
      responseHitOutputCeiling,
    });
    if (ceilingWithoutToolTurns >= MAX_CEILING_WITHOUT_TOOL_TURNS) {
      const reason = `${ceilingWithoutToolTurns} consecutive action-required responses hit the output ceiling without a tool call; aborting stage`;
      recordRuntimeAbort(
        'PI_ACTION_REQUIRED_ABORT',
        reason,
        { actionRequiredProseOnlyTurns, ceilingWithoutToolTurns },
      );
      console.error(`PI_ACTION_REQUIRED_ABORT: ${reason}`);
      ctx.abort();
      return;
    }

    let targetActionCap = actionCap > 0
      ? nextActionResponseCap({
          baseCap: actionCap,
          retryCap: actionRetryCap,
          actionRequired: runtimeActionRequired,
          attemptedTool: actionTurnAttemptedTool,
          madeProgress: controller.turnMadeProgress,
        })
      : 0;
    let budgetReason = targetActionCap > 0 ? 'action_required' : 'level_ladder';

    // A grant just succeeded this turn: override whatever the normal action cap would be and
    // apply the elevated ceiling to exactly the upcoming response.
    const largeMutationBudgetGrantedThisTurn =
      stage === 'implementer' && controller.largeMutationBudgetPending();
    if (preserveElevatedAfterScopePrelude) {
      targetActionCap = controller.largeMutationBudgetMaxTokens;
      budgetReason = 'large_mutation_scope_prelude';
    } else if (largeMutationBudgetGrantedThisTurn) {
      targetActionCap = controller.largeMutationBudgetMaxTokens;
      budgetReason = 'large_mutation_elevated';
      controller.activateLargeMutationBudget();
      elevatedScopePreludeUsed = false;
      console.log(`PI_LARGE_MUTATION_BUDGET ${JSON.stringify({ stage, phase: 'granted', maxTokens: targetActionCap })}`);
    }

    if (targetActionCap > 0) {
      if (appliedActionCap !== targetActionCap || Number(ctx.model?.maxTokens) !== targetActionCap) {
        await applyTokenCap(targetActionCap, ctx);
      }
      appliedActionCap = targetActionCap;
    } else if (appliedActionCap > 0) {
      await applyBudget(next.level, ctx);
      appliedActionCap = 0;
    } else if (next.changed) {
      await applyBudget(next.level, ctx);
    }

    if (runtimeActionRequired && !controller.turnMadeProgress && !loopGuardSteeredThisTurn) {
      const activeToolNames = pi.getActiveTools();
      const currentToolGuidance = activeToolGuidance(activeToolNames);
      const semantics = taskSpecificToolGuidance(activeToolNames, {
        ceilingHit: stage === 'implementer' && ceilingWithoutToolTurns > 0,
        preComplexityRequired,
        postComplexityRequired,
      });
      const directive = stage === 'implementer' && ceilingWithoutToolTurns > 0
        ? `RUNTIME: your last response used the entire ${actionCap || 'output'}-token ceiling without calling any tool. Do not draft, outline, or reason through file contents in this session; that output is discarded. In the next response call a tool immediately. ${currentToolGuidance} ${semantics}`
        : preComplexityRequired
        ? `RUNTIME CLASSIFICATION REQUIRED: startup evidence is complete. In the next response, do not narrate or reconsider the review plan. ${currentToolGuidance} ${semantics}`
        : postComplexityRequired
          ? `RUNTIME REVIEW ACTION REQUIRED: complexity is already declared. Do not continue prose-only deliberation. ${currentToolGuidance} ${semantics}`
          : stage === 'implementer'
            ? `RUNTIME ACTION REQUIRED: evidence is complete. In the next response, do not narrate or restate the plan. ${currentToolGuidance} ${semantics} Verification status: ${verificationLifecycleGuidance()}`
            : `RUNTIME ACTION REQUIRED: classification evidence is complete. In the next response, do not narrate classifications. ${currentToolGuidance} ${semantics}`;
      const reason = stage === 'implementer' && ceilingWithoutToolTurns > 0
        ? `ceiling without tool (${ceilingWithoutToolTurns}/${MAX_CEILING_WITHOUT_TOOL_TURNS})`
        : actionRequiredProseOnlyTurns > 0
          ? 'prose-only retry'
          : 'action-required transition';
      console.log(`PI_ACTION_REQUIRED_STEER: ${reason}; injecting user-level runtime directive`);
      await pi.sendUserMessage(directive, { deliverAs: 'steer' });
    }

    console.log(`PI_BUDGET_NEXT ${JSON.stringify({
      afterTurn: event.turnIndex,
      outputTokens,
      madeProgress: controller.turnMadeProgress,
      attemptedTool: effectiveAttemptedTool,
      unavailableCapabilityAttempted: unavailableCapabilityAttemptedThisTurn,
      responseHitOutputCeiling,
      nextBudget: next.level,
      maxTokens: appliedActionCap || next.maxTokens,
      budgetReason,
      largeMutationBudget: controller.largeMutationBudgetState,
      explicit: next.explicit === true,
      preservedForToolTurn: next.preservedForToolTurn === true,
      productiveState,
      preComplexityActionRequired: preComplexityRequired,
      postComplexityActionRequired: postComplexityRequired,
      actionCapApplied: appliedActionCap > 0,
      actionCapEscalated: appliedActionCap > actionCap,
    })}`);
  });
}
