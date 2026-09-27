/**
 * Canonical helpers for the small PR review-label family.
 *
 * PR pipeline ownership uses exactly two verdict labels. These pure functions
 * prevent Reviewer, PR Fix, PR Guard and Merge Gate from each implementing
 * their own filtering/append rules.
 */
export const REVIEW_LABELS = new Set(['review:passed', 'review:changes-requested']);

export function prLabelNames(pr) {
  return (pr?.labels ?? []).map(label => typeof label === 'string' ? label : label.name);
}

export function withoutReviewLabels(prOrLabels) {
  const names = Array.isArray(prOrLabels) ? prOrLabels.map(x => typeof x === 'string' ? x : x.name) : prLabelNames(prOrLabels);
  return names.filter(label => !label.startsWith('review:'));
}

export function withReviewVerdict(prOrLabels, verdict) {
  if (!REVIEW_LABELS.has(verdict)) throw new Error(`unknown review verdict label: ${verdict}`);
  return [...withoutReviewLabels(prOrLabels), verdict];
}
