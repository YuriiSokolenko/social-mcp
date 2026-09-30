/**
 * Canonical helpers for the small PR review-label family.
 *
 * PR pipeline ownership uses exactly two verdict labels. These pure functions
 * prevent Reviewer, PR Fix, PR Guard and Merge Gate from each implementing
 * their own filtering/append rules.
 */
import { projectConfig } from './project-config.mjs';

const { reviewPassed, reviewChangesRequested } = projectConfig().labels;
export const REVIEW_PASSED = reviewPassed;
export const REVIEW_CHANGES_REQUESTED = reviewChangesRequested;
export const REVIEW_LABELS = new Set([REVIEW_PASSED, REVIEW_CHANGES_REQUESTED]);

// Verdict labels normally share one namespace ("review:"). Clearing that whole
// namespace also removes stale look-alikes; without a shared namespace only the
// two configured verdict labels are removed.
const reviewNamespace = (() => {
  const [a, b] = [REVIEW_PASSED, REVIEW_CHANGES_REQUESTED].map(label => label.slice(0, label.indexOf(':') + 1));
  return a && a === b ? a : null;
})();
const isReviewLabel = label => REVIEW_LABELS.has(label) || (reviewNamespace !== null && label.startsWith(reviewNamespace));

export function prLabelNames(pr) {
  return (pr?.labels ?? []).map(label => typeof label === 'string' ? label : label.name);
}

export function withoutReviewLabels(prOrLabels) {
  const names = Array.isArray(prOrLabels) ? prOrLabels.map(x => typeof x === 'string' ? x : x.name) : prLabelNames(prOrLabels);
  return names.filter(label => !isReviewLabel(label));
}

export function withReviewVerdict(prOrLabels, verdict) {
  if (!REVIEW_LABELS.has(verdict)) throw new Error(`unknown review verdict label: ${verdict}`);
  return [...withoutReviewLabels(prOrLabels), verdict];
}
