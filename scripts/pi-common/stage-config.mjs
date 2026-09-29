import fs from 'node:fs';
import path from 'node:path';

function loadAgentContract(name, env = process.env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  return fs.readFileSync(path.join(workspace, 'agents', name, 'AGENTS.md'), 'utf8').trim();
}

const IMPLEMENTER_SUBAGENT_CATALOG = `Available delegated agents (already known; do not call subagent(action:"list")):
- implementation-planner — creates the startup implementation plan for fresh work from issue title/body; prepare_implementation invokes it.
- complexity-classifier — classifies fresh issue + prepared plan; prepare_implementation invokes it.
- scout — fast repository reconnaissance for unknown paths, symbols, usages, docs, logs, or broader evidence.
- delegate — lightweight focused helper for a narrow delegated question.
- reviewer — independent read-only review of code, diffs, plans, or evidence.
- oracle — high-context read-only advisor for difficult consistency or architecture decisions.
- researcher — focused web research when external/current evidence is genuinely required.
- evidence-auditor — checks whether research claims are supported by sources.
- worker — implementation specialist; do not use it as mutation owner in Implementer because main owns edits and submission.

The generic subagent tool may be hidden until subagents_enable is called. If delegation is actually needed, enable it once and then call the named agent directly. Never spend a turn listing agents.`;

const promptBuilders = Object.freeze({
  architect(env) {
    const root = env.RUNNER_TEMP;
    if (!root) throw new Error('RUNNER_TEMP is required for Architect');
    return `Read and follow agents/architect/AGENTS.md. The source issue, metadata, open issues and current queue are in ${root}/pi-architect-context.json. Start from that prepared context. Inspect code, related work, project docs or skills only when needed to answer a concrete KEEP/REVISE/SPLIT question. Size or complexity alone is not a reason to split. Stop exploring once the decision is justified. Call submit_result exactly once as your final action. Do not edit files or change GitHub state.`;
  },

  dispatcher(env) {
    const root = env.RUNNER_TEMP;
    if (!root) throw new Error('RUNNER_TEMP is required for Dispatcher');
    return `Read and follow agents/dispatcher/AGENTS.md, then read ${root}/pi-dispatcher-context.json.
Each candidate already contains the current GitHub issue metadata and scope needed for classification; that prepared context is sufficient and authoritative.
Do not read project documentation, repository code, Git history, queue state, or unrelated issues.
For every candidate decide only IMPLEMENT or ARCHITECT based on its written scope, then call submit_result exactly once as your last action.
After the prepared context is read, runtime closes exploration and only terminal submission remains valid. Do not modify repository or GitHub state.`;
  },

  triage(env) {
    const root = env.RUNNER_TEMP;
    if (!root) throw new Error('RUNNER_TEMP is required for Triage');
    return `Read and follow agents/triage/AGENTS.md. Do not read docs/PROJECT_CONTEXT.md unless one specific candidate genuinely requires product context to resolve an ambiguity.
The candidate issues to review are at ${root}/pi-triage-context.json.
The snapshot contains current issue body, Task metadata, labels, dependency states, and relevant comments.
Classify every candidate exactly once as ready for Dispatcher, needing a person, or skipped. Do not reconsider a decided candidate.
Call submit_result exactly once as your last action. Do not modify repository or GitHub state.`;
  },

  reviewer(env) {
    if (!env.ISSUE || !env.PR) throw new Error('ISSUE and PR are required for Reviewer');
    const reviewContext = env.REVIEW_CONTEXT
      ? `Read the trusted prepared review context at ${env.REVIEW_CONTEXT}; it contains the linked issue title/body and PR metadata.`
      : `Read issue #${env.ISSUE} directly.`;
    return `Read agents/reviewer/AGENTS.md first. ${reviewContext} Then inspect the complete PR diff against origin/dev and directly relevant changed code exactly once, and write a short review plan of at most 1000 output tokens. Do not inspect repository structure, git history, branches, PR body, or issue comments before classification unless the prepared issue and diff leave one concrete ambiguity. Once issue + diff + plan are available, call declare_task_complexity immediately and do not repeatedly reconsider the classification. Review PR #${env.PR} against issue #${env.ISSUE}. A blocked or failed tool call did not execute; never count it as completed. Do not modify files or GitHub state. The deterministic checks already passed; do not rerun pytest, Ruff, or git diff --check. Do not depend on a captured dev SHA or pre-merge CI status. Call submit_result exactly once as your final action.`;
  },

  repair(env) {
    if (!env.ISSUE || !env.PR || !env.ISSUE_CONTEXT) throw new Error('ISSUE, PR and ISSUE_CONTEXT are required for PR Fix');
    return `Read agents/repair/AGENTS.md, then read the complete original issue JSON from ${env.ISSUE_CONTEXT}. Repair PR #${env.PR} for issue #${env.ISSUE}. The worktree was preflight-synced with current dev; if merge conflicts remain, resolve them first. Work only from the PR branch and current repository evidence. Make the smallest correct change. Finish by calling submit_repair; it integrates current dev and validates the final tree. If it reports merge conflicts or failing checks, resolve them in this same session and retry submit_repair until it succeeds. Do not push or modify GitHub state yourself.`;
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
    const resumed = Boolean(resumePatch && fs.existsSync(resumePatch) && fs.statSync(resumePatch).size > 0);
    const freshBaseCommit = String(env.PI_IMPLEMENTER_START_COMMIT ?? '').trim();
    const resumeSource = env.PI_CHECKPOINT_EXPECTED
      ? 'checkpoint'
      : env.PI_ISSUE_BRANCH_EXPECTED
        ? 'issue branch'
        : 'saved work';
    const resumeNotice = resumed
      ? `Runtime resume state: restored ${resumeSource} work is already in this worktree. The operating contract is already loaded in this prompt. Call \`submit_result\` with no arguments immediately. Do not call \`prepare_implementation\` and do not inspect, summarize, or plan the restored files first. If \`submit_result\` fails, fix only the concrete reported problem and retry. Do not use \`already_satisfied\` for restored work.\n\n`
      : '';
    const startupInstruction = resumed
      ? 'This is restored work. Call `submit_result` with no arguments as your first tool action. Runtime validation and trusted repository state provide the publication metadata.'
      : `This is fresh work. Runtime created this worktree directly from the latest fetched origin/dev${freshBaseCommit ? ` at commit ${freshBaseCommit}` : ''}, with no saved issue work applied. Until the first successful edit/write, a direct read of the current worktree is latest-dev evidence; do not spend tools re-proving HEAD/origin/dev provenance. Call \`prepare_implementation\` exactly once as your first tool action. The runtime sends only this issue title/body to the permanent \`implementation-planner\` subagent (768 max output tokens), then sends issue + returned plan to the separate \`complexity-classifier\`. The main agent receives only the prepared plan and complexity.`;
    const executionGuidance = resumed
      ? `Restored work path:
- Call \`submit_result\` with no arguments before inspecting restored files; it is both validation and submission.
- Runtime derives restored-work publication metadata from the trusted issue context and validated diff.
- If it reports a concrete failure, fix only that failure and retry.
- Never use \`already_satisfied\` for restored work.`
      : `For fresh work after preparation:
- The worktree started as an exact checkout of latest fetched \`origin/dev\`. Before the first successful \`edit\`/\`write\`, direct reads of the current worktree are authoritative latest-dev evidence. Do not run Git commands merely to prove that provenance again.
- Read already-known target files directly. There is no runtime line-count or per-task file-count limit for known-path reads.
- After a mutation, the main agent may run bounded \`git diff\`/\`git status\` checks for known paths directly as needed.
- Use \`repo_search\` for cheap deterministic literal path/content discovery in the current tracked worktree before launching a scout.
- If complexity is \`trivial\` and the path is unknown, call \`trivial_repo_lookup\` exactly once; it inspects \`origin/dev\` only and excludes resumed/current-worktree changes. Do not enable subagents for that lookup.
- Delegate to \`scout\` only when deterministic search plus direct reads are insufficient to decide the next safe action: semantic comparison, logs/diagnostics/history, or other evidence requiring interpretation. Complexity alone never requires delegation.
- Direct \`grep\`, \`find\`, and \`ls\` remain blocked; use \`repo_search\` instead of simulating search through guessed reads.
- For scout requests, use \`async: false\`, ask for the first sufficient answer, and require compact fixed-shape output.
- Productive-progress runtime permits up to six bounded evidence actions after preparation. Use them as one narrow locate/read/anchor chain, then \`edit\`, \`write\`, or \`submit_result\`; if one concrete fact still blocks safe action after that window, call \`need_more_evidence\` to unlock exactly one further evidence action.`;
    return `The complete Implementer operating contract is embedded below and is authoritative. Do not search for or re-read agents/implementer/AGENTS.md.

<implementer_contract>
${contract}
</implementer_contract>

${startupInstruction}

You are implementing GitHub issue #${issue} in the current repository.

Issue title:
${title}

Issue body:
${body}

${resumeNotice}Work directly in the checked-out repository, always based on latest dev. dev is the only development base; never treat main as an alternative source tree.

${executionGuidance}

Main owns execution decisions, \`edit\`/\`write\`, conflict mutations, and \`submit_result\`. Planning and task-level complexity belong to the fresh-work startup subagents. If evidence shows the exact requested end state already exists in latest dev, call \`submit_result\` immediately with \`already_satisfied: true\` and \`changes: []\`. Never use \`already_satisfied\` for restored work.

Use the smallest implementation satisfying the issue. \`submit_result\` is both validation and submission; do not independently prove correctness before calling it. Do not commit, push, create PRs, or modify GitHub state. A successful \`submit_result\` is terminal.

${IMPLEMENTER_SUBAGENT_CATALOG}`;
  }
});

export const STAGES = Object.freeze({
  architect: {
    resultTool: 'pi-architect-result-tool.mjs',
    phase: 'architect',
    bashTimeoutSeconds: 600,
    maxTurns: 100,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/architect/AGENTS.md',
    requireComplexity: false,
    prompt: promptBuilders.architect,
  },
  dispatcher: {
    resultTool: 'pi-dispatcher-result-tool.mjs',
    phase: 'dispatcher',
    bashTimeoutSeconds: 600,
    maxTurns: 30,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/dispatcher/AGENTS.md',
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
    requiredFirstReadPath: 'agents/triage/AGENTS.md',
    requireComplexity: false,
    fixedResponseMaxTokens: 1000,
    prompt: promptBuilders.triage,
  },
  reviewer: {
    resultTool: 'pi-reviewer-result-tool.mjs',
    phase: 'review',
    bashTimeoutSeconds: 600,
    maxTurns: 100,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/reviewer/AGENTS.md',
    requireComplexity: true,
    preComplexityTurnLimit: 8,
    preComplexityAllowedTools: ['read', 'bash'],
    preComplexityTransitionTools: ['declare_task_complexity'],
    prompt: promptBuilders.reviewer,
  },
  repair: {
    resultTool: 'pi-repair-result-tool.mjs',
    phase: 'repair',
    bashTimeoutSeconds: 1200,
    maxTurns: 100,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/repair/AGENTS.md',
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
    implementationPlannerAgent: 'implementation-planner',
    implementationPlannerMaxTokens: 768,
    implementationPlannerStructuredRetry: 1,
    implementationPlannerTimeoutMs: 120000,
    complexityClassifierAgent: 'complexity-classifier',
    complexityClassifierTimeoutMs: 120000,
    preComplexityTurnLimit: 4,
    preComplexityAllowedTools: ['prepare_implementation'],
    preComplexityTransitionTools: ['prepare_implementation'],
    delegatedTools: ['grep', 'find', 'ls'],
    delegationTool: 'subagent',
    boundedDirectBash: true,
    singleUseTools: ['prepare_implementation'],
    productiveProgress: {
      activationTool: 'prepare_implementation',
      blockerTool: 'need_more_evidence',
      initialEvidenceBudget: 6,
      actionResponseMaxTokens: 512,
      actionTools: ['edit', 'write', 'rollback_last_mutation', 'submit_result'],
      controlTools: ['set_response_budget', 'subagents_enable'],
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
