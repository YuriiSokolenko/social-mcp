/**
 * Canonical issue pipeline state machine.
 *
 * WHY: every stage must agree on the small set of ownership labels and legal
 * transitions. Keeping the rules here prevents Dispatcher, Implementer,
 * Architect and Reconciler from inventing slightly different state semantics.
 *
 * This module is deterministic and has no GitHub/network side effects.
 */

import { projectConfig } from './project-config.mjs';

// Label NAMES are project configuration; the roles below are the harness vocabulary.
const configuredLabels = projectConfig().labels;
export const PIPELINE_LABELS = Object.freeze({
  queued: configuredLabels.queued,
  ready: configuredLabels.ready,
  running: configuredLabels.running,
  pr: configuredLabels.pr,
  needsHuman: configuredLabels.needsHuman,
  blocked: configuredLabels.blocked,
  architectReady: configuredLabels.architectReady,
  epic: configuredLabels.epic,
});

export const ISSUE_ACTIVE = new Set([
  PIPELINE_LABELS.ready, PIPELINE_LABELS.running, PIPELINE_LABELS.pr, PIPELINE_LABELS.architectReady,
]);

export const ISSUE_TERMINAL = new Set([
  PIPELINE_LABELS.needsHuman,
  ...(PIPELINE_LABELS.blocked ? [PIPELINE_LABELS.blocked] : []),
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
  if (terminal.length > 1) {
    const keep = terminal.includes(PIPELINE_LABELS.blocked) ? PIPELINE_LABELS.blocked : terminal[0];
    findings.push({ code: 'multiple-terminal', severity: 'repair', labels: terminal,
      remove: terminal.filter(label => label !== keep), keep });
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
  if (PIPELINE_LABELS.blocked && labels.has(PIPELINE_LABELS.blocked)) {
    const executable = ['queued', 'ready', 'running', 'running-manual', 'architect-ready'];
    if (executable.includes(action)) {
      throw new Error(`blocked issue cannot transition to executable state ${target ?? 'unowned'}; remove ${PIPELINE_LABELS.blocked} explicitly first`);
    }
    // A human block is durable even if an already-running workflow reaches a
    // cleanup/publication transition. Let that workflow finish successfully
    // without replacing the manual block with another pipeline state.
    return PIPELINE_LABELS.blocked;
  }
  if (labels.has(PIPELINE_LABELS.needsHuman) && ['ready', 'running', 'architect-ready'].includes(action)) {
    throw new Error(`${PIPELINE_LABELS.needsHuman} issue requires an explicit retry before transition to ${target ?? 'unowned'}`);
  }
  if (action === 'satisfied' && !labels.has(PIPELINE_LABELS.running)) {
    throw new Error(`satisfied requires ${PIPELINE_LABELS.running}`);
  }
  if (action === 'stopped' && !labels.has(PIPELINE_LABELS.running) && !labels.has(PIPELINE_LABELS.architectReady)) {
    throw new Error(`stopped requires ${PIPELINE_LABELS.running} or ${PIPELINE_LABELS.architectReady}`);
  }
  if (action === 'ready' && !labels.has(PIPELINE_LABELS.queued) && !labels.has(PIPELINE_LABELS.ready)) {
    throw new Error(`ready requires ${PIPELINE_LABELS.queued} or an idempotent ${PIPELINE_LABELS.ready} state`);
  }
  if (action === 'architect-ready' && !labels.has(PIPELINE_LABELS.queued) && !labels.has(PIPELINE_LABELS.architectReady)) {
    throw new Error(`architect-ready requires ${PIPELINE_LABELS.queued} or an idempotent ${PIPELINE_LABELS.architectReady} state`);
  }
  if (action === 'queued') {
    const owned = [...ISSUE_STATE_LABELS].filter(label => labels.has(label));
    const allowedSource = owned.length === 0 ||
      labels.has(PIPELINE_LABELS.ready) ||
      labels.has(PIPELINE_LABELS.architectReady) ||
      labels.has(PIPELINE_LABELS.needsHuman) ||
      labels.has(PIPELINE_LABELS.queued);
    if (!allowedSource) {
      throw new Error(`queued requires an unowned issue, ${PIPELINE_LABELS.ready}, ${PIPELINE_LABELS.architectReady}, ${PIPELINE_LABELS.needsHuman}, or an idempotent ${PIPELINE_LABELS.queued} state`);
    }
  }
  if (action === 'running' && !labels.has(PIPELINE_LABELS.ready) && !labels.has(PIPELINE_LABELS.running)) {
    throw new Error(`running requires ${PIPELINE_LABELS.ready} or an idempotent ${PIPELINE_LABELS.running} state`);
  }
  if (action === 'running-manual' &&
      (labels.has(PIPELINE_LABELS.pr) || labels.has(PIPELINE_LABELS.architectReady))) {
    throw new Error(`running-manual cannot steal ${PIPELINE_LABELS.pr} or ${PIPELINE_LABELS.architectReady} ownership`);
  }
  if (action === 'mr-created' && !labels.has(PIPELINE_LABELS.running) && !labels.has(PIPELINE_LABELS.pr)) {
    throw new Error(`mr-created requires ${PIPELINE_LABELS.running} or an idempotent ${PIPELINE_LABELS.pr} state`);
  }
  if (action === 'needs-human' && labels.has(PIPELINE_LABELS.pr)) {
    throw new Error(`needs-human cannot replace ${PIPELINE_LABELS.pr}; published PR ownership remains with the PR pipeline`);
  }
  return target;
}

