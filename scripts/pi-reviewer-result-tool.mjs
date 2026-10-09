import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Type } from 'typebox';

import { registerSubmitNudge, terminalResult } from './pi-common/terminal-tool.mjs';
import {
  createReviewReceipt, reviewAcceptanceCriteria, validateTextReview,
} from './pi-review-result.mjs';

// A dedicated new request, not a 1024-token review-action response.
export const REVIEW_SUBMISSION_TOKENS = 4096;
export const REVIEW_SUBMISSION_RETRY_TOKENS = 8192;
export const REVIEW_SUBMISSION_MAX_REQUESTS = 3;
export const REVIEW_SUBMISSION_SCHEMA = Object.freeze({
  type: 'object',
  properties: { reviewText: { type: 'string', minLength: 1 } },
  required: ['reviewText'],
  additionalProperties: false,
});
const DESCRIPTION = 'Only Reviewer terminal tool. Write the complete issue-specific Markdown acceptance evidence or concrete blocking findings in reviewText. Verdict was bound by begin_review_submission.';

// Do not silently filter a leaked repository executor. Unsupported adapters,
// multiple tools, or unknown forcing formats fail closed rather than lying
// about the executable surface. Singleton + auto matches the proven Planner
// and Implementer compatibility path on the actual provider wire.
export function restrictReviewSubmissionPayload(payload) {
  const closed = { ...payload, tools: [], tool_choice: 'none' };
  if (!Array.isArray(payload?.tools) || payload.tools.length !== 1 ||
      Object.hasOwn(payload, 'toolChoice')) return closed;
  const choice = payload.tool_choice;
  const known = choice == null || ['auto', 'required', 'none'].includes(choice) ||
    (typeof choice === 'object' && choice.type === 'function' &&
      (choice.function?.name === 'submit_result' || choice.name === 'submit_result'));
  if (!known) return closed;
  const tool = payload.tools[0];
  if (tool?.type === 'function' && tool.function?.name === 'submit_result' && tool.name == null) {
    return { ...payload, tools: [{ ...tool, function: { ...tool.function,
      description: DESCRIPTION, parameters: REVIEW_SUBMISSION_SCHEMA } }], tool_choice: 'auto' };
  }
  if (tool?.type === 'function' && tool.name === 'submit_result' && tool.function == null) {
    return { ...payload, tools: [{ ...tool,
      description: DESCRIPTION, parameters: REVIEW_SUBMISSION_SCHEMA }], tool_choice: 'auto' };
  }
  if (tool?.type == null && tool?.function?.name === 'submit_result' && tool.name == null) {
    return { ...payload, tools: [{ ...tool, function: { ...tool.function,
      description: DESCRIPTION, parameters: REVIEW_SUBMISSION_SCHEMA } }], tool_choice: 'auto' };
  }
  return closed;
}

export function reviewerProviderBudgetEvidence(payload, expected) {
  const fields = [
    payload?.max_output_tokens, payload?.max_completion_tokens, payload?.max_tokens,
    payload?.maxTokens, payload?.generationConfig?.maxOutputTokens,
    payload?.generation_config?.max_output_tokens,
  ].filter(value => value !== undefined && value !== null);
  if (!fields.length) return { verified: false, effective: null, reason: 'budget_unverified' };
  const valid = fields.every(value => Number.isSafeInteger(value) && value > 0);
  const unique = new Set(fields);
  const effective = valid && unique.size === 1 ? fields[0] : null;
  return { verified: effective === expected, effective,
    reason: !valid ? 'invalid_budget' : unique.size !== 1 ? 'conflicting_budgets'
      : effective === expected ? 'verified' : 'budget_mismatch' };
}

function currentIdentity(ctx) {
  const env = process.env;
  const file = String(env.REVIEW_CONTEXT ?? '').trim();
  if (!file) throw new Error('review_context_missing');
  const context = JSON.parse(fs.readFileSync(file, 'utf8'));
  const identity = {
    pr: String(env.PR ?? ''), issue: String(env.ISSUE ?? ''),
    head: String(env.HEAD_SHA ?? ''), run: String(env.GITHUB_RUN_ID ?? ''),
    attempt: String(env.REVIEW_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT ?? ''),
    session: String(ctx?.sessionManager?.getSessionId?.() ?? ''),
  };
  if (Object.values(identity).some(value => !value) ||
      String(context.pr) !== identity.pr || String(context.issue) !== identity.issue ||
      String(context.head) !== identity.head || !context.review?.issue?.body) {
    throw new Error('review_submission_identity_invalid');
  }
  // Trusted temporary preflight file is bound to both the run and the actual
  // detached checkout; a stale HEAD cannot silently publish its review.
  if (env.GITHUB_ACTIONS === 'true') {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ctx?.cwd ?? env.JOB_DIR ?? process.cwd(), encoding: 'utf8',
    }).trim();
    if (head !== identity.head) throw new Error('review_submission_stale_checkout');
  }
  return { identity, criteria: reviewAcceptanceCriteria(context.review.issue.body) };
}

function sameIdentity(a, b) {
  return Object.keys(a ?? {}).length === 6 && Object.keys(b ?? {}).length === 6 &&
    Object.keys(a).every(key => a[key] === b[key]);
}

export default function registerReviewerResultTool(pi) {
  const state = {
    phase: 'review', control: null, lastAssistant: null,
    providerRequest: 0, budget: null, originalModel: null,
    providerEvidence: null, surfaceVerified: false, correctionUsed: false,
    truncationUsed: false, truncatedArguments: false, executionError: false,
    lastInputTokens: null, bound: null,
  };
  const tools = new Map();

  const resetAttempt = () => {
    state.control = null;
    state.lastAssistant = null;
    state.providerEvidence = null;
    state.surfaceVerified = false;
    state.truncatedArguments = false;
    state.executionError = false;
  };
  const restoreBudget = async () => {
    if (!state.originalModel) return;
    const model = state.originalModel;
    state.originalModel = null;
    try {
      if (!(await pi.setModel?.(model))) console.warn('PI_REVIEW_SUBMISSION_BUDGET_RESTORE_UNAVAILABLE');
    } catch (error) {
      console.warn('PI_REVIEW_SUBMISSION_BUDGET_RESTORE_FAILED ' + String(error?.message ?? error));
    }
  };
  const fail = async (code, ctx, details = {}) => {
    state.phase = 'failed';
    console.error('PI_REVIEW_SUBMISSION_FAILED ' + JSON.stringify({
      code, request: state.providerRequest, ...details,
      checkpoint: { worktree_preserved: true, verdict_published: false },
    }));
    await restoreBudget();
    ctx?.abort?.();
  };
  const budget = async (ctx, tokens) => {
    if (!ctx?.model || typeof pi.setModel !== 'function') return false;
    const window = Number(ctx.model.contextWindow);
    if (Number.isFinite(window) && window > 0) {
      if (window < tokens + 1024) return false;
      if (tokens === REVIEW_SUBMISSION_RETRY_TOKENS &&
          (!Number.isFinite(state.lastInputTokens) || state.lastInputTokens + tokens + 1024 > window)) {
        return false;
      }
    }
    const before = { ...ctx.model };
    if (!(await pi.setModel({ ...ctx.model, maxTokens: tokens }))) return false;
    state.originalModel ??= before;
    state.budget = tokens;
    return true;
  };

  pi.registerTool({
    name: 'begin_review_submission',
    label: 'Close Reviewer investigation',
    description: 'NONTERMINAL. Bind PASS or CHANGES_REQUESTED to this run and PR HEAD. The NEXT provider request exposes only submit_result({reviewText}). No write access.',
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal('PASS'), Type.Literal('CHANGES_REQUESTED')]),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (state.phase !== 'review' || state.control?.kind !== 'begin' ||
          state.control.id !== toolCallId || state.control.verdict !== params.verdict) {
        throw new Error('review_begin_not_admitted');
      }
      const bound = currentIdentity(ctx);
      state.bound = { ...bound, verdict: params.verdict };
      return { content: [{ type: 'text',
        text: 'Review investigation closed. Next request has only submit_result({reviewText}); verdict and identity are already bound.' }] };
    },
  });

  pi.registerTool({
    name: 'submit_result',
    label: 'Submit Reviewer text',
    description: DESCRIPTION,
    parameters: Type.Object({
      reviewText: Type.String({ minLength: 1, maxLength: 12000 }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const assistant = state.lastAssistant;
      const calls = assistant?.calls ?? [];
      const admitted = state.phase === 'submission_pending' &&
        state.providerRequest > 0 && state.providerRequest <= REVIEW_SUBMISSION_MAX_REQUESTS &&
        state.providerEvidence?.verified && state.surfaceVerified &&
        state.control?.kind === 'submit' && state.control.id === toolCallId &&
        assistant?.reason === 'tooluse' && !assistant.providerError &&
        calls.length === 1 && calls[0].name === 'submit_result' && calls[0].id === toolCallId &&
        params && typeof params === 'object' && !Array.isArray(params) &&
        Object.keys(params).length === 1 && typeof params.reviewText === 'string' &&
        params.reviewText.trim();
      if (!admitted) throw new Error('review_terminal_tooluse_unverified');
      const now = currentIdentity(ctx);
      if (!sameIdentity(state.bound?.identity, now.identity)) throw new Error('review_submission_stale_identity');
      const data = validateTextReview({
        verdict: state.bound.verdict, reviewText: params.reviewText,
        acceptanceCriteria: state.bound.criteria,
      });
      // The only authority for downstream REVIEW_RESULT is a fully executed
      // toolUse plus an atomic, run/HEAD/session/digest-bound terminal receipt.
      pi.appendEntry('review-result', data);
      const terminal = terminalResult('Review result recorded. Stop now.', undefined,
        createReviewReceipt(data, state.bound.identity));
      state.phase = 'submitted';
      await restoreBudget();
      return terminal;
    },
  });

  // Restore the bounded pre-submission settle guard from registerTerminalTool.
  // Terminal-only requests use the explicit format/truncation recovery controller
  // instead; do not accidentally grant an unbounded submit_result nudge there.
  registerSubmitNudge(pi, {
    isSubmitted: () => state.phase !== 'review',
    customType: 'pi-reviewer-begin-nudge',
    content: () => {
      const available = pi.getActiveTools?.() ?? [];
      if (available.includes('declare_task_complexity')) {
        return 'Review classification is not complete. Call declare_task_complexity before beginning terminal submission.';
      }
      return 'The review has not been submitted. If a concrete review question remains, investigate it with an exposed read-only tool. Otherwise call begin_review_submission({verdict:"PASS"|"CHANGES_REQUESTED"}) once; do not answer in prose.';
    },
    maxNudges: 1,
  });

  pi.on('tool_call', event => {
    if (state.phase === 'failed' || state.phase === 'submitted') {
      return { block: true, reason: 'Reviewer terminal submission is closed.' };
    }
    if (state.phase === 'review') {
      if (event.toolName === 'submit_result') {
        return { block: true, reason: 'First call begin_review_submission({verdict}); direct submit_result is forbidden.' };
      }
      if (event.toolName === 'begin_review_submission') {
        if (state.control || !['PASS', 'CHANGES_REQUESTED'].includes(event.input?.verdict) ||
            Object.keys(event.input ?? {}).length !== 1) {
          return { block: true, reason: 'begin_review_submission must be a single valid verdict transition.' };
        }
        state.control = { kind: 'begin', id: event.toolCallId, verdict: event.input.verdict, executed: false };
      } else if (state.control?.kind === 'begin') {
        return { block: true, reason: 'begin_review_submission must be the only tool call on its turn.' };
      }
    } else if (state.phase === 'submission_pending') {
      if (event.toolName !== 'submit_result') {
        state.control = { kind: 'invalid', id: event.toolCallId, executed: false };
        return { block: true, reason: 'Terminal request cannot inspect or mutate the repository.' };
      }
      if (state.control) {
        state.control.kind = 'invalid';
        return { block: true, reason: 'Only one submit_result tool call per request.' };
      }
      const input = event.input;
      const valid = input && typeof input === 'object' && !Array.isArray(input) &&
        Object.keys(input).length === 1 && typeof input.reviewText === 'string' && input.reviewText.trim();
      state.control = { kind: valid ? 'submit' : 'invalid', id: event.toolCallId, executed: false };
      if (!valid) return { block: true, reason: 'submit_result requires only one nonempty reviewText string.' };
    }
    return undefined;
  });
  pi.on('message_end', event => {
    const message = event?.message;
    if (message?.role !== 'assistant') return;
    const reason = String(message.stopReason ?? message.stop_reason ?? '').toLowerCase();
    const calls = Array.isArray(message.content)
      ? message.content.filter(item => item?.type === 'toolCall').map(item => ({ id: item.id, name: item.name }))
      : [];
    const input = Number(message.usage?.inputTokens ?? message.usage?.input_tokens ?? message.usage?.input);
    if (Number.isFinite(input) && input >= 0) state.lastInputTokens = input;
    state.lastAssistant = { reason, calls, providerError: Boolean(message.errorMessage) };
  });
  pi.on('tool_execution_end', event => {
    if (state.control && event.toolCallId === state.control.id) {
      state.control.executed = !event.isError;
      if (event.isError) state.executionError = true;
    }
    if (state.phase === 'submitted' && event.toolName === 'submit_result' && event.isError) {
      state.phase = 'failed';
      // Do not leave behind a publication-capable terminal receipt after an
      // anomalous executor completion, even if the tool returned earlier.
      fs.rmSync(String(process.env.PI_TERMINAL_RESULT_FILE ?? ''), { force: true });
      console.error('PI_REVIEW_SUBMISSION_FAILED ' + JSON.stringify({ code: 'review_post_execution_error' }));
    }
  });
  pi.on('tool_result', event => {
    if (state.phase === 'submission_pending' && event.toolName === 'submit_result' && event.isError &&
        /output token limit|arguments may be truncated|unterminated|unexpected end of json/i.test(
          (event.content ?? []).map(item => item.text ?? '').join(' '))) {
      state.truncatedArguments = true;
    }
  });
  pi.on('before_provider_request', (event, ctx) => {
    if (state.phase !== 'submission_pending' && state.phase !== 'failed') return undefined;
    const payload = event?.payload;
    if (!payload) return undefined;
    state.providerRequest += 1;
    if (state.providerRequest > REVIEW_SUBMISSION_MAX_REQUESTS) {
      void fail('review_submission_request_limit', ctx);
      return { ...payload, tools: [], tool_choice: 'none' };
    }
    const restricted = state.phase === 'submission_pending'
      ? restrictReviewSubmissionPayload(payload)
      : { ...payload, tools: [], tool_choice: 'none' };
    state.providerEvidence = reviewerProviderBudgetEvidence(payload, state.budget);
    state.surfaceVerified = restricted.tools.length === 1 && restricted.tool_choice === 'auto';
    console.log('PI_REVIEW_SUBMISSION_REQUEST ' + JSON.stringify({
      request: state.providerRequest, budget: state.budget,
      actualBudget: state.providerEvidence.effective,
      budgetVerified: state.providerEvidence.verified,
      surfaceVerified: state.surfaceVerified, toolChoice: restricted.tool_choice,
      tools: restricted.tools.map(tool => tool.function?.name ?? tool.name),
      schemaRequired: restricted.tools[0]?.function?.parameters?.required ??
        restricted.tools[0]?.parameters?.required ?? [],
    }));
    return restricted;
  });
  pi.on('turn_end', async (_event, ctx) => {
    const last = state.lastAssistant, control = state.control;
    const complete = last?.reason === 'tooluse' && last.calls.length === 1 &&
      last.calls[0].id === control?.id &&
      last.calls[0].name === (control?.kind === 'begin' ? 'begin_review_submission' : 'submit_result');
    if (state.phase === 'review') {
      if (control?.kind !== 'begin') return;
      state.control = null;
      if (!complete || !control.executed || !state.bound) {
        await fail('review_begin_turn_incomplete', ctx);
        return;
      }
      if (!(await budget(ctx, REVIEW_SUBMISSION_TOKENS))) {
        await fail('review_submission_budget_unavailable', ctx);
        return;
      }
      state.phase = 'submission_pending';
      resetAttempt();
      pi.setActiveTools?.(['submit_result']);
      const criteria = state.bound.criteria.map((criterion, index) => {
        return String(index + 1) + '. ' + criterion;
      }).join('\n');
      console.log('PI_REVIEW_SUBMISSION_PHASE ' + JSON.stringify({
        phase: state.phase, budget: state.budget, criteria: state.bound.criteria.length,
      }));
      await pi.sendUserMessage?.('INVESTIGATION CLOSED. On this NEW request call ONLY submit_result({reviewText:"..."}). Do not call read or other tools, do not submit prose-only. The verdict is already bound: ' +
        state.bound.verdict + '. For PASS use ## Acceptance evidence and exactly one ### Criterion N: <issue criterion> section per criterion below. Under each section add Status: ESTABLISHED (or ASSUMPTION with Assumption: ...) and Evidence: <concrete source/test plus behavior>. For CHANGES_REQUESTED provide ## Blocking findings with actionable locations and consequences.\nTrusted issue acceptance criteria:\n' + criteria,
        { deliverAs: 'steer' });
      return;
    }
    if (state.phase !== 'submission_pending') return;
    if (control?.kind === 'submit' && control.executed && complete &&
        state.providerEvidence?.verified && state.surfaceVerified) {
      state.phase = 'submitted';
      console.log('PI_REVIEW_SUBMISSION_ACCEPTED ' + JSON.stringify({
        request: state.providerRequest, budget: state.budget, toolExecuted: true,
      }));
      return;
    }
    const providerFailed = last?.providerError ||
      ['error', 'abort', 'aborted', 'timeout', 'cancelled'].includes(last?.reason);
    const truncated = last?.reason === 'length' || state.truncatedArguments;
    const outcome = !state.providerEvidence?.verified ? 'budget_unverified'
      : !state.surfaceVerified ? 'surface_unverified'
      : providerFailed ? 'provider_error'
      : truncated ? 'truncated'
      : !last?.calls?.length ? 'missing_tool_call'
      : last?.reason !== 'tooluse' ? 'stop_reason_mismatch'
      : state.executionError ? 'tool_execution_failed'
      : control?.kind !== 'submit' ? 'invalid_arguments_or_extra_tools'
      : !control.executed ? 'tool_not_executed' : 'terminal_incomplete';
    console.warn('PI_REVIEW_SUBMISSION_OUTCOME ' + JSON.stringify({
      request: state.providerRequest, outcome, toolCalls: last?.calls?.length ?? 0,
      stopReason: last?.reason, executed: control?.executed === true,
    }));
    if (control?.executed) return fail('review_post_execution_incomplete', ctx);
    if (!state.providerEvidence?.verified) return fail('review_submission_budget_unverified', ctx);
    if (!state.surfaceVerified) return fail('review_submission_surface_unverified', ctx);
    if (providerFailed) return fail('review_submission_provider_error', ctx);
    if (truncated) {
      if (state.truncationUsed) return fail('review_submission_truncation_exhausted', ctx);
      state.truncationUsed = true;
      if (!(await budget(ctx, REVIEW_SUBMISSION_RETRY_TOKENS))) {
        return fail('review_submission_context_exhausted', ctx);
      }
    } else {
      if (state.correctionUsed) return fail('review_submission_correction_exhausted', ctx);
      state.correctionUsed = true;
      if (!(await budget(ctx, REVIEW_SUBMISSION_TOKENS))) {
        return fail('review_submission_budget_unavailable', ctx);
      }
    }
    resetAttempt();
    pi.setActiveTools?.(['submit_result']);
    console.log('PI_REVIEW_SUBMISSION_RETRY ' + JSON.stringify({
      mode: truncated ? 'truncation' : 'correction', request: state.providerRequest + 1,
      correctionUsed: state.correctionUsed, truncationUsed: state.truncationUsed,
    }));
    await pi.sendUserMessage?.(truncated
      ? 'TRUNCATED TOOL ARGUMENTS. New request: call only submit_result({reviewText:"FULL findings and per-criterion evidence"}). No other tool.'
      : 'INVALID FORMAT OR INCOMPLETE EVIDENCE. New request: call only submit_result with a complete issue-specific reviewText. Do not reply in prose, omit any required criteria, or make another repository tool call.',
    { deliverAs: 'steer' });
  });
}
