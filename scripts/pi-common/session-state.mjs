// Runtime-owned record of completed one-shot control transitions (LSP startup, subagent
// enablement, preparation). The runtime knows these deterministically, so it materializes them
// into model-visible context and the active tool surface instead of trusting model memory.

export const SUBAGENTS_ENABLE_TOOL = 'subagents_enable';
export const LSP_START_TOOL = 'lsp_start_server';
export const PREPARATION_KEY = 'preparation';

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

export class SessionTransitions {
  constructor({ preparationTool = null } = {}) {
    this.preparationTool = preparationTool;
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
    if (this.preparationTool && toolName === this.preparationTool) return PREPARATION_KEY;
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
    if (this.preparationTool && this.completed.has(PREPARATION_KEY)) names.add(this.preparationTool);
    return names;
  }

  lines() {
    const lines = [];
    for (const record of this.completed.values()) {
      if (record.key === PREPARATION_KEY) lines.push(`- preparation: ${record.fallback ? 'fallback-complete' : 'complete'}`);
      else if (record.key === SUBAGENTS_ENABLE_TOOL) lines.push('- subagents: enabled');
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
            '- inspect/query repository',
            '- begin coding session when needed',
            '- mutate task files',
            validation.progressLine,
            '- submit terminal result',
          ]
        : [
            '',
            activeToolGuidance(activeToolNames),
            `Verification status: ${validation.sentence}.`,
          ]),
    ].join('\n');
  }

  transitionNotice(record, verification = {}) {
    const subject = record.key === PREPARATION_KEY
      ? `preparation: ${record.fallback ? 'fallback-complete' : 'complete'}`
      : record.key === SUBAGENTS_ENABLE_TOOL
        ? 'subagents: enabled'
        : `${record.serverId} LSP: running`;
    const repeatTool = record.key === PREPARATION_KEY ? this.preparationTool : record.tool;
    const validation = this.verificationGuidance(verification);
    const activeToolNames = verification?.activeToolNames ?? null;
    const tail = activeToolNames == null
      ? (record.key === SUBAGENTS_ENABLE_TOOL
        ? `If subagent evidence is needed, call need_more_evidence first; subagent(...) is then permitted for that evidence action.\nOtherwise continue implementation; ${validation.sentence}.`
        : `Continue with repository inspection or implementation; ${validation.sentence}; or submit the terminal result.`)
      : `${activeToolGuidance(activeToolNames)} Verification status: ${validation.sentence}.`;
    return [
      'STATE TRANSITION COMPLETE (control transition only; the GitHub issue is not complete)',
      '',
      subject,
      'Result is already applied to this session.',
      `Do not call ${repeatTool} again.`,
      '',
      tail,
    ].join('\n');
  }

  alreadySatisfiedReason(toolName, key, {
    actionRequired = false,
    verificationTool = null,
    verificationState = null,
  } = {}) {
    const record = this.completed.get(key);
    const verification = { verificationTool, verificationState };
    const validation = this.verificationGuidance(verification);
    const next = actionRequired
      ? `Mutate a task file, call begin_coding_session, or submit_result now; ${validation.sentence}.`
      : `Inspect the repository or mutate task files; ${validation.sentence}; or submit_result.`;
    return `ALREADY_SATISFIED: ${toolName} is single-shot and already completed; it did not execute. ${this.transitionNotice(record, verification).split('\n').slice(2, 4).join(' ')} This repeat is not progress. ${next}`;
  }
}
