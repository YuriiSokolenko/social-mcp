import fs from 'node:fs';
import path from 'node:path';

import { IMPLEMENTER_RESPONSE_MAX_TOKENS, RESPONSE_BUDGETS } from './progress-controller.mjs';
import { baseBranch, baseRef, projectConfig } from './project-config.mjs';

/** Model-facing contract locations, relative to the checkout (`agents.promptsDir`). */
const sharedPromptPath = () => `${projectConfig().agents.promptsDir}/AGENTS.md`;
const promptPath = role => `${projectConfig().agents.promptsDir}/${role}/AGENTS.md`;

function loadPromptFile(relativePath, env = process.env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  return fs.readFileSync(path.join(workspace, relativePath), 'utf8').trim();
}

export function agentContractPrompt(name, env = process.env) {
  const shared = loadPromptFile(sharedPromptPath(), env);
  const role = loadPromptFile(promptPath(name), env);
  return `<shared_agent_contract source="${sharedPromptPath()}">
${shared}
</shared_agent_contract>

<role_contract source="${promptPath(name)}">
${role}
</role_contract>`;
}

function withContracts(name, env, trustedContext) {
  return `${agentContractPrompt(name, env)}

<trusted_context>
${trustedContext.trim()}
</trusted_context>`;
}

function untrustedTaskInput(value) {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
}

const promptBuilders = Object.freeze({
  architect(env) {
    const root = env.RUNNER_TEMP;
    if (!root) throw new Error('RUNNER_TEMP is required for Architect');
    return withContracts('architect', env, `
Prepared Architect context: ${root}/pi-architect-context.json
Use that file as the trusted source issue/queue context for this run.
`);
  },

  dispatcher(env) {
    const root = env.RUNNER_TEMP;
    if (!root) throw new Error('RUNNER_TEMP is required for Dispatcher');
    return withContracts('dispatcher', env, `
Prepared Dispatcher context: ${root}/pi-dispatcher-context.json
The candidates in that file are the trusted input for this run.
`);
  },

  triage(env) {
    const root = env.RUNNER_TEMP;
    if (!root) throw new Error('RUNNER_TEMP is required for Triage');
    return withContracts('triage', env, `
Prepared Triage context: ${root}/pi-triage-context.json
The snapshot in that file is the trusted input for this run.
`);
  },

  reviewer(env) {
    if (!env.ISSUE || !env.PR) throw new Error('ISSUE and PR are required for Reviewer');
    const reviewContext = env.REVIEW_CONTEXT
      ? `Trusted prepared review context: ${env.REVIEW_CONTEXT}`
      : `No prepared review context was supplied; read issue #${env.ISSUE} directly.`;
    const worktreeRoot = env.JOB_DIR || process.cwd();
    return withContracts('reviewer', env, `
Issue: #${env.ISSUE}
Pull request: #${env.PR}
Base ref: ${baseRef()}
${reviewContext}
Reviewer LSP workspace root: ${worktreeRoot}
`);
  },

  repair(env) {
    if (!env.ISSUE || !env.PR || !env.ISSUE_CONTEXT) throw new Error('ISSUE, PR and ISSUE_CONTEXT are required for PR Fix');
    return withContracts('repair', env, `
Issue: #${env.ISSUE}
Pull request: #${env.PR}
Original issue JSON: ${env.ISSUE_CONTEXT}
The worktree was preflight-synced with current ${baseBranch()}.
`);
  },

  implementer(env) {
    const issue = env.ISSUE ?? env.PI_ISSUE;
    const contextFile = env.PI_ISSUE_CONTEXT;
    if (!issue || !contextFile) throw new Error('ISSUE and PI_ISSUE_CONTEXT are required for Implementer');
    const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
    const title = context.title ?? '';
    const body = context.body ?? '';
    const resumePatch = env.PI_RESUME_PATCH;
    const resumed = env.PI_RESUME_ACTIVE != null
      ? env.PI_RESUME_ACTIVE === 'true'
      : Boolean(resumePatch && fs.existsSync(resumePatch) && fs.statSync(resumePatch).size > 0);
    const freshBaseCommit = String(env.PI_IMPLEMENTER_START_COMMIT ?? '').trim();
    const worktreeRoot = env.JOB_DIR || process.cwd();
    const resumeSource = env.PI_CHECKPOINT_EXPECTED
      ? 'checkpoint'
      : env.PI_ISSUE_BRANCH_EXPECTED
        ? 'issue branch'
        : 'saved work';
    const runtimeState = resumed
      ? `Runtime resume state: restored ${resumeSource} work is already in this worktree.
Call submit_result with no arguments immediately. Do not call prepare_implementation or inspect, summarize, validate, or plan the restored files first.
If submit_result reports a concrete problem, fix only that problem and retry. Do not pass already_satisfied for restored work; zero-diff restored work is completed by runtime automatically.`
      : `Fresh worktree base: latest fetched ${baseRef()}${freshBaseCommit ? ` at ${freshBaseCommit}` : ''}.
LSP workspace root: ${worktreeRoot}.
Call prepare_implementation exactly once as the first tool action; runtime returns the startup plan and trivial/nontrivial classification.`;

    return `${agentContractPrompt('implementer', env)}

<untrusted_task_input>
${untrustedTaskInput({ issue, title, body })}
</untrusted_task_input>

<trusted_context>
${runtimeState}
</trusted_context>`;
  },
});

export const STAGES = Object.freeze({
  architect: {
    resultTool: 'pi-architect-result-tool.mjs',
    phase: 'architect',
    bashTimeoutSeconds: 600,
    maxTurns: 100,
    repeatThreshold: 3,
    requireComplexity: false,
    prompt: promptBuilders.architect,
  },
  dispatcher: {
    resultTool: 'pi-dispatcher-result-tool.mjs',
    phase: 'dispatcher',
    bashTimeoutSeconds: 600,
    maxTurns: 30,
    repeatThreshold: 3,
    requireComplexity: false,
    productiveProgress: {
      activationReadSuffix: 'pi-dispatcher-context.json',
      actionTools: ['submit_result'],
      controlTools: ['set_response_budget'],
    },
    prompt: promptBuilders.dispatcher,
  },
  triage: {
    resultTool: 'pi-triage-result-tool.mjs',
    phase: 'triage',
    bashTimeoutSeconds: 600,
    maxTurns: 100,
    repeatThreshold: 3,
    requireComplexity: false,
    fixedResponseMaxTokens: 1000,
    productiveProgress: {
      activationReadSuffix: 'pi-triage-context.json',
      actionResponseMaxTokens: 512,
      actionResponseRetryMaxTokens: 512,
      actionTools: ['submit_result'],
      controlTools: [],
    },
    prompt: promptBuilders.triage,
  },
  reviewer: {
    resultTool: 'pi-reviewer-result-tool.mjs',
    phase: 'review',
    bashTimeoutSeconds: 600,
    maxTurns: 100,
    repeatThreshold: 3,
    requireComplexity: true,
    preComplexityTurnLimit: 8,
    preComplexityEvidenceBudget: 3,
    preComplexityActionResponseMaxTokens: 512,
    preComplexityActionResponseRetryMaxTokens: 512,
    postComplexityActionResponseMaxTokens: 1024,
    postComplexityActionResponseRetryMaxTokens: 1024,
    preComplexityAllowedTools: ['read', 'bash', 'lsp_start_server', 'lsp_find_symbol'],
    preComplexityTransitionTools: ['declare_task_complexity'],
    prompt: promptBuilders.reviewer,
  },
  repair: {
    resultTool: 'pi-repair-result-tool.mjs',
    phase: 'repair',
    bashTimeoutSeconds: 1200,
    maxTurns: 100,
    repeatThreshold: 3,
    requireComplexity: true,
    preComplexityTurnLimit: 8,
    preComplexityAllowedTools: ['read', 'bash'],
    preComplexityTransitionTools: ['declare_task_complexity'],
    prompt: promptBuilders.repair,
  },
  implementer: {
    resultTool: 'pi-implementer-result-tool.mjs',
    phase: 'implementation',
    bashTimeoutSeconds: 1800,
    maxTurns: 100,
    repeatThreshold: 3,
    requireComplexity: true,
    // No response-global fixed ceiling: normal turns use the small short/normal/deep
    // ladder below. The coding phase runs in a 16k fork of this session via
    // `begin_coding_session` (16k ceiling on the fork only). The parent-side one-shot grant
    // `request_large_mutation_budget` is LEGACY: kept only as a stage-1 compatibility fallback.
    implementationPlannerAgent: 'implementation-planner',
    implementationPlannerMaxTokens: 768,
    implementationPlannerStructuredRetry: 1,
    implementationPlannerTimeoutMs: 45000,
    preComplexityTurnLimit: 4,
    preComplexityAllowedTools: ['prepare_implementation'],
    preComplexityTransitionTools: ['prepare_implementation'],
    delegatedTools: ['grep', 'find', 'ls'],
    delegationTool: 'subagent',
    boundedDirectBash: true,
    singleUseTools: ['prepare_implementation'],
    requireLspStartBeforeFindSymbol: true,
    productiveProgress: {
      activationTool: 'prepare_implementation',
      blockerTool: 'need_more_evidence',
      verificationTool: 'run_check',
      initialEvidenceBudget: 6,
      // Fallback only: used when the planner's own per-task `evidence_budget` estimate is
      // absent. The planner's estimate (wired through `setEvidenceBudget`) is authoritative
      // because complexity alone is not a valid proxy for how much evidence a task needs.
      initialEvidenceBudgetByComplexity: {
        trivial: 2,
        nontrivial: 6,
      },
      actionResponseMaxTokens: RESPONSE_BUDGETS.short,
      actionResponseRetryMaxTokens: RESPONSE_BUDGETS.short,
      // LEGACY (stage-1 compatibility only; never selected by truncation recovery): one-shot
      // elevated ceiling on the parent's own next response via `request_large_mutation_budget`.
      // Prefer `begin_coding_session` below.
      largeMutationBudgetTool: 'request_large_mutation_budget',
      largeMutationBudgetMaxTokens: IMPLEMENTER_RESPONSE_MAX_TOKENS,
      // Coding phase: once preparation/evidence is done (action_required), the 2k Implementer
      // calls `begin_coding_session` and the runtime forks THIS session (pi-subagents
      // `context: 'fork'`) into a 16k continuation of the same Implementer that finishes the
      // work itself (code, tests, run_check, fixes, submit_result) under the same trusted
      // runtime, loaded from the control checkout. Bounded to a few sessions per run.
      codingSessionTool: 'begin_coding_session',
      codingSessionAgent: 'implementer-coding-session',
      codingSessionMaxTokens: IMPLEMENTER_RESPONSE_MAX_TOKENS,
      codingSessionTimeoutMs: 5400000,
      codingSessionMaxSessions: 2,
      // The coding session's tool allowlist: the normal Implementer coding/verification tools.
      // Exploration orchestration (subagents/scouts, LSP via ambient MCP extensions) and the
      // transition/legacy budget tools stay in the 2k phase.
      codingSessionTools: [
        'read', 'bash', 'write', 'edit', 'structural_edit', 'safe_edit', 'rollback_last_mutation', 'recover_worktree',
        'run_check', 'retry_last_failed_check', 'repo_search', 'indexed_repo_search', 'need_more_evidence', 'submit_result',
      ],
      actionTools: ['structural_edit', 'safe_edit', 'edit', 'write', 'begin_coding_session', 'rollback_last_mutation', 'recover_worktree', 'submit_result'],
      controlTools: ['set_response_budget', 'subagents_enable', 'lsp_start_server', 'request_large_mutation_budget'],
    },
    prompt: promptBuilders.implementer,
  },
});

export function stageConfig(name) {
  const config = STAGES[name];
  if (!config) throw new Error(`Unknown Pi stage: ${name}`);
  return config;
}

export function stagePrompt(name, env = process.env) {
  return stageConfig(name).prompt(env);
}
