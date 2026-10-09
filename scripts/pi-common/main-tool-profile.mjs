// Outbound Main tool-schema profile. This is NOT an executor registry or authorization
// boundary: Pi's active tools, ProgressController and the final provider request still
// decide whether a call is possible. Never add a definition from another request.
export const MAIN_CAPABILITY_REQUEST_TOOL = 'request_capabilities';
export const MAIN_CAPABILITY_GROUPS = Object.freeze([
  'docs', 'lsp', 'history', 'delegation', 'extended',
]);
export const MAX_MAIN_CAPABILITY_ESCALATIONS = 3;

// Required implementation, safety, exact recovery and terminal capabilities.
// Do not use task-text heuristics to remove these: a new file and an existing
// file need different actions, and failed verification can change the route.
const MAIN_CORE_TOOLS = new Set([
  'read', 'repo_search', 'indexed_repo_search', 'bash',
  'write', 'edit', 'structural_edit', 'safe_edit',
  'accept_mutation_scope', 'run_check', 'retry_last_failed_check',
  'rollback_last_mutation', 'undo_mutation', 'recover_worktree',
  'need_more_evidence', 'begin_coding_session', 'request_large_mutation_budget',
  'set_response_budget', 'begin_result_submission', 'submit_result',
  'submit_repair', MAIN_CAPABILITY_REQUEST_TOOL,
]);

export function optionalMainToolGroup(name) {
  if (typeof name !== 'string' || !name) return 'extended';
  if (/^(?:lsp_|mcp__.*(?:lsp|language_server))/i.test(name)) return 'lsp';
  if (/(?:searx|context7|web_search|web_fetch|fetch_url|search_web|docs_|documentation|mcp__.*(?:search|fetch|browser))/i.test(name)) return 'docs';
  if (/(?:git_history|git_log|git_show|git_blame|git_diff|git_commit|git_branch|commit_history|revision_history)/i.test(name)) return 'history';
  if (/(?:subagent|delegate|delegation|spawn_agent|parallel_agent)/i.test(name)) return 'delegation';
  return 'extended';
}

export function isMainCoreTool(name) {
  return MAIN_CORE_TOOLS.has(name) ||
    /^(?:terminal_|recover_|rollback_|undo_|submit_|begin_result_submission$|accept_mutation_scope$)/.test(name);
}

export function mainCapabilityGrant(granted, requested, { limit = MAX_MAIN_CAPABILITY_ESCALATIONS } = {}) {
  const existing = [...new Set(granted ?? [])];
  if (!MAIN_CAPABILITY_GROUPS.includes(requested)) {
    return { ok: false, reason: 'unknown_group', granted: existing };
  }
  if (existing.includes('extended') || existing.includes(requested)) {
    return { ok: true, changed: false, granted: existing };
  }
  if (existing.length >= limit) {
    return { ok: false, reason: 'escalation_limit', granted: existing };
  }
  return { ok: true, changed: true, granted: [...existing, requested] };
}

/**
 * Filter only serialized definitions, preserving their order and object identity.
 * Other phases keep their independent safety/repair/terminal profiles.
 * Newly granted groups are considered ONLY on a later invocation with a new
 * provider payload; the in-flight provider snapshot is not mutated.
 */
export function filterFreshMainToolProfile(payload, {
  freshMain = false,
  grantedGroups = [],
} = {}) {
  if (!freshMain || !Array.isArray(payload?.tools)) {
    return { payload, profile: 'phase_owned', admitted: [], deferred: [], originalCount: null };
  }
  const allOptional = grantedGroups.includes('extended');
  const grants = new Set(grantedGroups);
  const nameOf = tool => tool?.function?.name ?? tool?.name;
  const admitted = [], deferred = [];
  const tools = payload.tools.filter(tool => {
    const name = nameOf(tool);
    // Malformed definitions must not be used to synthesize a callable tool.
    if (typeof name !== 'string' || !name) return false;
    if (isMainCoreTool(name) || allOptional || grants.has(optionalMainToolGroup(name))) {
      admitted.push(name);
      return true;
    }
    deferred.push(name);
    return false;
  });
  return {
    payload: tools.length === payload.tools.length && tools.every((item, i) => item === payload.tools[i])
      ? payload
      : { ...payload, tools },
    profile: grants.size ? 'fresh_expanded' : 'fresh_core',
    admitted, deferred, originalCount: payload.tools.length,
  };
}
