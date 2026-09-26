export const PIPELINE_LABELS = Object.freeze({
  queued: 'dispatcher:ready',
  ready: 'pi:ready',
  running: 'pi:running',
  pr: 'pi:mr-created',
  needsHuman: 'pi:needs-human',
  architectReady: 'architect:ready',
  epic: 'architect:epic',
});

export const ISSUE_ACTIVE = new Set([
  PIPELINE_LABELS.ready, PIPELINE_LABELS.running, PIPELINE_LABELS.pr, PIPELINE_LABELS.architectReady,
]);

export const ISSUE_TERMINAL = new Set([
  PIPELINE_LABELS.needsHuman,
]);

export const ISSUE_STATE_LABELS = new Set([
  PIPELINE_LABELS.queued,
  PIPELINE_LABELS.ready, PIPELINE_LABELS.running, PIPELINE_LABELS.pr, PIPELINE_LABELS.architectReady,
  ...ISSUE_TERMINAL,
]);

const names = issue => new Set((issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name));

export function inspectIssueState(issue, { hasOpenPiPr = false, hasLiveImplementer = undefined, hasLiveArchitect = undefined, hasCheckpoint = false } = {}) {
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
    const precedence = [
      PIPELINE_LABELS.pr, PIPELINE_LABELS.running, PIPELINE_LABELS.architectReady, PIPELINE_LABELS.ready,
    ];
    const keep = precedence.find(label => labels.has(label));
    findings.push({ code: 'multiple-active', severity: 'repair', labels: active,
      remove: active.filter(label => label !== keep), keep });
  }
  if (labels.has(PIPELINE_LABELS.pr) && !hasOpenPiPr && issue.state === 'open') {
    findings.push({ code: 'mr-label-without-open-pr', severity: 'warning' });
  }
  if (issue.state === 'open' && labels.has(PIPELINE_LABELS.running) && hasLiveImplementer === false) {
    findings.push({ code: 'orphaned-implementer-state', severity: 'repair',
      remove: [PIPELINE_LABELS.running], checkpoint: hasCheckpoint });
  }
  if (issue.state === 'open' && labels.has(PIPELINE_LABELS.architectReady) && hasLiveArchitect === false) {
    findings.push({ code: 'orphaned-architect-state', severity: 'repair',
      remove: [PIPELINE_LABELS.architectReady] });
  }
  if (hasCheckpoint && issue.state === 'open' && !labels.has(PIPELINE_LABELS.running) && terminal.length === 0) {
    findings.push({ code: 'checkpoint-without-live-implementer', severity: 'warning' });
  }
  return findings;
}

export function safeRemovals(findings) {
  return [...new Set(findings.filter(item => item.severity === 'repair').flatMap(item => item.remove ?? []))];
}

export const ISSUE_TRANSITIONS = Object.freeze({
  queued: PIPELINE_LABELS.queued,
  ready: PIPELINE_LABELS.ready,
  'architect-ready': PIPELINE_LABELS.architectReady,
  running: PIPELINE_LABELS.running,
  'mr-created': PIPELINE_LABELS.pr,
  'needs-human': PIPELINE_LABELS.needsHuman,
});
export function issueStateLabels(issue) {
  const labels = names(issue);
  return [...ISSUE_STATE_LABELS].filter(label => labels.has(label)).sort();
}

export function validateIssueTransition(issue, action) {
  const target = ISSUE_TRANSITIONS[action];
  if (!target) throw new Error(`unknown issue transition: ${action}`);
  const labels = names(issue);
  if (issue.state !== 'open') throw new Error(`cannot transition closed issue to ${target}`);
  if (labels.has(PIPELINE_LABELS.epic)) throw new Error(`architect epic cannot transition to ${target}`);
  if (action === 'ready' && !labels.has(PIPELINE_LABELS.queued) && !labels.has(PIPELINE_LABELS.ready)) {
    throw new Error('ready requires dispatcher:ready or an idempotent pi:ready state');
  }
  if (action === 'architect-ready' && !labels.has(PIPELINE_LABELS.queued) && !labels.has(PIPELINE_LABELS.architectReady)) {
    throw new Error('architect-ready requires dispatcher:ready or an idempotent architect:ready state');
  }
  if (action === 'queued') {
    const owned = [...ISSUE_STATE_LABELS].filter(label => labels.has(label));
    const allowedSource = owned.length === 0 ||
      labels.has(PIPELINE_LABELS.ready) ||
      labels.has(PIPELINE_LABELS.running) ||
      labels.has(PIPELINE_LABELS.architectReady) ||
      labels.has(PIPELINE_LABELS.needsHuman) ||
      labels.has(PIPELINE_LABELS.queued);
    if (!allowedSource) {
      throw new Error('queued requires an unowned issue, pi:ready, pi:running, architect:ready, pi:needs-human, or an idempotent dispatcher:ready state');
    }
  }
  if (action === 'running' && !labels.has(PIPELINE_LABELS.ready) && !labels.has(PIPELINE_LABELS.running)) {
    throw new Error('running requires pi:ready or an idempotent pi:running state');
  }
  if (action === 'mr-created' && !labels.has(PIPELINE_LABELS.running) && !labels.has(PIPELINE_LABELS.pr)) {
    throw new Error('mr-created requires pi:running or an idempotent pi:mr-created state');
  }
  if (action === 'needs-human' && labels.has(PIPELINE_LABELS.pr)) {
    throw new Error('needs-human cannot replace pi:mr-created; PR failures are tracked by SHA-bound statuses');
  }
  return target;
}

