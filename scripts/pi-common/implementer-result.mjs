import fs from 'node:fs';

const clean = value => typeof value === 'string' ? value.trim() : '';

export const IMPLEMENTER_OUTCOMES = Object.freeze({
  changed: 'changed',
  alreadySatisfied: 'already_satisfied',
  blocked: 'blocked',
});

export function normalizeImplementerResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Implementer result must be an object');
  }

  const changes = Array.isArray(input.changes)
    ? input.changes.map(clean).filter(Boolean)
    : [];
  const blockedReason = clean(input.blocked_reason);
  const inferredOutcome = input.blocked === true
    ? IMPLEMENTER_OUTCOMES.blocked
    : input.already_satisfied === true
      ? IMPLEMENTER_OUTCOMES.alreadySatisfied
      : IMPLEMENTER_OUTCOMES.changed;
  const outcome = clean(input.outcome) || inferredOutcome;

  if (!Object.values(IMPLEMENTER_OUTCOMES).includes(outcome)) {
    throw new Error(`Unknown implementer outcome: ${outcome}`);
  }
  if (!clean(input.title) || !clean(input.summary)) {
    throw new Error('Implementer result requires title and summary');
  }

  if (outcome === IMPLEMENTER_OUTCOMES.changed) {
    if (!changes.length) throw new Error('changed outcome requires at least one concrete change');
    if (blockedReason) throw new Error('changed outcome cannot include blocked_reason');
  } else if (outcome === IMPLEMENTER_OUTCOMES.alreadySatisfied) {
    if (changes.length) throw new Error('already_satisfied outcome requires changes: []');
    if (blockedReason) throw new Error('already_satisfied outcome cannot include blocked_reason');
  } else {
    if (changes.length) throw new Error('blocked outcome requires changes: []');
    if (!blockedReason) throw new Error('blocked outcome requires blocked_reason');
  }

  return {
    ...input,
    title: clean(input.title),
    summary: clean(input.summary),
    changes,
    outcome,
    already_satisfied: outcome === IMPLEMENTER_OUTCOMES.alreadySatisfied,
    blocked: outcome === IMPLEMENTER_OUTCOMES.blocked,
    blocked_reason: blockedReason || undefined,
  };
}

export function writeImplementerResult(target, input) {
  if (!target) throw new Error('PI_IMPLEMENTER_RESULT_FILE is not configured');
  const data = normalizeImplementerResult(input);
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return data;
}

export function readImplementerResult(target) {
  if (!target || !fs.existsSync(target) || !fs.statSync(target).size) return null;
  return normalizeImplementerResult(JSON.parse(fs.readFileSync(target, 'utf8')));
}
