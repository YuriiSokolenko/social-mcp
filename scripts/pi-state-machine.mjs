export const PIPELINE_LABELS = Object.freeze({
  queued: 'dispatcher:ready',
  ready: 'pi:ready',
  running: 'pi:running',
  pr: 'pi:mr-created',
  blocked: 'pi:blocked',
  failed: 'pi:failed',
  needsHuman: 'pi:needs-human',
  cancelled: 'pi:cancelled',
  architectReady: 'architect:ready',
  epic: 'architect:epic',
  reviewReady: 'review:ready',
  reviewRunning: 'review:running',
  reviewPassed: 'review:passed',
  reviewChanges: 'review:changes-requested',
  reviewFailed: 'review:failed',
});

export const ISSUE_ACTIVE = new Set([
  PIPELINE_LABELS.ready, PIPELINE_LABELS.running, PIPELINE_LABELS.pr, PIPELINE_LABELS.architectReady,
]);

export const ISSUE_TERMINAL = new Set([
  PIPELINE_LABELS.blocked, PIPELINE_LABELS.failed, PIPELINE_LABELS.needsHuman, PIPELINE_LABELS.cancelled,
]);

export const REVIEW_LABELS = new Set([
  PIPELINE_LABELS.reviewReady, PIPELINE_LABELS.reviewRunning, PIPELINE_LABELS.reviewPassed,
  PIPELINE_LABELS.reviewChanges, PIPELINE_LABELS.reviewFailed,
]);

const names = issue => new Set((issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name));

export function inspectIssueState(issue, { hasOpenPiPr = false } = {}) {
  const labels = names(issue);
  const findings = [];
  const active = [...ISSUE_ACTIVE].filter(label => labels.has(label));
  const terminal = [...ISSUE_TERMINAL].filter(label => labels.has(label));

  if (issue.state === 'closed' && (active.length || labels.has(PIPELINE_LABELS.queued))) {
    findings.push({ code: 'closed-active', severity: 'repair',
      remove: [...active, PIPELINE_LABELS.queued].filter(label => labels.has(label)) });
  }
  if (issue.state === 'open' && labels.has(PIPELINE_LABELS.epic) &&
      (labels.has(PIPELINE_LABELS.queued) || active.length || terminal.length)) {
    findings.push({ code: 'epic-executable', severity: 'repair',
      remove: [PIPELINE_LABELS.queued, ...active, ...terminal].filter(label => labels.has(label)) });
  }
  if (terminal.length && (labels.has(PIPELINE_LABELS.queued) || active.length)) {
    findings.push({ code: 'terminal-active', severity: 'repair',
      remove: [PIPELINE_LABELS.queued, ...active].filter(label => labels.has(label)) });
  }
  if (labels.has(PIPELINE_LABELS.queued) && active.length) {
    findings.push({ code: 'queued-active', severity: 'repair', remove: [PIPELINE_LABELS.queued] });
  }
  if (active.length > 1) {
    findings.push({ code: 'multiple-active', severity: 'warning', labels: active });
  }
  if (labels.has(PIPELINE_LABELS.pr) && !hasOpenPiPr && issue.state === 'open') {
    findings.push({ code: 'mr-label-without-open-pr', severity: 'warning' });
  }
  return findings;
}

export function inspectPrState(pr) {
  const labels = names(pr);
  const review = [...REVIEW_LABELS].filter(label => labels.has(label));
  const findings = [];
  if (review.length > 1) findings.push({ code: 'multiple-review-states', severity: 'warning', labels: review });
  if (pr.state !== 'open' && review.some(label => label === PIPELINE_LABELS.reviewRunning || label === PIPELINE_LABELS.reviewReady)) {
    findings.push({ code: 'closed-pr-active-review', severity: 'repair',
      remove: review.filter(label => label === PIPELINE_LABELS.reviewRunning || label === PIPELINE_LABELS.reviewReady) });
  }
  return findings;
}

export function safeRemovals(findings) {
  return [...new Set(findings.filter(item => item.severity === 'repair').flatMap(item => item.remove ?? []))];
}
