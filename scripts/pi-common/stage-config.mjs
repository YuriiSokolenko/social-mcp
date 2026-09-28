import fs from 'node:fs';

const IMPLEMENTER_SUBAGENT_CATALOG = `Available delegated agents (already known; do not call subagent(action:"list")):
- implementation-planner — creates the startup implementation plan from issue title/body; prepare_implementation already invokes it.
- complexity-classifier — classifies issue + prepared plan; prepare_implementation already invokes it.
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
    return `Read and follow agents/dispatcher/AGENTS.md.
Read the project documentation once, before reading dispatcher candidates, to understand the project's architecture, conventions, component boundaries, and terminology.
Then read ${root}/pi-dispatcher-context.json; each candidate already contains the current GitHub issue metadata and scope needed for classification.
The candidates list is authoritative: do not re-check eligibility, dependencies, priority, ordering or capacity.
For every candidate decide only IMPLEMENT or ARCHITECT based on scope.
Call submit_result exactly once as your last action. Do not modify repository or GitHub state.`;
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
    return `Read agents/reviewer/AGENTS.md first. Then read issue #${env.ISSUE}, inspect the complete PR diff and directly relevant changed code, and write a short review plan of at most 1000 output tokens. Only then call declare_task_complexity based on that evidence. Review PR #${env.PR} against issue #${env.ISSUE}. Do not modify files or GitHub state. The deterministic checks already passed; do not rerun pytest, Ruff, or git diff --check. Do not depend on a captured dev SHA or pre-merge CI status. Call submit_result exactly once as your final action.`;
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
    return `Read and follow agents/implementer/AGENTS.md first. Do not write your own startup plan and do not inspect the repository before preparation.

Immediately after the required contract read, call \`prepare_implementation\` exactly once. The runtime sends only this issue title/body to the permanent \`implementation-planner\` subagent (768 max output tokens), then sends issue + returned plan to the separate \`complexity-classifier\`. The main agent receives only the prepared plan and complexity and should execute step 1 immediately.

You are implementing GitHub issue #${issue} in the current repository.

Issue title:
${title}

Issue body:
${body}

Work directly in the checked-out repository, always based on latest dev. dev is the only development base; never treat main as an alternative source tree.
After preparation:
- If one small target file is already known, the main agent may read it directly once with \`limit <= 200\`.
- The main agent may run only a bounded \`git diff\`/\`git status\` for one known path directly.
- If the path/symbol is unknown, more than one file must be inspected, patterns/usages must be searched, logs/diagnostics are involved, or broader command output is needed, delegate to \`scout\` (or package-owned \`run-ci\` for checks).
- \`grep\`, \`find\`, and \`ls\` remain delegated. Do not simulate search through repeated guessed reads.
- For scout requests, ask for the first sufficient answer, not the globally smallest/best match; require compact fixed-shape output.

Main owns execution decisions, \`edit\`/\`write\`, conflict mutations, and \`submit_result\`. Planning and task-level complexity are already owned by the startup subagents. If delegated evidence shows the exact requested end state already exists in latest dev, call \`submit_result\` immediately with \`already_satisfied: true\` and \`changes: []\`.

Use the smallest implementation satisfying the issue. Do not commit, push, create PRs, or modify GitHub state. \`submit_result\` integrates latest dev and owns final git diff --check, full pytest, and Ruff validation. A successful \`submit_result\` is terminal.

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
    prompt: promptBuilders.repair,
  },
  implementer: {
    resultTool: 'pi-implementer-result-tool.mjs',
    phase: 'implementation',
    bashTimeoutSeconds: 1800,
    maxTurns: 100,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/implementer/AGENTS.md',
    requireComplexity: true,
    implementationPlannerAgent: 'implementation-planner',
    implementationPlannerMaxTokens: 768,
    implementationPlannerStructuredRetry: 1,
    implementationPlannerTimeoutMs: 120000,
    complexityClassifierAgent: 'complexity-classifier',
    complexityClassifierTimeoutMs: 120000,
    preComplexityTurnLimit: 4,
    preComplexityAllowedTools: ['prepare_implementation'],
    delegatedTools: ['grep', 'find', 'ls'],
    trivialDirectDelegatedTools: ['grep', 'find', 'ls'],
    trivialDirectSearchCalls: 1,
    delegationTool: 'subagent',
    directReadMaxLines: 200,
    directReadCalls: 1,
    boundedDirectBash: true,
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
