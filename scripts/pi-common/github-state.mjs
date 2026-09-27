import { ISSUE_STATE_LABELS, issueStateLabels } from './state-machine.mjs';

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

