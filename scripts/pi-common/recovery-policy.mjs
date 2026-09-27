/**
 * Small deterministic recovery decisions shared by reconciliation code.
 *
 * Recovery is intentionally smaller than the happy path: preserve checkpoints,
 * prefer an already-published PR, and return orphaned work to its normal owner.
 * No GitHub calls or dispatches belong in this policy module.
 */

export function recoveryForIssue(issue, { hasCheckpoint = false, hasOpenPiPr = false } = {}) {
  const labels = new Set((issue.labels ?? []).map(x => typeof x === 'string' ? x : x.name));
  if (issue.state !== 'open' || !labels.has('pi:running')) return null;
  if (hasOpenPiPr) return { add: 'pi:mr-created', dispatch: null, reason: 'open implementation PR exists' };
  return { add: 'pi:ready', dispatch: 'implementer', reason: hasCheckpoint ? 'resume saved checkpoint' : 'restart implementation' };
}
export function checkpointGcDecision(issue, { hasOpenPiPr = false } = {}) {
  if (!issue) return { remove: false, reason: 'issue missing' };
  if (hasOpenPiPr) return { remove: false, reason: 'implementation PR still open' };
  if (issue.state === 'closed' && issue.state_reason === 'completed') return { remove: true, reason: 'issue completed' };
  return { remove: false, reason: 'checkpoint may be the only saved work' };
}
