export const STAGES = Object.freeze({
  architect: {
    resultTool: 'pi-architect-result-tool.mjs',
    bashTimeoutSeconds: 600,
    maxTurns: 100,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/architect/AGENTS.md',
    requireComplexity: false,
  },
  dispatcher: {
    resultTool: 'pi-dispatcher-result-tool.mjs',
    bashTimeoutSeconds: 600,
    maxTurns: 30,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/dispatcher/AGENTS.md',
    requireComplexity: false,
  },
  triage: {
    resultTool: 'pi-triage-result-tool.mjs',
    bashTimeoutSeconds: 600,
    maxTurns: 100,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/triage/AGENTS.md',
    requireComplexity: false,
    fixedResponseMaxTokens: 1000,
  },
  reviewer: {
    resultTool: 'pi-reviewer-result-tool.mjs',
    bashTimeoutSeconds: 600,
    maxTurns: 100,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/reviewer/AGENTS.md',
    requireComplexity: true,
    preComplexityTurnLimit: 8,
    preComplexityAllowedTools: ['read', 'bash'],
  },
  repair: {
    resultTool: 'pi-repair-result-tool.mjs',
    bashTimeoutSeconds: 1200,
    maxTurns: 100,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/repair/AGENTS.md',
    requireComplexity: true,
    preComplexityTurnLimit: 8,
    preComplexityAllowedTools: ['read', 'bash'],
  },
  implementer: {
    resultTool: 'pi-implementer-result-tool.mjs',
    bashTimeoutSeconds: 1800,
    maxTurns: 100,
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/implementer/AGENTS.md',
    requireComplexity: true,
    preComplexityTurnLimit: 8,
    preComplexityAllowedTools: ['read', 'bash'],
  },
});

export function stageConfig(name) {
  const config = STAGES[name];
  if (!config) throw new Error(`Unknown Pi stage: ${name}`);
  return config;
}

export function stagePrompt(name, env = process.env) {
  if (name === 'architect') {
    const root = env.RUNNER_TEMP;
    if (!root) throw new Error('RUNNER_TEMP is required for Architect');
    return `Read and follow agents/architect/AGENTS.md. The source issue, metadata, open issues and current queue are in ${root}/pi-architect-context.json. Start from that prepared context. Inspect code, related work, project docs or skills only when needed to answer a concrete KEEP/REVISE/SPLIT question. Size or complexity alone is not a reason to split. Stop exploring once the decision is justified. Call submit_result exactly once as your final action. Do not edit files or change GitHub state.`;
  }
  if (name === 'reviewer') {
    if (!env.ISSUE || !env.PR) throw new Error('ISSUE and PR are required for Reviewer');
    return `Read agents/reviewer/AGENTS.md first. Then read issue #${env.ISSUE}, inspect the complete PR diff and directly relevant changed code, and write a short review plan of at most 1000 output tokens. Only then call declare_task_complexity based on that evidence. Review PR #${env.PR} against issue #${env.ISSUE}. Do not modify files or GitHub state. The deterministic checks already passed; do not rerun pytest, Ruff, or git diff --check. Do not depend on a captured dev SHA or pre-merge CI status. Call submit_result exactly once as your final action.`;
  }
  if (name === 'repair') {
    if (!env.ISSUE || !env.PR || !env.ISSUE_CONTEXT) throw new Error('ISSUE, PR and ISSUE_CONTEXT are required for PR Fix');
    return `Read agents/repair/AGENTS.md, then read the complete original issue JSON from ${env.ISSUE_CONTEXT}. Repair PR #${env.PR} for issue #${env.ISSUE}. The worktree was preflight-synced with current dev; if merge conflicts remain, resolve them first. Work only from the PR branch and current repository evidence. Make the smallest correct change. Finish by calling submit_repair; it integrates current dev and validates the final tree. If it reports merge conflicts or failing checks, resolve them in this same session and retry submit_repair until it succeeds. Do not push or modify GitHub state yourself.`;
  }
  throw new Error(`Stage ${name} requires an explicit prompt file`);
}
