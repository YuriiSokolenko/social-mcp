/**
 * Shared optimistic state mutation primitives for GitHub labels.
 *
 * WHY: pipeline ownership is encoded in labels, so a stale workflow must not
 * silently overwrite a newer owner's state. replaceStateLabels() reloads the
 * object immediately before mutation and compares the state-label snapshot.
 *
 * GUARANTEE: concurrent ownership changes fail instead of being lost.
 *
 * NOT FOR: deciding which transition is legal; state-machine.mjs owns that.
 */

import { ISSUE_STATE_LABELS, issueStateLabels, validateIssueTransition } from './state-machine.mjs';

export function labelNames(item) {
  return (item?.labels ?? []).map(label => typeof label === 'string' ? label : label.name);
}

export function stateSnapshot(item, stateLabels) {
  if (stateLabels === ISSUE_STATE_LABELS) return issueStateLabels(item);
  const names = new Set(labelNames(item));
  return [...stateLabels].filter(label => names.has(label)).sort();
}

export async function replaceStateLabels({
  number, expected, target = null, stateLabels, load, patch,
  context = 'pipeline', validateCurrent,
}) {
  const current = await load(number);
  if (validateCurrent) validateCurrent(current);
  const expectedState = stateSnapshot(expected, stateLabels);
  const currentState = stateSnapshot(current, stateLabels);
  if (JSON.stringify(expectedState) !== JSON.stringify(currentState)) {
    throw new Error(`concurrent ${context} transition on #${number}: expected [${expectedState}], found [${currentState}]`);
  }
  const keep = labelNames(current).filter(label => !stateLabels.has(label));
  const labels = target == null ? keep : [...new Set([...keep, target])];
  await patch(number, labels, current);
  return { current, labels };
}

export function stateTargetAfterRemovals(item, removals, stateLabels) {
  const removed = new Set(removals);
  const remaining = stateSnapshot(item, stateLabels).filter(label => !removed.has(label));
  if (remaining.length > 1) {
    throw new Error(`state repair would remain ambiguous: [${remaining}]`);
  }
  return remaining[0] ?? null;
}

export function issueTargetAfterRemovals(item, removals) {
  return stateTargetAfterRemovals(item, removals, ISSUE_STATE_LABELS);
}

export async function replaceIssueState(options) {
  return replaceStateLabels({ ...options, stateLabels: ISSUE_STATE_LABELS });
}

/**
 * The plain issue label `load`/`patch` pair for replaceIssueState(), over a
 * githubClient().api-style `api(path, method, body)`.
 */
export function issueStateIo(api) {
  return {
    load: number => api(`/issues/${number}`),
    patch: (number, labels) => api(`/issues/${number}`, 'PATCH', { labels }),
  };
}

/**
 * Fresh read -> state-machine validation of `action` -> compare-and-swap label
 * replacement. `context` names the stage in concurrency errors.
 */
export async function transitionIssueState({ api, number, action, context }) {
  const expected = await api(`/issues/${number}`);
  const target = validateIssueTransition(expected, action);
  return replaceIssueState({ number, expected, target, context, ...issueStateIo(api) });
}

