import fs from 'node:fs';

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
    return `Follow the startup sequence in agents/implementer/AGENTS.md exactly: read AGENTS.md, use the supplied issue text below to identify acceptance criteria, write a short execution plan of at most 1000 output tokens, then call declare_task_complexity before repository inspection or modification. After complexity is declared, obtain repository facts through the subagent tool; the main agent must not call read/bash/grep/find/ls directly. A complex classification still means you implement this same issue to completion.

You are implementing GitHub issue #${issue} in the current repository.

Issue title:
${title}

Issue body:
${body}

Work directly in the checked-out repository.
The checked-out worktree is always based on the latest dev branch. dev is the only development base; never switch to, compare against, or treat main as an alternative source tree.
Implement the issue completely with the smallest scope that satisfies its acceptance criteria.
For an exact trivial edit, use the fast path from AGENTS.md: declare complexity, delegate one bounded repository-fact request when needed, edit promptly, delegate any useful post-change inspection, and submit.
Use the installed pi-subagents package for delegation. If a fresh session exposes only subagents_enable, call it once; the full subagent tool is available on the next model turn. For repository reads/search/navigation use the built-in scout agent in foreground mode (async: false). For a bounded read-only command/check, use the package-owned run-ci workflow through subagent when available. Never use a worker/reviewer subagent to mutate repository files; main-agent edit/write remains authoritative. Ask bounded questions and consume compact conclusions rather than raw repository output.
If replayed checkpoint work left merge conflicts, keep conflict resolution as the first implementation item; after complexity declaration use subagent to inspect only the conflicting/current-dev evidence needed, then resolve it in the main agent. Do not abandon current dev or inspect main as a replacement base.
Add or update tests when executable behavior changes; do not manufacture tests merely to restate an exact static artifact.
Before submission run only useful focused checks. Do not run full pytest or full Ruff just before submit_result.
submit_result owns the authoritative final git diff --check, full pytest, and Ruff validation after integrating latest dev.
If submit_result reports merge conflicts, resolve them in this same agent session, rerun relevant tests, and call submit_result again until it succeeds.
Do not commit, push, create a pull request, or modify GitHub issue labels; trusted workflow tooling owns those Git operations.
Do not access production credentials or external social APIs.
A successful submit_result is terminal: stop immediately and do not perform more tool calls or write another implementation recap.`;
  },
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
    preComplexityTurnLimit: 8,
    preComplexityAllowedTools: [],
    delegatedTools: ['read', 'bash', 'grep', 'find', 'ls'],
    delegationTool: 'subagent',
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
