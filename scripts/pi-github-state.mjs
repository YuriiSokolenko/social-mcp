import { ISSUE_STATE_LABELS, REVIEW_LABELS, issueStateLabels } from './pi-state-machine.mjs';

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

export async function replaceIssueState(options) {
  return replaceStateLabels({ ...options, stateLabels: ISSUE_STATE_LABELS });
}

export async function replaceReviewState(options) {
  return replaceStateLabels({ ...options, stateLabels: REVIEW_LABELS });
}
