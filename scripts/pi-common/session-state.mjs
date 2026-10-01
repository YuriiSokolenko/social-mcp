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

  // Session-state block for the model; empty string when nothing has completed.
  stateBlock() {
    const lines = this.lines();
    if (!lines.length) return '';
    return [
      'SESSION STATE (runtime-generated; not task completion)',
      '',
      'Completed transitions:',
      ...lines,
      '',
      'These control transitions are already applied to this session. Do not repeat them.',
      'The GitHub issue itself is NOT complete.',
      '',
      'Valid next progress:',
      '- inspect/query repository',
      '- begin coding session when needed',
      '- mutate task files',
      '- run validation',
      '- submit terminal result',
    ].join('\n');
  }

  transitionNotice(record) {
    const subject = record.key === PREPARATION_KEY
      ? `preparation: ${record.fallback ? 'fallback-complete' : 'complete'}`
      : record.key === SUBAGENTS_ENABLE_TOOL
        ? 'subagents: enabled'
        : `${record.serverId} LSP: running`;
    const repeatTool = record.key === PREPARATION_KEY ? this.preparationTool : record.tool;
    const tail = record.key === SUBAGENTS_ENABLE_TOOL
      ? 'If subagent evidence is needed, call need_more_evidence first; subagent(...) is then permitted for that evidence action.\nOtherwise continue implementation.'
      : 'Continue with repository inspection, implementation, validation, or terminal result.';
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

  alreadySatisfiedReason(toolName, key, { actionRequired = false } = {}) {
    const record = this.completed.get(key);
    const next = actionRequired
      ? 'Mutate a task file, call begin_coding_session, run validation, or submit_result now.'
      : 'Inspect the repository, mutate task files, run validation, or submit_result.';
    return `ALREADY_SATISFIED: ${toolName} is single-shot and already completed; it did not execute. ${this.transitionNotice(record).split('\n').slice(2, 4).join(' ')} This repeat is not progress. ${next}`;
  }
}
