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
 * Provider-request definitions may already have been captured before a runtime phase transition.
 * Narrow them to the tool names still permitted AND installed in the host executor. Never
 * inject a tool definition into an existing request: newly enabled tools need another request.
 */
export function reconcileProviderToolSurface(payload, { activeTools = [], registeredTools = null } = {}) {
  if (!Array.isArray(payload?.tools)) return { payload, unregistered: [] };
  const active = new Set(activeTools);
  const registered = Array.isArray(registeredTools) ? new Set(registeredTools) : null;
  const unregistered = [];
  const tools = payload.tools.filter(tool => {
    const name = tool?.function?.name ?? tool?.name;
    if (!name || !active.has(name)) return false;
    if (registered && !registered.has(name)) {
      unregistered.push(name);
      return false;
    }
    return true;
  });
  return {
    payload: tools.length === payload.tools.length && tools.every((tool, i) => tool === payload.tools[i])
      ? payload
      : { ...payload, tools },
    unregistered: [...new Set(unregistered)],
  };
}

/**
 * A short, request-local instruction is appended ONLY to the serialized provider payload,
 * not Pi's saved conversation. This supersedes generic tool names in a Main/coding contract
 * and stale handoff/history without granting any new capability or moving linked tool turns.
 */
export function withProviderCapabilityInstructions(payload, snapshot) {
  if (!payload || !snapshot) return payload;
  const hasMessages = Array.isArray(payload.messages);
  const hasInput = Array.isArray(payload.input);
  if (hasMessages === hasInput) return payload; // unknown or ambiguous provider envelope
  const deferred = (snapshot.deferredTools ?? [])
    .filter(name => !snapshot.executableTools.includes(name));
  const instructions = [
    'RUNTIME EXECUTABLE TOOL CONTRACT (this provider request only):',
    activeToolGuidance(snapshot.executableTools),
    'Earlier tool names in system contracts, task handoffs, or conversation history do not grant execution.',
    ...(deferred.length
      ? [`DEFERRED / NOT EXECUTABLE IN THIS REQUEST: ${deferred.join(', ')}. Do not call these now; only a subsequent provider request that actually lists a tool can enable its use.`]
      : []),
    'If a required capability is absent, use an exposed transition to a later request, or preserve the worktree and report the blocker. Never invent a tool or use unrestricted bash as a substitute.',
  ].join(' ');
  if (hasMessages) return { ...payload, messages: [...payload.messages, { role: 'user', content: instructions }] };
  return {
    ...payload,
    input: [...payload.input, { type: 'message', role: 'user', content: [{ type: 'input_text', text: instructions }] }],
  };
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
