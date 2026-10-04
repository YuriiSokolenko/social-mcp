import { submissionObligation } from './semantic-loop-guard.mjs';

const TERMINAL_TOOLS = new Set(['submit_result', 'submit_repair']);
function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => item.trim()))].sort();
}

function activeSet(value) {
  return new Set(uniqueStrings(value));
}

function compactArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function blocked(obligation, reason, extra = {}) {
  return {
    status: 'blocked',
    obligationKey: obligation?.key ?? null,
    obligationKind: obligation?.kind ?? 'unknown',
    reason,
    ...extra,
  };
}

function repair(obligation, kind, tool, extra = {}) {
  return {
    status: 'repair',
    obligationKey: obligation.key,
    obligationKind: obligation.kind,
    kind,
    tool,
    ...extra,
  };
}

function cleanupExpectedFiles(currentChangedFiles, target) {
  return uniqueStrings(currentChangedFiles).filter(file => file !== target);
}

function driftForPath(drift, target) {
  return (Array.isArray(drift) ? drift : []).find(item => item?.path === target) ?? null;
}

/**
 * Select one minimal, capability-valid next action for a repeated terminal failure.
 *
 * The caller supplies trusted current repository facts. This function never widens task scope:
 * accepted unexpected paths can be added to submit metadata, while scratch/temporary/unaccepted
 * paths must be cleaned or reported blocked.
 */
export function selectTerminalRecovery({
  obligation,
  terminalInput = {},
  activeToolNames = [],
  currentChangedFiles = [],
  drift = [],
  acceptedPaths = [],
} = {}) {
  if (!obligation?.key) return blocked(obligation, 'The failed terminal submission has no stable unresolved-obligation identity.');

  const active = activeSet(activeToolNames);
  const current = uniqueStrings(currentChangedFiles);
  const accepted = new Set(uniqueStrings(acceptedPaths));

  if (obligation.kind === 'metadata') {
    if (!active.has('submit_result')) {
      return blocked(obligation, 'submit_result is not executable in the current capability snapshot.', {
        requiredTool: 'submit_result',
      });
    }
    return repair(obligation, 'metadata_retry', 'submit_result', {
      previousInput: compactArgs(terminalInput),
      missingFields: uniqueStrings(obligation.missingFields),
    });
  }

  if (obligation.kind === 'validation') {
    const action = obligation.action && typeof obligation.action === 'object'
      ? compactArgs({
          kind: obligation.action.kind,
          paths: uniqueStrings(obligation.action.paths),
          targets: uniqueStrings(obligation.action.targets),
          profile: obligation.action.profile || undefined,
        })
      : null;
    if (!action?.kind) {
      return blocked(obligation, 'The validation obligation did not provide an authoritative check action.');
    }
    if (!active.has('run_check')) {
      return blocked(obligation, 'run_check is not executable in the current capability snapshot.', {
        requiredTool: 'run_check',
        check: action,
      });
    }
    return repair(obligation, 'exact_validation', 'run_check', { args: action });
  }

  if (obligation.kind === 'prepared_outputs') {
    const target = uniqueStrings(obligation.missingOutputs)[0] ?? null;
    if (!target) return blocked(obligation, 'The prepared-output obligation names no missing output path.');
    if (active.has('write')) {
      return repair(obligation, 'create_prepared_output', 'write', {
        target,
        args: { path: target },
        incompleteArgs: ['content'],
      });
    }
    if (active.has('begin_coding_session')) {
      return repair(obligation, 'create_prepared_output_session', 'begin_coding_session', {
        target,
        args: {
          reason: `Create required prepared output ${target} without reopening exploration.`,
          required_capability: 'write',
        },
      });
    }
    return blocked(obligation, `Required prepared output ${target} is missing, but neither write nor a capability-valid coding-session transition is exposed.`, {
      target,
      requiredTool: 'write',
    });
  }

  if (obligation.kind === 'conflict') {
    const target = uniqueStrings(obligation.conflictPaths)[0] ?? null;
    if (!target) return blocked(obligation, 'The merge-conflict obligation names no conflict path.');
    if (active.has('read')) {
      return repair(obligation, 'inspect_conflict', 'read', { target, args: { path: target } });
    }
    if (active.has('need_more_evidence')) {
      return repair(obligation, 'inspect_conflict_transition', 'need_more_evidence', {
        target,
        args: {
          missing: `current conflict markers in ${target}`,
          reason: 'Resolve the named latest-dev conflict without changing unrelated files.',
        },
      });
    }
    return blocked(obligation, `Conflict path ${target} cannot be inspected with the current capability snapshot; refusing a blind mutation.`, {
      target,
      requiredTool: 'read',
    });
  }

  if (obligation.kind === 'file_set' || obligation.kind === 'file_set_cleanup') {
    const scratch = new Set(uniqueStrings(obligation.scratch));
    const unexpected = uniqueStrings(obligation.unexpected);
    const missing = uniqueStrings(obligation.missing);
    const cleanupPaths = uniqueStrings([
      ...scratch,
      ...unexpected.filter(file => !accepted.has(file)),
    ]);
    const acceptedUnexpected = unexpected.filter(file => accepted.has(file) && !scratch.has(file));

    if (cleanupPaths.length) {
      const target = cleanupPaths[0];
      const classified = driftForPath(drift, target);
      const expectedFiles = cleanupExpectedFiles(current, target);
      if (classified?.action === 'undo_mutation') {
        if (!active.has('undo_mutation')) {
          return blocked(obligation, `Accidental path ${target} is journaled, but undo_mutation is not executable now.`, {
            target,
            requiredTool: 'undo_mutation',
            mutationId: classified.mutation_id ?? null,
          });
        }
        if (!classified.mutation_id) {
          return blocked(obligation, `Accidental path ${target} is journaled but has no usable mutation id.`, { target });
        }
        return repair(obligation, 'targeted_cleanup', 'undo_mutation', {
          target,
          args: {
            mutation_id: classified.mutation_id,
            expected_files: expectedFiles,
            reason: `Resolve repeated terminal file-set obligation for ${target}`,
          },
        });
      }
      if (classified?.action === 'recover_worktree') {
        if (!active.has('recover_worktree')) {
          return blocked(obligation, `Accidental path ${target} has a trusted worktree recovery action, but recover_worktree is not executable now.`, {
            target,
            requiredTool: 'recover_worktree',
          });
        }
        return repair(obligation, 'targeted_cleanup', 'recover_worktree', {
          target,
          args: {
            action: classified.recover_action,
            path: target,
            expected_files: expectedFiles,
            reason: `Resolve repeated terminal file-set obligation for ${target}`,
          },
        });
      }
      return blocked(obligation, `The repeated terminal file-set failure contains accidental path ${target}, but trusted ownership evidence cannot select a safe cleanup action.`, {
        target,
        drift: classified,
      });
    }

    if (missing.length || acceptedUnexpected.length) {
      if (!active.has('submit_result')) {
        return blocked(obligation, 'The file-set obligation is metadata-only, but submit_result is not executable now.', {
          requiredTool: 'submit_result',
        });
      }
      return repair(obligation, 'file_set_metadata_retry', 'submit_result', {
        previousInput: compactArgs(terminalInput),
        files: current,
        missing,
        acceptedUnexpected,
      });
    }

    return blocked(obligation, 'The file-set obligation remains unresolved but no cleanup or metadata delta can be derived from trusted current state.');
  }

  return blocked(obligation, `No deterministic repair mapping exists for terminal failure code ${obligation.code ?? 'unknown'}.`, {
    code: obligation.code ?? null,
  });
}

export function terminalRecoveryGuidance(plan) {
  const marker = `RUNTIME TERMINAL RECOVERY [${plan?.obligationKey ?? 'unknown'}]`;
  if (!plan || plan.status === 'blocked') {
    return `${marker}: BLOCKED. ${plan?.reason ?? 'No deterministic recovery plan is available.'} Preserve the current worktree/checkpoint; do not widen scope, discard working code, or claim completion.`;
  }

  if (plan.kind === 'metadata_retry') {
    const fields = plan.missingFields.length ? plan.missingFields.join(', ') : '(unknown fields)';
    return `${marker}: deterministic metadata repair selected. Retry submit_result now using the previous submission as the base and fill exactly these missing publication fields: ${fields}. Do not explore, mutate files, or launch a coding session first.`;
  }
  if (plan.kind === 'file_set_metadata_retry') {
    return `${marker}: deterministic file-set metadata repair selected. Retry submit_result now, preserve the previous submission metadata, and set files exactly to ${JSON.stringify(plan.files)}. These paths come from the current canonical changed-file set; do not authorize unrelated scratch files.`;
  }
  if (plan.kind === 'create_prepared_output') {
    return `${marker}: deterministic prepared-output repair selected. Call write next for ${plan.target}; provide only the task-required file content. Do not resubmit or explore first.`;
  }

  const args = plan.args ? JSON.stringify(plan.args) : '{}';
  return `${marker}: deterministic ${plan.kind} repair selected. Call ${plan.tool}(${args}) next. Do not replay submit_result, broaden validation, explore unrelated files, or launch an equivalent incapable fork before this action completes.`;
}

function terminalToolCallNames(messages) {
  const names = new Map();
  for (const message of messages) {
    if (!Array.isArray(message?.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const id = typeof call?.id === 'string' ? call.id : null;
      const name = call?.function?.name ?? call?.name;
      if (id && typeof name === 'string') names.set(id, name);
    }
  }
  return names;
}

function terminalResultFromMessage(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return { content: message.content };
  return message;
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('\n');
  }
  return '';
}

function replaceMessageText(message, text) {
  if (Array.isArray(message?.content)) {
    return { ...message, content: [{ type: 'text', text }] };
  }
  return { ...message, content: text };
}

/**
 * Preserve tool-call pairing while compacting obsolete copies of the same terminal failure.
 * Task/user acceptance messages, mutation provenance, validation evidence and the newest failure
 * remain untouched. Only older equivalent submit_result/submit_repair diagnostics and older
 * runtime recovery directives for this exact obligation are replaced by a short marker.
 */
export function compactTerminalRecoveryPayload(payload, recoveryState) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.messages) ||
    !recoveryState?.obligationKey
  ) {
    return payload;
  }

  const names = terminalToolCallNames(payload.messages);
  const matchingToolIndexes = [];
  const matchingRecoveryIndexes = [];

  for (let index = 0; index < payload.messages.length; index += 1) {
    const message = payload.messages[index];
    const name = message?.name ?? names.get(message?.tool_call_id);
    if (message?.role === 'tool' && TERMINAL_TOOLS.has(name)) {
      const obligation = submissionObligation(terminalResultFromMessage(message));
      if (obligation?.key === recoveryState.obligationKey) matchingToolIndexes.push(index);
    }
    if (
      message?.role === 'user' &&
      messageText(message).startsWith(`RUNTIME TERMINAL RECOVERY [${recoveryState.obligationKey}]`)
    ) {
      matchingRecoveryIndexes.push(index);
    }
  }

  if (matchingToolIndexes.length <= 1 && matchingRecoveryIndexes.length <= 1) return payload;

  const keepTool = matchingToolIndexes.at(-1);
  const keepRecovery = matchingRecoveryIndexes.at(-1);
  const toolSet = new Set(matchingToolIndexes.filter(index => index !== keepTool));
  const recoverySet = new Set(matchingRecoveryIndexes.filter(index => index !== keepRecovery));
  const marker = `[superseded repeated terminal diagnostic for obligation ${recoveryState.obligationKey}; use the newest terminal failure and runtime recovery directive]`;

  const messages = payload.messages.map((message, index) => {
    if (toolSet.has(index) || recoverySet.has(index)) return replaceMessageText(message, marker);
    return message;
  });
  return { ...payload, messages };
}
