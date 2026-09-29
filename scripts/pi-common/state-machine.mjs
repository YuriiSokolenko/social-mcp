/**
 * Canonical issue pipeline state machine.
 *
 * WHY: every stage must agree on the small set of ownership labels and legal
 * transitions. Keeping the rules here prevents Dispatcher, Implementer,
 * Architect and Reconciler from inventing slightly different state semantics.
 *
 * This module is deterministic and has no GitHub/network side effects.
 */

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
  'running-manual': PIPELINE_LABELS.running,
  'mr-created': PIPELINE_LABELS.pr,
  'needs-human': PIPELINE_LABELS.needsHuman,
  satisfied: null,
  stopped: null,
});
export function issueStateLabels(issue) {
  const labels = names(issue);
  return [...ISSUE_STATE_LABELS].filter(label => labels.has(label)).sort();
}

export function isIssueTransitionNoop(issue, _action) {
  return issue.state === 'closed';
}

export function validateIssueTransition(issue, action) {
  if (!(action in ISSUE_TRANSITIONS)) throw new Error(`unknown issue transition: ${action}`);
  const target = ISSUE_TRANSITIONS[action];
  const labels = names(issue);
  if (issue.state !== 'open') throw new Error(`cannot transition closed issue to ${target ?? 'unowned'}`);
  if (labels.has(PIPELINE_LABELS.epic)) throw new Error(`architect epic cannot transition to ${target ?? 'unowned'}`);
  if (action === 'satisfied' && !labels.has(PIPELINE_LABELS.running)) {
    throw new Error('satisfied requires pi:running');
  }
  if (action === 'stopped' && !labels.has(PIPELINE_LABELS.running) && !labels.has(PIPELINE_LABELS.architectReady)) {
    throw new Error('stopped requires pi:running or architect:ready');
  }
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
      labels.has(PIPELINE_LABELS.architectReady) ||
      labels.has(PIPELINE_LABELS.needsHuman) ||
      labels.has(PIPELINE_LABELS.queued);
    if (!allowedSource) {
      throw new Error('queued requires an unowned issue, pi:ready, architect:ready, pi:needs-human, or an idempotent dispatcher:ready state');
    }
  }
  if (action === 'running' && !labels.has(PIPELINE_LABELS.ready) && !labels.has(PIPELINE_LABELS.running)) {
    throw new Error('running requires pi:ready or an idempotent pi:running state');
  }
  if (action === 'running-manual' &&
      (labels.has(PIPELINE_LABELS.pr) || labels.has(PIPELINE_LABELS.architectReady))) {
    throw new Error('running-manual cannot steal pi:mr-created or architect:ready ownership');
  }
  if (action === 'mr-created' && !labels.has(PIPELINE_LABELS.running) && !labels.has(PIPELINE_LABELS.pr)) {
    throw new Error('mr-created requires pi:running or an idempotent pi:mr-created state');
  }
  if (action === 'needs-human' && labels.has(PIPELINE_LABELS.pr)) {
    throw new Error('needs-human cannot replace pi:mr-created; published PR ownership remains with the PR pipeline');
  }
  return target;
}

