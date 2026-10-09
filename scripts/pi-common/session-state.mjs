// Runtime-owned record of completed one-shot control transitions (LSP startup, subagent
// enablement). The runtime knows these deterministically, so it materializes them
// into model-visible context and the active tool surface instead of trusting model memory.

export const SUBAGENTS_ENABLE_TOOL = 'subagents_enable';
export const LSP_START_TOOL = 'lsp_start_server';

export function mergeNewlyActiveTools(baseline, current) {
  const known = new Set(baseline);
  return [...baseline, ...current.filter(name => !known.has(name))];
}

export function activeToolGuidance(activeToolNames) {
  const names = [...new Set(
    (Array.isArray(activeToolNames) ? activeToolNames : [])
      .filter(name => typeof name === 'string' && name.length > 0),
  )];
  return names.length > 0
    ? `CURRENTLY EXPOSED TOOLS (authoritative): ${names.join(', ')}. Call only a tool from this list.`
    : 'CURRENTLY EXPOSED TOOLS (authoritative): none. Do not invent a tool call.';
}

export function providerToolNames(payload) {
  if (!Array.isArray(payload?.tools)) return [];
  return [...new Set(payload.tools
    .map(tool => tool?.function?.name ?? tool?.name)
    .filter(name => typeof name === 'string' && name.length > 0))];
}

/**
 * Request-local routing, never a second capability registry. Keep instructions
 * small: the registered descriptions and JSON schemas remain the canonical
 * explanation of each tool's arguments. Every named callable tool below must
 * exist in the final serialized provider request, including Pi builtins and
 * extension/MCP functions.
 */
export function requestLocalToolUseGuidance(snapshot, serializedToolNames) {
  const names = [...new Set(serializedToolNames)];
  const exposed = new Set(names);
  const has = name => exposed.has(name);
  const hints = [];
  const mode = snapshot?.mode === 'coding' ? 'coding' : 'main';
  const state = snapshot?.productiveState;
  const preparation = snapshot?.preparationState;
  const resumed = snapshot?.resumed === true;
  const validationRepair = snapshot?.validationRepair === true;
  const append = (name, guidance) => { if (has(name)) hints.push(guidance); };

  if (resumed || validationRepair) {
    append('submit_result', 'Restored/validation-repair work: submit_result with no arguments immediately, except when the runtime has supplied a specific targeted integration repair.');
  } else if (snapshot?.terminalRecoveryRequiredTool && has(snapshot.terminalRecoveryRequiredTool)) {
    hints.push(`Terminal recovery: use ${snapshot.terminalRecoveryRequiredTool} only for the current exact obligation; do not restart broad discovery.`);
  } else if (has('begin_result_submission')) {
    hints.push('Changed work: finish the necessary changes and focused checks, then call begin_result_submission. The next provider request carries the dedicated terminal submission; do not combine the two requests.');
  } else if (has('submit_result') && names.length === 1) {
    hints.push('Terminal-only request: call submit_result with the resultText required for completed changed work, or the exact small outcome required by trusted recovery state. Do not inspect or mutate.');
  }

  if (!(resumed || validationRepair) && !snapshot?.terminalRecoveryRequiredTool) {
    if (mode === 'coding') {
      hints.push('Isolated coding session: the parent tool inventory and navigation policy are not executable here. Work from the compact handoff; make a permitted change or resolve one concrete blocker.');
    } else if (preparation === 'PREPARED') {
      hints.push('Prepared fresh Main: execute the supplied plan against current worktree facts; direct repository inspection does not require an evidence-unlock transition.');
    } else if (preparation === 'PREPARATION_FALLBACK') {
      hints.push('Preparation fallback: no completed Planner handoff; follow the current runtime evidence permits before committing to a change.');
    }
    if (state === 'evidence_allowed') {
      hints.push('Evidence phase: answer the one outstanding question with a currently exposed inspection tool; do not treat this permit as a permanent tool grant.');
    } else if (state === 'action_required') {
      hints.push('Action-required phase: choose one exposed productive action without a prose-only investigation turn.');
    }
    const inspection = names.filter(name =>
      ['read', 'repo_search', 'indexed_repo_search', 'bash'].includes(name));
    if (inspection.length) {
      const descriptions = {
        read: 'known-path source text',
        repo_search: 'authoritative current-worktree text search',
        indexed_repo_search: 'fast indexed literal/path discovery',
        bash: 'bounded task-specific shell work (not a permission bypass)',
      };
      hints.push(`Direct inspection: ${inspection.map(name => `${name} for ${descriptions[name]}`).join('; ')}. Inspect exact target text before an anchored edit when needed.`);
    }
    append('lsp_start_server', 'For an uninitialized named-symbol semantic lookup, lsp_start_server is a one-shot setup using the configured server and exact workspace root; do not repeat a completed startup.');
    append('lsp_find_symbol', 'Use lsp_find_symbol for a named source symbol when semantic lookup is more useful than literal search.');
    const orbit = names.filter(name => /^(?:orbit_|mcp__.*orbit)/i.test(name));
    if (orbit.length) hints.push(`For structural/dependency questions that need indexing, use an appropriate exposed tool among: ${orbit.join(', ')}; confirm source text before mutation.`);
    append('need_more_evidence', 'If exactly one concrete fact blocks a safe action, need_more_evidence requests that fact; it is not required before already-exposed direct inspection.');
    append('subagents_enable', 'subagents_enable is a one-shot transition only if bounded delegated evidence is necessary; use the next request surface after it succeeds.');
    append('begin_coding_session', 'Use begin_coding_session when the next code mutation exceeds the normal Main response; transfer only compact new execution facts, not the parent transcript.');
    const edits = names.filter(name => ['structural_edit', 'safe_edit', 'edit', 'write'].includes(name));
    if (edits.length) {
      hints.push(`Mutation tools available: ${edits.join(', ')}. Prefer an exact structural or bounded edit when appropriate; a successful returned preview is enough to continue.`);
    }
    append('accept_mutation_scope', 'Before a new publishable path is mutated, accept_mutation_scope must record that task-specific path and rationale.');
    append('retry_last_failed_check', 'After fixing the exact unresolved check failure, use retry_last_failed_check for the same recorded verification scope rather than inventing a broader check.');
    append('run_check', 'Use focused run_check only for the currently permitted changed state; an infrastructure error does not authorize a shell workaround.');
    const recovery = names.filter(name => ['rollback_last_mutation', 'undo_mutation', 'recover_worktree'].includes(name));
    if (recovery.length) hints.push(`Recovery tools available: ${recovery.join(', ')}; select one only for its documented exact state, not speculative cleanup.`);
  }
  return hints.join(' ');
}

/**
 * Pi's serialized tool definitions have already been captured from the executor registry.
 * Intersect those definitions with the current phase's exposed tools; getAllTools() may
 * report a narrower inventory in delegated coding sessions and must not veto a definition.
 * Never inject a newly active tool into an already assembled provider request.
 */
export function reconcileProviderToolSurface(payload, { activeTools = [] } = {}) {
  if (!Array.isArray(payload?.tools)) return { payload };
  const active = new Set(activeTools);
  const tools = payload.tools.filter(tool => {
    const name = tool?.function?.name ?? tool?.name;
    return typeof name === 'string' && active.has(name);
  });
  return {
    payload: tools.length === payload.tools.length && tools.every((tool, i) => tool === payload.tools[i])
      ? payload
      : { ...payload, tools },
  };
}

/**
 * Keep the request-local capability guidance in ONE stable carrier: the final
 * serialized tool definition. Switching between message text and tool schema
 * changes a much earlier llama.cpp prompt prefix on tool-result turns.
 * An empty tool list has no schema carrier; fall back to an existing safe text
 * message without adding a chat role. Never modify tool results or linked
 * assistant calls. The dispatch gate remains authoritative either way.
 */
function replaceCapabilityTextSuffix(text, suffix) {
  const start = text.lastIndexOf(CAPABILITY_CONTRACT_START);
  const original = start >= 0 && text.endsWith(CAPABILITY_CONTRACT_END)
    ? text.slice(0, start)
    : text;
  return original + CAPABILITY_CONTRACT_START + suffix + CAPABILITY_CONTRACT_END;
}

function appendCapabilitySuffix(message, suffix, { responses = false } = {}) {
  if (!message || typeof message !== 'object') return null;
  if (responses && message.type === 'function_call_output') return null;
  if (responses && message.type !== 'message') return null;
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  // An assistant message can contain both text and tool_calls. Neither that
  // text nor its arguments are a safe instruction carrier while tool linkage
  // is pending. Fall back to an existing provider tool description instead.
  if (message.role === 'assistant' &&
      (message.tool_calls != null || message.function_call != null || message.tool_call_id != null)) return null;
  // Do not invent content on tool-call linkage or replace multimodal parts.
  if (typeof message.content === 'string') {
    const content = replaceCapabilityTextSuffix(message.content, suffix);
    return content === message.content ? message : { ...message, content };
  }
  if (!Array.isArray(message.content)) return null;
  const parts = message.content;
  const last = parts[parts.length - 1];
  const allowedTypes = responses ? ['input_text', 'output_text'] : ['text', 'input_text'];
  if (!last || !allowedTypes.includes(last.type) || typeof last.text !== 'string') return null;
  const text = replaceCapabilityTextSuffix(last.text, suffix);
  return text === last.text ? message
    : { ...message, content: [...parts.slice(0, -1), { ...last, text }] };
}

const CAPABILITY_CONTRACT_START = '\n\n[RUNTIME_PROVIDER_CAPABILITY_CONTRACT_START]\n';
const CAPABILITY_CONTRACT_END = '\n[RUNTIME_PROVIDER_CAPABILITY_CONTRACT_END]';

function appendToolDescriptionGuidance(payload, instructions) {
  const definitions = payload.tools;
  if (!Array.isArray(definitions) || definitions.length === 0) return payload;
  // Tool definitions are already reconciled against the active phase. Keep
  // the rest of the schema array intact for llama.cpp prefix-cache reuse.
  const index = definitions.findLastIndex(tool => {
    const definition = tool?.function ?? tool;
    return typeof definition?.name === 'string' && definition.name.length > 0;
  });
  if (index < 0) return payload;
  const current = definitions[index];
  const nested = current.function && typeof current.function === 'object';
  const definition = nested ? current.function : current;
  const description = typeof definition.description === 'string' ? definition.description : '';
  const start = description.lastIndexOf(CAPABILITY_CONTRACT_START);
  const original = start >= 0 && description.endsWith(CAPABILITY_CONTRACT_END)
    ? description.slice(0, start)
    : description;
  const next = original + CAPABILITY_CONTRACT_START + instructions + CAPABILITY_CONTRACT_END;
  if (description === next) return payload; // repeated provider hook: no double append
  const patchedDefinition = { ...definition, description: next };
  const patchedTool = nested ? { ...current, function: patchedDefinition } : patchedDefinition;
  return { ...payload, tools: [...definitions.slice(0, index), patchedTool, ...definitions.slice(index + 1)] };
}

export function withProviderCapabilityInstructions(payload, snapshot, { trustedRuntimeEnvelope = false, onMissingCarrier = null } = {}) {
  if (!payload || !snapshot || !trustedRuntimeEnvelope) return payload;
  const hasMessages = Array.isArray(payload.messages);
  const hasInput = Array.isArray(payload.input);
  if (hasMessages === hasInput) return payload; // unknown or ambiguous provider envelope
  // Trust comes from the installed Implementer runtime, not tool-result contents.
  // This also survives compaction that removes the original role overlay.
  const key = hasMessages ? 'messages' : 'input';
  const history = payload[key];
  if (history.length === 0) return payload; // no real conversation envelope to update
  // Never use snapshot.activeTools or a historical prompt as a source for
  // callable names. Derive both inventory and routing from the *final* payload.
  const executableTools = providerToolNames(payload)
    .filter(name => snapshot.executableTools?.includes(name));
  const explainDeferred = snapshot.explainDeferred === true;
  const deferred = explainDeferred
    ? (snapshot.deferredTools ?? []).filter(name => !executableTools.includes(name))
    : [];
  const instructions = [
    'RUNTIME EXECUTABLE TOOL CONTRACT (this provider request only):',
    activeToolGuidance(executableTools),
    'Earlier tool names in system contracts, task handoffs, or conversation history do not grant execution.',
    requestLocalToolUseGuidance(snapshot, executableTools),
    ...(deferred.length
      ? [`DEFERRED / NOT EXECUTABLE IN THIS REQUEST: ${deferred.join(', ')}. Do not call these now; only a subsequent provider request that actually lists a tool can enable its use.`]
      : []),
    'If a required capability is absent, use an exposed transition to a later request, or preserve the worktree and report the blocker. Never invent a tool or use unrestricted bash as a substitute.',
  ].filter(Boolean).join(' ');
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    // Always prefer the same tool-description carrier on every tool-bearing
    // request, regardless of whether the final turn is user, assistant or tool.
    const updated = appendToolDescriptionGuidance(payload, instructions);
    if (updated === payload && providerToolNames(payload).length === 0) {
      onMissingCarrier?.('no_serialized_tool_definition');
    }
    return updated;
  }
  const index = history.length - 1;
  const patchedLast = appendCapabilitySuffix(history[index], instructions, { responses: hasInput });
  if (!patchedLast) {
    onMissingCarrier?.('no_safe_text_or_tool_carrier');
    return payload;
  }
  return { ...payload, [key]: [...history.slice(0, index), patchedLast] };
}

/**
 * Classifies pi's `Tool X not found` result against the authoritative provider-request snapshot.
 * pi resolves tool calls against the turn context captured with the request, so:
 * - a tool the request advertised but pi cannot execute is a real tool-contract failure;
 * - a tool activated after the payload was assembled (deferred) is a lifecycle mismatch: pi exposes
 *   it from the next request;
 * - any other tool was never offered to the model and is an ordinary unavailable-tool attempt.
 * Without a snapshot nothing proves the tool was not advertised, so it stays a contract failure.
 */
export function classifyMissingExecutor(toolName, snapshot) {
  if (!snapshot || snapshot.executableTools?.includes(toolName)) return 'contract_failure';
  if (snapshot.deferredTools?.includes(toolName)) return 'deferred';
  return 'unavailable';
}

export function capabilitySnapshotGuidance(activeToolNames) {
  return `${activeToolGuidance(activeToolNames)} This capability snapshot is authoritative for this provider request. Tool names mentioned in earlier history or static contracts but absent from this list are not directly callable now; use only an exposed runtime transition to make another capability available.`;
}

export class SessionTransitions {
  constructor() {
    this.completed = new Map();
  }

  // Key of the one-shot transition a tool call represents, or null for ordinary tools.
  keyFor(toolName, input) {
    if (toolName === SUBAGENTS_ENABLE_TOOL) return SUBAGENTS_ENABLE_TOOL;
    if (toolName === LSP_START_TOOL) {
      const serverId = input?.server_id ?? '';
      const root = input?.workspace_root ?? '';
      if (!serverId || !root) return null;
      return `${LSP_START_TOOL}:${serverId}:${root}`;
    }
    return null;
  }

  has(key) {
    return key != null && this.completed.has(key);
  }

  // Returns the record when this call newly completed a transition, otherwise null.
  complete(key, detail = {}) {
    if (key == null || this.completed.has(key)) return null;
    const record = { key, ...detail };
    this.completed.set(key, record);
    return record;
  }

  // Tools that must disappear from the model's surface: global one-shots with nothing left to do.
  satisfiedToolNames() {
    const names = new Set();
    if (this.completed.has(SUBAGENTS_ENABLE_TOOL)) names.add(SUBAGENTS_ENABLE_TOOL);
    return names;
  }

  lines() {
    const lines = [];
    for (const record of this.completed.values()) {
      if (record.key === SUBAGENTS_ENABLE_TOOL) lines.push('- subagents: enabled');
      else if (record.key.startsWith(`${LSP_START_TOOL}:`)) {
        lines.push(`- ${record.serverId} LSP: running (workspace ${record.workspaceRoot})`);
      }
    }
    return lines;
  }

  verificationGuidance({ verificationTool = null, verificationState = null } = {}) {
    if (!verificationTool || !verificationState) return {
      progressLine: '- run validation',
      sentence: 'run validation',
    };
    if (verificationState === 'available') return {
      progressLine: `- run validation with ${verificationTool} (available once for the current mutation state)`,
      sentence: `run validation with ${verificationTool} while its current mutation permit is available`,
    };
    if (verificationState === 'exhausted') return {
      progressLine: `- ${verificationTool} is exhausted for the current mutation state; a new successful mutation is required before another focused verification`,
      sentence: `${verificationTool} is exhausted for the current mutation state; mutate successfully before validating again`,
    };
    return {
      progressLine: `- ${verificationTool} is not yet available; it becomes available after a successful mutation`,
      sentence: `${verificationTool} is not yet available; it becomes available after a successful mutation`,
    };
  }

  // Session-state block for the model; empty string when nothing has completed.
  stateBlock(verification = {}) {
    const lines = this.lines();
    if (!lines.length) return '';
    const validation = this.verificationGuidance(verification);
    const activeToolNames = verification?.activeToolNames ?? null;
    return [
      'SESSION STATE (runtime-generated; not task completion)',
      '',
      'Completed transitions:',
      ...lines,
      '',
      'These control transitions are already applied to this session. Do not repeat them.',
      'The GitHub issue itself is NOT complete.',
      ...(activeToolNames == null
        ? [
            '',
            'Valid next progress:',
            '- use only tools currently exposed by the runtime',
            validation.progressLine,
          ]
        : [
            '',
            activeToolGuidance(activeToolNames),
            `Verification status: ${validation.sentence}.`,
          ]),
    ].join('\n');
  }

  transitionNotice(record, verification = {}) {
    const subject = record.key === SUBAGENTS_ENABLE_TOOL
      ? 'subagents: enabled'
      : `${record.serverId} LSP: running`;
    const validation = this.verificationGuidance(verification);
    const activeToolNames = verification?.activeToolNames ?? null;
    const active = new Set(activeToolNames ?? []);
    const delegatedEvidence = record.key === SUBAGENTS_ENABLE_TOOL && activeToolNames != null
      ? (active.has('subagent')
        ? 'Delegated inspection is exposed now for the current evidence action.'
        : active.has('need_more_evidence')
          ? 'If delegated evidence is needed, call need_more_evidence first; the delegated-inspection tool will be exposed for that unlocked evidence action.'
          : '')
      : '';
    const tail = activeToolNames == null
      ? `Continue using only the current runtime tool surface; ${validation.sentence}.`
      : `${activeToolGuidance(activeToolNames)}${delegatedEvidence ? ` ${delegatedEvidence}` : ''} Verification status: ${validation.sentence}.`;
    return [
      'STATE TRANSITION COMPLETE (control transition only; the GitHub issue is not complete)',
      '',
      subject,
      'Result is already applied to this session.',
      `Do not call ${record.tool} again.`,
      '',
      tail,
    ].join('\n');
  }

  alreadySatisfiedReason(toolName, key, {
    actionRequired = false,
    verificationTool = null,
    verificationState = null,
    activeToolNames = null,
  } = {}) {
    const record = this.completed.get(key);
    const verification = { verificationTool, verificationState, activeToolNames };
    const validation = this.verificationGuidance(verification);
    const next = activeToolNames == null
      ? `Use only the current runtime tool surface; ${validation.sentence}.`
      : activeToolGuidance(activeToolNames);
    return `ALREADY_SATISFIED: ${toolName} is single-shot and already completed; it did not execute. ${this.transitionNotice(record, verification).split('\n').slice(2, 4).join(' ')} This repeat is not progress. ${next}`;
  }
}
