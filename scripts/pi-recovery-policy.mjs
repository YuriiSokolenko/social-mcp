export function recoveryForIssue(issue, { hasCheckpoint = false, hasOpenPiPr = false } = {}) {
  const labels = new Set((issue.labels ?? []).map(x => typeof x === 'string' ? x : x.name));
  if (issue.state !== 'open' || !labels.has('pi:running')) return null;
  if (hasOpenPiPr) return { add: 'pi:mr-created', dispatch: null, reason: 'open implementation PR exists' };
  return { add: 'pi:ready', dispatch: 'implementer', reason: hasCheckpoint ? 'resume saved checkpoint' : 'restart implementation' };
}
export function recoveryForPr(pr) {
  const labels = new Set((pr.labels ?? []).map(x => typeof x === 'string' ? x : x.name));
  if (pr.state !== 'open' || !labels.has('review:running')) return null;
  return { add: 'review:ready', dispatch: 'reviewer', reason: 'restart semantic review for current PR head' };
}
export function checkpointGcDecision(issue, { hasOpenPiPr = false } = {}) {
  if (!issue) return { remove: false, reason: 'issue missing' };
  if (hasOpenPiPr) return { remove: false, reason: 'implementation PR still open' };
  if (issue.state === 'closed' && issue.state_reason === 'completed') return { remove: true, reason: 'issue completed' };
  const labels = new Set((issue.labels ?? []).map(x => typeof x === 'string' ? x : x.name));
  if (labels.has('pi:mr-created')) return { remove: true, reason: 'implementation branch published' };
  return { remove: false, reason: 'checkpoint may be the only saved work' };
}
