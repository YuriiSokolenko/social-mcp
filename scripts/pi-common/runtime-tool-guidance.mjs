// Pure string guidance for authoritative tool surfaces. No IO, state or hooks.
import {
  MAIN_CAPABILITY_REQUEST_TOOL,
  MAX_MAIN_CAPABILITY_NOOPS,
  optionalMainToolGroup,
} from './main-tool-profile.mjs';

export function profileHiddenToolAdvice(name, snapshot, mainCapabilityNoops) {
  if (name === MAIN_CAPABILITY_REQUEST_TOOL) return mainCapabilityNoops >= MAX_MAIN_CAPABILITY_NOOPS
    ? 'BLOCKED: the Main capability-request no-op limit has been reached. No more capability requests; use a permitted safe tool or preserve the worktree and report a blocker.'
    : 'BLOCKED: the three successful Main capability grants have been used. No further capability expansion is available; keep the current safe tools or report a blocker.';
  if (['grep', 'find', 'ls'].includes(name)) return `BLOCKED: ${name} is permanently forbidden in Main; no capability grant can enable it. Use the permitted read or repository search tools.`;
  const group = optionalMainToolGroup(name);
  const permitted = snapshot?.executableTools?.includes(MAIN_CAPABILITY_REQUEST_TOOL);
  return permitted
    ? `BLOCKED: ${name} is intentionally hidden by the Main tool profile, not newly active. If this optional capability is genuinely required, call ${MAIN_CAPABILITY_REQUEST_TOOL} with group=${group} and a concrete reason; only a later provider request may expose ${name}. Do not retry this tool now.`
    : `BLOCKED: ${name} is hidden by the Main tool profile, and ${MAIN_CAPABILITY_REQUEST_TOOL} is not executable in this request. Do not retry or assume it appears later; use an exposed safe action or preserve the worktree.`;
}

export function taskSpecificToolGuidance(activeToolNames, {
  stage,
  codingSession,
  codingSessionTool,
  blockerTool,
  acceptMutationScopeTool,
  retryFailedCheckTool,
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
    if (ceilingHit && codingSessionTool && active.has(codingSessionTool)) {
      hints.push(`If the implementation is large, call ${codingSessionTool} now; it keeps the current context and provides the large coding ceiling instead of drafting code here.`);
    }
    if (active.has(acceptMutationScopeTool)) {
      hints.push('Before mutating a new publishable path, call accept_mutation_scope with that path and a task-specific rationale. Register scratch/probe paths as temporary; temporary paths must be removed before submission.');
    }
    if (active.has('submit_result')) {
      hints.push('If explicit written requirements or constraints are mutually incompatible and no compliant mutation exists, call submit_result with blocked_reason now.');
    }
    if (blockerTool && active.has(blockerTool)) {
      hints.push(`Call ${blockerTool} only when exactly one concrete missing fact prevents the next safe action.`);
      if (codingSession && !active.has('read')) {
        hints.push(`This coding session is action-required: read is not exposed now. Do not invent helper tools such as read_for_input; request the one missing fact through ${blockerTool}, or continue with an exposed mutation/terminal tool.`);
      }
    }
    if (active.has(retryFailedCheckTool)) {
      hints.push(`Use ${retryFailedCheckTool} to rerun the exact unresolved failed verification scope after fixing it.`);
    }
  }

  return hints.join(' ');
}
