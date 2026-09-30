import fs from 'node:fs';
import path from 'node:path';

import { IMPLEMENTER_RESPONSE_MAX_TOKENS, RESPONSE_BUDGETS } from './progress-controller.mjs';
import { baseBranch, baseRef, projectConfig } from './project-config.mjs';

/** Role prompt location, relative to the checkout (`agents.promptsDir`). */
const promptPath = role => `${projectConfig().agents.promptsDir}/${role}/AGENTS.md`;

function loadAgentContract(name, env = process.env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  return fs.readFileSync(path.join(workspace, promptPath(name)), 'utf8').trim();
}

const promptBuilders = Object.freeze({
  architect(env) {
    const root = env.RUNNER_TEMP;
    if (!root) throw new Error('RUNNER_TEMP is required for Architect');
    return `Read and follow ${promptPath('architect')}. The source issue, metadata, open issues and current queue are in ${root}/pi-architect-context.json. Start from that prepared context. Inspect code, related work, project docs or skills only when needed to answer a concrete KEEP/REVISE/SPLIT question. Size or complexity alone is not a reason to split. Stop exploring once the decision is justified. Call submit_result exactly once as your final action. Do not edit files or change GitHub state.`;
  },

  dispatcher(env) {
    const root = env.RUNNER_TEMP;
    if (!root) throw new Error('RUNNER_TEMP is required for Dispatcher');
    return `Read and follow ${promptPath('dispatcher')}, then read ${root}/pi-dispatcher-context.json.
Each candidate already contains the current GitHub issue metadata and scope needed for classification; that prepared context is sufficient and authoritative.
Do not read project documentation, repository code, Git history, queue state, or unrelated issues.
For every candidate decide only IMPLEMENT or ARCHITECT based on its written scope, then call submit_result exactly once as your last action.
After the prepared context is read, runtime closes exploration and only terminal submission remains valid. Do not modify repository or GitHub state.`;
  },

  triage(env) {
    const root = env.RUNNER_TEMP;
    if (!root) throw new Error('RUNNER_TEMP is required for Triage');
    return `Read and follow ${promptPath('triage')}. Do not read docs/PROJECT_CONTEXT.md unless one specific candidate genuinely requires product context to resolve an ambiguity.
The candidate issues to review are at ${root}/pi-triage-context.json.
The snapshot contains current issue body, Task metadata, labels, dependency states, and relevant comments.
Classify every candidate exactly once as ready for Dispatcher, needing a person, or skipped. Do not reconsider a decided candidate.
After the prepared context is read, runtime closes exploration. Put the complete classification directly into submit_result without narrating or printing an intermediate classification list.
Call submit_result exactly once as your last action. Do not modify repository or GitHub state.`;
  },

  reviewer(env) {
    if (!env.ISSUE || !env.PR) throw new Error('ISSUE and PR are required for Reviewer');
    const reviewContext = env.REVIEW_CONTEXT
      ? `Read the trusted prepared review context at ${env.REVIEW_CONTEXT}; it contains the linked issue title/body and PR metadata.`
      : `Read issue #${env.ISSUE} directly.`;
    const worktreeRoot = env.JOB_DIR || process.cwd();
    return `Read ${promptPath('reviewer')} first. ${reviewContext} Then inspect the complete PR diff against ${baseRef()} and directly relevant changed code exactly once, and write a short review plan of at most 1000 output tokens. Do not inspect repository structure, git history, branches, PR body, or issue comments before classification unless the prepared issue and diff leave one concrete ambiguity. Once issue + diff + plan are available, call declare_task_complexity immediately and do not repeatedly reconsider the classification. Reviewer LSP workspace root: ${worktreeRoot}. For a concrete unresolved question about an already-named source symbol, use semantic LSP lookup first; when the language is explicit and only the name is known, call lsp_start_server once with this exact root and then lsp_find_symbol. Use grep/rg/indexed or broad repository search only if semantic lookup fails or returns no useful match. When the issue describes existing behavior, current checked-out code is authoritative for factual behavior; do not PASS a PR that repeats an issue's factual claim when the inspected code proves that claim materially false. Review PR #${env.PR} against issue #${env.ISSUE}. A blocked or failed tool call did not execute; never count it as completed. Do not modify files or GitHub state. The deterministic checks already passed; do not rerun pytest, Ruff, or git diff --check. Do not depend on a captured dev SHA or pre-merge CI status. Call submit_result exactly once as your final action.`;
  },

  repair(env) {
    if (!env.ISSUE || !env.PR || !env.ISSUE_CONTEXT) throw new Error('ISSUE, PR and ISSUE_CONTEXT are required for PR Fix');
    return `Read ${promptPath('repair')}, then read the complete original issue JSON from ${env.ISSUE_CONTEXT}. Repair PR #${env.PR} for issue #${env.ISSUE}. The worktree was preflight-synced with current ${baseBranch()}; if merge conflicts remain, resolve them first. Work only from the PR branch and current repository evidence. Make the smallest correct change. Finish by calling submit_repair; it integrates current ${baseBranch()} and validates the final tree. If it reports merge conflicts or failing checks, resolve them in this same session and retry submit_repair until it succeeds. Do not push or modify GitHub state yourself.`;
  },

  implementer(env) {
    const issue = env.ISSUE ?? env.PI_ISSUE;
    const contextFile = env.PI_ISSUE_CONTEXT;
    if (!issue || !contextFile) throw new Error('ISSUE and PI_ISSUE_CONTEXT are required for Implementer');
    const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
    const title = context.title ?? '';
    const body = context.body ?? '';
    const contract = loadAgentContract('implementer', env);
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
    const resumeNotice = resumed
      ? `Runtime resume state: restored ${resumeSource} work is already in this worktree. The operating contract is already loaded in this prompt. Call \`submit_result\` with no arguments immediately. Do not call \`prepare_implementation\` and do not inspect, summarize, or plan the restored files first. If \`submit_result\` fails, fix only the concrete reported problem and retry. Do not pass \`already_satisfied\` for restored work; if saved work is already contained in latest dev, \`submit_result\` detects that zero-diff state and completes it automatically.\n\n`
      : '';
    const executionGuidance = resumed
      ? `Runtime context: restored work is already present. Follow the embedded contract's restored-work path and submit immediately.`
      : `Runtime context:
- Fresh worktree base: latest fetched ${baseRef()}${freshBaseCommit ? ` at ${freshBaseCommit}` : ''}.
- LSP workspace root: ${worktreeRoot}.
- prepare_implementation returns the startup plan and a trivial/nontrivial classification in one structured child call.
Follow the embedded contract for evidence routing, productive-progress limits, mutation, validation, and submission.`;
    return `The complete Implementer operating contract is embedded below and is authoritative. Do not search for or re-read ${promptPath('implementer')}.

<implementer_contract>
${contract}
</implementer_contract>

You are implementing GitHub issue #${issue} in the current repository.

Issue title:
${title}

Issue body:
${body}

${resumeNotice}${executionGuidance}`;
  }
});

export const STAGES = Object.freeze({
  architect: {
    resultTool: 'pi-architect-result-tool.mjs',
    phase: 'architect',
    bashTimeoutSeconds: 600,
    maxTurns: 100,
    repeatThreshold: 3,
    requiredFirstReadPath: promptPath('architect'),
    requireComplexity: false,
    prompt: promptBuilders.architect,
  },
  dispatcher: {
    resultTool: 'pi-dispatcher-result-tool.mjs',
    phase: 'dispatcher',
    bashTimeoutSeconds: 600,
    maxTurns: 30,
    repeatThreshold: 3,
    requiredFirstReadPath: promptPath('dispatcher'),
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
    requiredFirstReadPath: promptPath('triage'),
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
    requiredFirstReadPath: promptPath('reviewer'),
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
    requiredFirstReadPath: promptPath('repair'),
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
    // ladder below, and a large code-bearing mutation gets the 16k ceiling for exactly
    // one response via `request_large_mutation_budget` (see `productiveProgress`).
    implementationPlannerAgent: 'implementation-planner',
    implementationPlannerMaxTokens: 768,
    implementationPlannerStructuredRetry: 1,
    implementationPlannerTimeoutMs: 120000,
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
      // One-shot elevated ceiling for a response that must emit a large write/edit payload.
      // Granted by `request_large_mutation_budget`, applied to exactly the next response,
      // and always collapsed back to the small action budget afterward.
      largeMutationBudgetTool: 'request_large_mutation_budget',
      largeMutationBudgetMaxTokens: IMPLEMENTER_RESPONSE_MAX_TOKENS,
      actionTools: ['structural_edit', 'safe_edit', 'edit', 'write', 'rollback_last_mutation', 'submit_result'],
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
