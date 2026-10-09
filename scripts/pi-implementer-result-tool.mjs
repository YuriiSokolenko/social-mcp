import fs from 'node:fs';
import { Type } from 'typebox';

import { integrateLatestDev } from './pi-common/finalize-product-tree.mjs';
import { baseRef } from './pi-common/project-config.mjs';
import { runGit as git } from './pi-common/git.mjs';
import { assertNoScratchArtifacts, normalizeImplementerFiles, writeImplementerResult } from './pi-common/implementer-result.mjs';
import { registerTerminalTool } from './pi-common/terminal-tool.mjs';
import { assertAcceptedMutationScope, mutationScopeReceipt } from './pi-common/accepted-mutation-scope.mjs';
import { mutationCleanupHints } from './pi-common/mutation-journal.mjs';
import { capabilitySnapshotGuidance } from './pi-common/session-state.mjs';
import { readPreparedImplementation } from './pi-common/implementation-planner.mjs';
import {
  assertCodingBehavioralValidation,
  codingSessionSubmissionReadiness,
} from './pi-common/coding-session-validation.mjs';

const lines = (text) => text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const gitPaths = (text) => text.split('\0').filter(Boolean);
function changedPathsAgainstBase() {
  const tracked = gitPaths(git(['diff', '--no-renames', '--name-only', '-z', baseRef()]).out);
  const untracked = gitPaths(git(['ls-files', '--others', '--exclude-standard', '-z']).out);
  return [...new Set([...tracked, ...untracked])].sort();
}
const clean = (value) => typeof value === 'string' ? value.trim() : '';

// The candidate is always derived from Git, never from model-provided files.
// Scope remains independently predeclared; deriving paths must not authorize them.
function assertRuntimePublicationFiles(changedPaths, receipt) {
  const files = normalizeImplementerFiles(changedPaths);
  const accepted = new Set(receipt.accepted.map(entry => entry.path));
  const scratch = file => /(^|\/)(?:\.probe(?:\d+)?\.txt|\.pi-tmp-[^/]+)$/.test(file);
  const unpublishable = files.filter(file => !accepted.has(file) || scratch(file));
  try {
    assertNoScratchArtifacts(files);
    const scopedFiles = assertAcceptedMutationScope({
      cwd: process.cwd(), receipt, base: baseRef(),
    });
    if (JSON.stringify(normalizeImplementerFiles(scopedFiles)) !== JSON.stringify(files)) {
      throw new Error('Runtime publication file set differs from accepted-scope Git diff');
    }
  } catch (error) {
    const hints = mutationCleanupHints(process.cwd(), unpublishable, process.env);
    if (!hints.length) throw error;
    const expected = files.filter(file => accepted.has(file) && !scratch(file));
    const calls = hints.map(hint =>
      `undo_mutation({mutation_id:"${hint.mutation_id}",expected_files:${JSON.stringify(expected)},reason:"Remove accidental mutation from final candidate"})`
    );
    throw new Error(`${error.message} Targeted cleanup available: ${calls.join(' or ')}`);
  }
  return files;
}

function trustedRestoredNoDiffProof(changedBeforeIntegration) {
  if (changedBeforeIntegration.length) return true;
  // An attested saved patch already present in Git is evidence; a mode flag is not.
  const patch = process.env.PI_RESUME_PATCH;
  return Boolean(patch && fs.existsSync(patch) && fs.statSync(patch).size > 0 &&
    git(['apply', '--reverse', '--check', patch], { allowFailure: true }).status === 0);
}

// The only model-authored field for fresh changed work is opaque UTF-8 Markdown.
// File names, PR title, validation and security status always belong to the runtime.
export const RESULT_SUBMISSION_TOKENS = 4096;
export const RESULT_SUBMISSION_RETRY_TOKENS = 8192;
// Initial submission plus at most one correction and one truncation retry.
export const RESULT_SUBMISSION_MAX_REQUESTS = 3;

// Force a named tool only for recognized wire formats; unknown formats remain closed.
export function restrictResultSubmissionPayload(payload) {
  const closed = { ...payload, tools: [], tool_choice: 'none' };
  if (!Array.isArray(payload?.tools) || Object.hasOwn(payload, 'toolChoice')) return closed;
  const choice = payload.tool_choice;
  const knownChoice = choice == null || ['auto', 'none', 'required'].includes(choice) ||
    (typeof choice === 'object' && choice.type === 'function' &&
      (choice.function?.name === 'submit_result' || choice.name === 'submit_result'));
  if (!knownChoice) return closed;
  const matching = payload.tools.filter(tool => (tool.function?.name ?? tool.name) === 'submit_result');
  if (matching.length !== 1) return closed;
  const tool = matching[0];
  if (tool.type === 'function' && tool.function?.name === 'submit_result') {
    return { ...payload, tools: matching, tool_choice: { type: 'function', function: { name: 'submit_result' } } };
  }
  if (tool.type === 'function' && tool.name === 'submit_result') {
    return { ...payload, tools: matching, tool_choice: { type: 'function', name: 'submit_result' } };
  }
  // Legacy Pi adapters omit type. Auto remains safe with the terminal admission gate.
  if (tool.type == null && tool.function?.name === 'submit_result') {
    return { ...payload, tools: matching, tool_choice: 'auto' };
  }
  return closed;
}

export function resultProviderBudgetEvidence(payload, expected) {
  const fields = [
    ['max_output_tokens', payload?.max_output_tokens],
    ['max_completion_tokens', payload?.max_completion_tokens],
    ['max_tokens', payload?.max_tokens],
    ['maxTokens', payload?.maxTokens],
    ['generationConfig.maxOutputTokens', payload?.generationConfig?.maxOutputTokens],
    ['generation_config.max_output_tokens', payload?.generation_config?.max_output_tokens],
  ].filter(([, value]) => value !== undefined && value !== null);
  if (!fields.length) return { effective: null, verified: false, reason: 'budget_unverified' };
  const valid = fields.every(([, value]) => Number.isSafeInteger(value) && value > 0);
  const unique = new Set(fields.map(([, value]) => value));
  const effective = valid && unique.size === 1 ? fields[0][1] : null;
  return {
    effective, verified: effective === expected,
    reason: !valid ? 'invalid_budget' : unique.size !== 1 ? 'conflicting_budgets'
      : effective === expected ? 'verified' : 'budget_mismatch',
  };
}

function deterministicTitle(context) {
  const title = clean(context?.title).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');
  const issue = String(context?.number ?? process.env.PI_ISSUE ?? process.env.ISSUE ?? '').replace(/[^0-9]/g, '');
  const safe = title.replace(/^\[(?:P[0-9]|priority[^\]]*)\]\s*/i, '').slice(0, 110).trim();
  return (safe || (issue ? `Implement issue #${issue}` : 'Implement requested change')).slice(0, 120);
}

function runtimeChangedMetadata(resultText, files) {
  const context = issueContext();
  return {
    title: deterministicTitle(context),
    // Untrusted prose is for the PR description only; never parse it for metadata.
    summary: resultText,
    result_text: resultText,
    changes: files,
    security_notes: 'Security impact was not independently assessed by the model. CI and review remain authoritative.',
    limitations: 'Authoritative product checks run after submission; any unverified assertions in the model description are not validation evidence.',
  };
}

export function submitResultParameters() {
  // Keep the tool schema as a plain object for local-model/tool-call compatibility.
  // Outcome-specific required fields are enforced synchronously in execute before
  // integration or any publication-side effect.
  return Type.Object({
    resultText: Type.Optional(Type.String({
      minLength: 1,
      description: 'Fresh changed work only: complete Markdown/free-text implementation description on the dedicated submission request.',
    })),
    already_satisfied: Type.Optional(Type.Boolean({
      description: 'Fresh work only: explicit, evidence-proven already-satisfied outcome.',
    })),
    blocked_reason: Type.Optional(Type.String({
      maxLength: 1000,
      description: 'Fresh work only: concrete contradictory requirement, verified against the current repository.',
    })),
  }, { additionalProperties: false });
}

function restoredWork() {
  if (process.env.PI_RESUME_ACTIVE != null) return process.env.PI_RESUME_ACTIVE === 'true';
  const patch = process.env.PI_RESUME_PATCH;
  return Boolean(patch && fs.existsSync(patch) && fs.statSync(patch).size > 0);
}

function validationRepairWork() {
  return process.env.PI_VALIDATION_REPAIR === 'true';
}

function issueContext() {
  const file = process.env.PI_ISSUE_CONTEXT;
  if (!file || !fs.existsSync(file)) throw new Error('PI_ISSUE_CONTEXT is required for implementer submission');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertPreparedOutputsForChangedCodingSubmission({
  alreadySatisfied,
  blockedReason,
  runtimeOwnedMetadata,
} = {}) {
  if (
    runtimeOwnedMetadata ||
    alreadySatisfied ||
    blockedReason ||
    !String(process.env.PI_CODING_SESSION ?? '').trim()
  ) {
    return;
  }
  const prepared = readPreparedImplementation(process.env.PI_PREPARED_IMPLEMENTATION_FILE);
  const readiness = codingSessionSubmissionReadiness({
    prepared,
    cwd: process.cwd(),
    resumed: false,
    validationRepair: false,
  });
  if (readiness.ready) return;

  const error = new Error(JSON.stringify({
    code: 'PREPARED_OUTPUTS_REQUIRED',
    message: 'Fresh changed coding-session work cannot submit while required prepared outputs are missing. Create the outputs, or use already_satisfied / blocked_reason only when that terminal outcome is actually true.',
    missing_outputs: readiness.missing_outputs,
  }));
  error.code = 'PREPARED_OUTPUTS_REQUIRED';
  error.missingOutputs = readiness.missing_outputs;
  throw error;
}

const IMPLEMENTER_MUTATION_TOOLS = Object.freeze(['structural_edit', 'safe_edit', 'edit', 'write']);

export function implementerActionNudge(activeToolNames, { restored = false, validationRepair = false } = {}) {
  const names = [...new Set(Array.isArray(activeToolNames) ? activeToolNames : [])];
  const active = new Set(names);
  const parts = [
    'ACTION REQUIRED. The next response must call one currently exposed productive tool; do not answer with prose-only reasoning.',
  ];

  if (active.has('undo_mutation')) {
    parts.push('If submit_result reports a targeted cleanup mutation_id, call undo_mutation with that id and the intended final files, then retry submit_result.');
  }
  if (active.has('submit_result')) {
    if (active.has('begin_result_submission')) parts.push('For completed changed work call begin_result_submission() once; the next request exposes only submit_result({resultText}).');
    else if (!restored && !validationRepair) parts.push('Submission phase: call submit_result({resultText:"complete Markdown description"}) now; no other tools are available.');
    if (restored || validationRepair) {
      parts.push('For restored or harness validation-repair work call submit_result({}) now.');
    } else {
      parts.push('For fresh already-satisfied work call submit_result({already_satisfied:true}); for genuinely contradictory requirements call submit_result({blocked_reason:"..."}) from a clean worktree. For changed work use begin_result_submission() before the text-only submit_result.');
    }
  }
  const mutationTools = IMPLEMENTER_MUTATION_TOOLS.filter(name => active.has(name));
  if (mutationTools.length) {
    parts.push(`When a change is required, mutate now with one of the currently exposed mutation tools: ${mutationTools.join(', ')}.`);
  }
  if (active.has('need_more_evidence')) {
    parts.push('If exactly one concrete missing fact blocks safe action, call need_more_evidence once; after the single unlocked evidence action, act.');
  }
  parts.push(capabilitySnapshotGuidance(names));
  return parts.join(' ');
}

export default function (pi) {
  // Snapshot run mode once so the advertised contract and execute path cannot
  // diverge if process.env or the resume patch changes later in the process.
  const restored = restoredWork();
  const validationRepair = validationRepairWork();
  const runtimeOwnedMetadata = restored || validationRepair;

  const submission = { phase: 'coding', budget: null, retryUsed: false, correctionUsed: false, control: null,
    lastAssistant: null, providerEvidence: null, providerSurfaceVerified: false,
    providerRequest: 0, lastInputTokens: null,
    truncatedToolArguments: false, originalModel: null };

  const resetSubmissionAttempt = () => {
    submission.control = null;
    submission.lastAssistant = null;
    submission.providerEvidence = null;
    submission.providerSurfaceVerified = false;
    submission.truncatedToolArguments = false;
  };

  const restoreSubmissionBudget = async () => {
    if (!submission.originalModel) return;
    const original = submission.originalModel;
    submission.originalModel = null;
    try {
      if (!(await pi.setModel(original))) console.warn('PI_IMPLEMENTER_SUBMISSION_BUDGET_RESTORE_UNAVAILABLE');
    } catch (error) {
      console.warn(`PI_IMPLEMENTER_SUBMISSION_BUDGET_RESTORE_FAILED ${String(error?.message ?? error)}`);
    }
  };

  const submissionFailure = async (code, reason, ctx) => {
    submission.phase = 'failed';
    console.error(`PI_IMPLEMENTER_SUBMISSION_FAILED ${JSON.stringify({
      code, reason, budget: submission.budget, checkpoint: { worktree_preserved: true },
    })}`);
    await restoreSubmissionBudget();
    ctx?.abort?.();
  };
  const applySubmissionBudget = async (ctx, target) => {
    if (!ctx?.model || typeof pi.setModel !== 'function') return false;
    const contextWindow = Number(ctx.model.contextWindow);
    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      if (contextWindow < target + 1024) return false;
      if (target === RESULT_SUBMISSION_RETRY_TOKENS &&
          (!Number.isFinite(submission.lastInputTokens) ||
          submission.lastInputTokens + target + 1024 > contextWindow)) return false;
    }
    const before = { ...ctx.model };
    const changed = await pi.setModel({ ...ctx.model, maxTokens: target });
    if (!changed) return false;
    submission.originalModel ??= before;
    submission.budget = target;
    return true;
  };

  if (!runtimeOwnedMetadata) {
    pi.registerTool({
      name: 'begin_result_submission',
      label: 'Close Implementer coding',
      description: 'NONTERMINAL control action. End coding and research; the NEXT model request will have only submit_result({resultText}) and a dedicated output budget. Does not publish or verify.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return { content: [{ type: 'text', text: 'Coding closed. Next request: submit_result({resultText}) with complete Markdown; no other tools.' }] };
      },
    });
    pi.on('before_provider_request', event => {
      if (submission.phase !== 'submission_pending' && submission.phase !== 'failed') return undefined;
      const payload = event?.payload;
      if (!payload) return undefined;
      const tools = submission.phase === 'submission_pending'
        ? (payload.tools ?? []).filter(tool => (tool.function?.name ?? tool.name) === 'submit_result')
        : [];
      submission.providerEvidence = resultProviderBudgetEvidence(payload, submission.budget);
      submission.providerRequest += 1;
      console.log(`PI_IMPLEMENTER_SUBMISSION_REQUEST ${JSON.stringify({
        request: submission.providerRequest, phase: submission.phase,
        budget: submission.budget, actualBudget: submission.providerEvidence.effective,
        verified: submission.providerEvidence.verified, reason: submission.providerEvidence.reason,
        tools: tools.map(tool => tool.function?.name ?? tool.name),
      })}`);
      if (tools.length !== 1) return { ...payload, tools: [], tool_choice: 'none' };
      return { ...payload, tools, tool_choice: 'auto' };
    });
    pi.on('tool_call', event => {
      if (event.toolName === 'begin_result_submission') {
        if (submission.phase !== 'coding' || submission.control ||
            Object.keys(event.input ?? {}).length) {
          return { block: true, reason: 'begin_result_submission is single-use and takes no arguments.' };
        }
        submission.control = { kind: 'begin', id: event.toolCallId, executed: false };
      } else if (submission.phase === 'coding' && submission.control?.kind === 'begin') {
        return { block: true, reason: 'begin_result_submission must be the sole tool call in its completed provider response.' };
      } else if (submission.phase === 'submission_pending') {
        if (event.toolName !== 'submit_result') {
          return { block: true, reason: 'Implementer submission phase forbids repository evidence and mutations.' };
        }
        if (submission.control) return { block: true, reason: 'Only one submit_result tool call is allowed per submission request.' };
        const text = event.input?.resultText;
        submission.control = typeof text === 'string' && text.trim() && !event.input?.already_satisfied && !event.input?.blocked_reason
          ? { kind: 'submit', id: event.toolCallId, executed: false }
          : { kind: 'invalid', id: event.toolCallId, executed: false };
      } else if (submission.phase === 'failed' || submission.phase === 'submitted') {
        return { block: true, reason: 'Submission is closed; no further tools may execute.' };
      } else if (event.toolName === 'submit_result' && !event.input?.already_satisfied && !event.input?.blocked_reason) {
        return { block: true, reason: 'Changed work requires begin_result_submission() on an earlier completed tool turn.' };
      }
      return undefined;
    });
    pi.on('message_end', event => {
      const msg = event?.message;
      if (msg?.role !== 'assistant') return;
      const reason = String(msg.stopReason ?? msg.stop_reason ?? '').toLowerCase();
      const calls = Array.isArray(msg.content)
        ? msg.content.filter(part => part?.type === 'toolCall').map(part => ({ id: part.id, name: part.name }))
        : [];
      const input = Number(msg.usage?.inputTokens ?? msg.usage?.input_tokens ?? msg.usage?.input);
      if (Number.isFinite(input) && input >= 0) submission.lastInputTokens = input;
      submission.lastAssistant = { reason, calls };
    });
    pi.on('tool_execution_end', async event => {
      if (submission.control && event.toolCallId === submission.control.id) submission.control.executed = !event.isError;
      // Restore the pre-submission model budget once the terminal executor has
      // committed a result; terminal completion may skip the turn_end event.
      if (submission.phase === 'submission_pending' && !event.isError &&
          event.toolName === 'submit_result' && submission.control?.kind === 'submit' &&
          submission.control?.executed) await restoreSubmissionBudget();
    });
    pi.on('tool_result', event => {
      if (submission.phase === 'submission_pending' && event.toolName === 'submit_result' && event.isError &&
          /output token limit|arguments may be truncated|unterminated|unexpected end of json/i.test(
            (event.content ?? []).map(item => item.text ?? '').join(' '))) {
        submission.truncatedToolArguments = true;
      }
    });
    pi.on('turn_end', async (event, ctx) => {
      const last = submission.lastAssistant;
      const control = submission.control;
      const complete = last?.reason === 'tooluse' && last.calls.length === 1 &&
        last.calls[0].id === control?.id;
      if (submission.phase === 'coding') {
        if (control?.kind !== 'begin') return;
        submission.control = null;
        if (!control.executed || !complete) return;
        if (!(await applySubmissionBudget(ctx, RESULT_SUBMISSION_TOKENS))) {
          await submissionFailure('result_submission_budget_unavailable', '4096 token submission request unavailable', ctx);
          return;
        }
        submission.phase = 'submission_pending';
        pi.setActiveTools?.(['submit_result']);
        console.log(`PI_IMPLEMENTER_SUBMISSION_PHASE ${JSON.stringify({ phase: 'submission_pending', budget: submission.budget })}`);
        await pi.sendUserMessage?.('CODING CLOSED. On this NEW request call only submit_result({resultText}) with your complete Markdown description. No repository tools or structured metadata.', { deliverAs: 'steer' });
        return;
      }
      if (submission.phase !== 'submission_pending') return;
      if (control?.kind === 'submit' && control.executed) {
        submission.phase = 'submitted';
        console.log(`PI_IMPLEMENTER_SUBMISSION_ACCEPTED ${JSON.stringify({ budget: submission.budget, providerBudgetVerified: submission.providerEvidence?.verified })}`);
        return;
      }
      submission.control = null;
      if (!submission.providerEvidence?.verified) {
        await submissionFailure('result_submission_budget_unverified', 'Actual provider output budget does not match submission phase', ctx);
        return;
      }
      const truncated = last?.reason === 'length' || submission.truncatedToolArguments;
      submission.truncatedToolArguments = false;
      if (!truncated) {
        await submissionFailure('result_submission_incomplete', 'No complete and valid submit_result tool call', ctx);
        return;
      }
      if (submission.retryUsed) {
        await submissionFailure('result_submission_retry_exhausted', 'Submission-only retry was incomplete', ctx);
        return;
      }
      submission.retryUsed = true;
      if (!(await applySubmissionBudget(ctx, RESULT_SUBMISSION_RETRY_TOKENS))) {
        await submissionFailure('result_submission_context_exhausted', '8192 token retry unsupported or cannot fit', ctx);
        return;
      }
      pi.setActiveTools?.(['submit_result']);
      console.log(`PI_IMPLEMENTER_SUBMISSION_RETRY ${JSON.stringify({ budget: submission.budget, reason: last?.reason ?? 'truncated_arguments' })}`);
      await pi.sendUserMessage?.('SUBMISSION RETRY ONLY: previous tool arguments were truncated. Using existing work only, call submit_result({resultText}) with the FULL Markdown result. Do not inspect or mutate.', { deliverAs: 'steer' });
    });
  }

  registerTerminalTool(pi, {
    label: 'Sync and submit implementation candidate',
    description: 'TERMINAL ACTION. For fresh changed work, ONLY after begin_result_submission call submit_result({resultText}) with complete Markdown on the next provider request. Do not provide title, paths, arrays, security claims or validation claims as metadata. For authoritative already-satisfied work use {already_satisfied:true}; for proven contradictory requirements use {blocked_reason:"..."} from a clean worktree. Restored and validation-repair work use {} immediately. The runtime derives Git changes and PR metadata, integrates latest dev and independently validates after termination.',
    parameters: submitResultParameters(),
    customType: 'implementer-result',
    nudgeText: () => implementerActionNudge(pi.getActiveTools?.() ?? [], { restored, validationRepair }),
    nudgeRepeatWhile: () => process.env.PI_PRODUCTIVE_STATE === 'action_required',
    nudgeMaxCount: 3,
    successText: 'SUCCESS. Latest dev is integrated and the implementation candidate is recorded. The harness will run authoritative final checks. Stop now.',
    execute: async (params, { toolCallId } = {}) => {
      const alreadySatisfied = params.already_satisfied === true;
      if (!runtimeOwnedMetadata && !alreadySatisfied && !clean(params.blocked_reason)) {
        const last = submission.lastAssistant;
        const admitted = submission.phase === 'submission_pending' &&
          submission.providerEvidence?.verified === true &&
          submission.control?.kind === 'submit' && submission.control.id === toolCallId &&
          last?.reason === 'tooluse' && last.calls.length === 1 &&
          last.calls[0].name === 'submit_result' && last.calls[0].id === toolCallId &&
          clean(params.resultText);
        if (!admitted) {
          throw new Error(JSON.stringify({ code: 'result_submission_not_complete',
            phase: submission.phase, provider_budget_verified: submission.providerEvidence?.verified ?? false }));
        }
      }
      const blockedReason = clean(params.blocked_reason);
      if (runtimeOwnedMetadata && alreadySatisfied) {
        throw new Error('Restored or validation-repair work cannot use already_satisfied');
      }
      if (runtimeOwnedMetadata && blockedReason) {
        throw new Error('Restored or validation-repair work cannot use blocked_reason');
      }
      if (alreadySatisfied && blockedReason) {
        throw new Error('already_satisfied and blocked_reason are mutually exclusive');
      }

      if (blockedReason) {
        integrateLatestDev({
          conflictMessage: files => `Latest dev conflicts while verifying blocked work: ${files.join(', ')}`,
        });
        const changedPaths = changedPathsAgainstBase();
        const dirty = lines(git(['status', '--porcelain', '--untracked-files=all']).out);
        if (changedPaths.length || dirty.length) {
          throw new Error('blocked_reason requires a clean worktree with zero diff against latest dev');
        }

        const context = issueContext();
        const issue = process.env.PI_ISSUE || process.env.ISSUE || context.number || '';
        const data = writeImplementerResult(process.env.PI_IMPLEMENTER_RESULT_FILE, {
          title: clean(context.title),
          summary: `Implementation${issue ? ` for issue #${issue}` : ''} is blocked by a concrete contradiction in the requested requirements or constraints.`,
          changes: [],
          files: [],
          outcome: 'blocked',
          blocked_reason: blockedReason,
          security_notes: 'No repository change was made because the task is blocked pending human clarification.',
          limitations: 'Human clarification is required before implementation can continue safely.',
        });
        return { data, text: 'BLOCKED. Human clarification is required before implementation can continue. Stop now.' };
      }

      assertPreparedOutputsForChangedCodingSubmission({
        alreadySatisfied,
        blockedReason,
        runtimeOwnedMetadata,
      });

      const freshResultText = !runtimeOwnedMetadata && !alreadySatisfied ? params.resultText : null;
      let knownChangedBeforeIntegration = null;
      if (!alreadySatisfied) {
        knownChangedBeforeIntegration = changedPathsAgainstBase();
        assertCodingBehavioralValidation({
          changedFiles: knownChangedBeforeIntegration,
          env: process.env,
          cwd: process.cwd(),
        });
      }

      integrateLatestDev({
        conflictMessage: files => `Latest dev conflicts with the implementation. Resolve these files and retry submit_result: ${files.join(', ')}`,
      });
      const changedPaths = changedPathsAgainstBase();
      const hasDiff = changedPaths.length > 0;
      const acceptedScope = mutationScopeReceipt(process.cwd(), process.env);
      const publicationFiles = hasDiff
        ? assertRuntimePublicationFiles(changedPaths, acceptedScope)
        : [];
      if (runtimeOwnedMetadata && !hasDiff && !trustedRestoredNoDiffProof(knownChangedBeforeIntegration)) {
        throw new Error('Restored or validation-repair no-diff result lacks trusted replay proof; cannot infer already_satisfied from an empty diff');
      }
      let data;

      if (runtimeOwnedMetadata) {
        const context = issueContext();
        const issue = process.env.PI_ISSUE || process.env.ISSUE || context.number || '';
        const summaryPrefix = validationRepair ? 'Validation-repaired implementation' : 'Restored implementation';
        data = hasDiff
          ? {
              title: clean(context.title),
              summary: `${summaryPrefix}${issue ? ` for issue #${issue}` : ''} was prepared against latest dev.`,
              changes: publicationFiles,
              files: publicationFiles,
              already_satisfied: false,
              security_notes: 'No additional security notes were supplied for restored work.',
              limitations: 'No additional limitations were supplied for restored work.',
            }
          : {
              title: clean(context.title),
              summary: validationRepair
                ? `Latest dev already contains the validation-repaired implementation${issue ? ` for issue #${issue}` : ''}; no duplicate implementation is required.`
                : `Latest dev already contains the replayed saved implementation${issue ? ` for issue #${issue}` : ''}; no duplicate implementation is required.`,
              changes: [],
              files: [],
              already_satisfied: true,
              security_notes: 'No repository change was required because latest dev already contains the saved implementation.',
              limitations: 'No implementation PR is created for a stale restored branch that is already contained in latest dev.',
            };
      } else if (alreadySatisfied) {
        const context = issueContext();
        const issue = process.env.PI_ISSUE || process.env.ISSUE || context.number || '';
        data = {
          title: clean(context.title),
          summary: `Latest dev already contains the exact requested end state${issue ? ` for issue #${issue}` : ''}; no duplicate implementation is required.`,
          changes: [],
          files: [],
          already_satisfied: true,
          security_notes: 'No repository change was required.',
          limitations: 'No implementation PR is created for an already-satisfied issue.',
        };
      } else {
        data = {
          ...runtimeChangedMetadata(freshResultText, publicationFiles),
          files: publicationFiles,
          already_satisfied: false,
        };
      }

      if (!data.title || !data.summary) throw new Error('title and summary are required');
      if (data.already_satisfied && hasDiff) throw new Error('already_satisfied requires zero diff against latest dev');
      if (data.already_satisfied && data.changes.length) throw new Error('already_satisfied requires changes: []');
      if (data.already_satisfied && data.files.length) throw new Error('already_satisfied requires files: []');
      // Shared invariant for runtime-owned restored/validation-repair results too.
      if (!data.already_satisfied && !data.changes.length) throw new Error('at least one concrete change is required');
      if (!data.already_satisfied && !data.files.length) throw new Error('at least one changed file is required');
      data = writeImplementerResult(process.env.PI_IMPLEMENTER_RESULT_FILE, {
        ...data,
        scope_enforcement: 'predeclared',
        accepted_scope: acceptedScope,
      });
      return { data };
    },
  });
}
