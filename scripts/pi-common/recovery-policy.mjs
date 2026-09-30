/**
 * Small deterministic recovery decisions shared by reconciliation code.
 * Recovery never schedules issue work directly: RUNNING returns ownership to
 * Dispatcher, DRAINING/PAUSED clears it, and an existing PR remains durable.
 */

import { PIPELINE_LABELS } from './state-machine.mjs';

export function issueRecoveryTarget(issue, { hasOpenPiPr = false, automationMode = 'PAUSED' } = {}) {
  if (!issue || issue.state !== 'open') return null;
  if (hasOpenPiPr) return PIPELINE_LABELS.pr;
  return automationMode === 'RUNNING' ? PIPELINE_LABELS.queued : null;
}

export function checkpointGcDecision(issue, { hasOpenPiPr = false } = {}) {
  if (!issue) return { remove: false, reason: 'issue missing' };
  if (hasOpenPiPr) return { remove: false, reason: 'implementation PR still open' };
  if (issue.state === 'closed' && issue.state_reason === 'completed') return { remove: true, reason: 'issue completed' };
  return { remove: false, reason: 'checkpoint may be the only saved work' };
}
