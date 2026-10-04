import fs from 'node:fs';

const clean = value => typeof value === 'string' ? value.trim() : '';

function invalidResultPath(file, reason) {
  const error = new Error(`INVALID_RESULT_PATH: ${reason}: ${String(file)}`);
  error.code = 'INVALID_RESULT_PATH';
  error.path = file;
  return error;
}

export function normalizeImplementerFiles(value) {
  if (!Array.isArray(value)) return [];
  const files = [...value];
  for (const file of files) {
    if (typeof file !== 'string' || !file.length) {
      throw invalidResultPath(file, 'Implementer result files must be non-empty strings');
    }
    if (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('\\\\')) {
      throw invalidResultPath(file, 'Windows absolute paths are not repository-relative git paths');
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(file) || /^file:/i.test(file)) {
      throw invalidResultPath(file, 'URI-like paths are not repository-relative git paths');
    }
    if (file.startsWith('/') || file.startsWith('./')) {
      throw invalidResultPath(file, 'Implementer result files must use repository-relative git paths');
    }
    const segments = file.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
      throw invalidResultPath(file, 'Implementer result files cannot contain empty, dot, or parent traversal segments');
    }
  }
  return [...new Set(files)].sort();
}

export function assertNoScratchArtifacts(files) {
  const scratch = files.filter(file => /(^|\/)(?:\.probe(?:\d+)?\.txt|\.pi-tmp-[^/]+)$/.test(file));
  if (scratch.length) throw new Error(`Runtime scratch artifacts cannot be submitted: ${scratch.join(', ')}. Use recover_worktree to remove or revert them.`);
}

export function assertImplementerFileSet(actualFiles, declaredFiles) {
  assertNoScratchArtifacts(actualFiles);
  const actual = normalizeImplementerFiles(actualFiles);
  const declared = normalizeImplementerFiles(declaredFiles);
  const actualSet = new Set(actual);
  const declaredSet = new Set(declared);
  const unexpected = actual.filter(file => !declaredSet.has(file));
  const missing = declared.filter(file => !actualSet.has(file));
  if (unexpected.length || missing.length) {
    const parts = [];
    if (unexpected.length) parts.push(`unexpected files: ${unexpected.join(', ')}`);
    if (missing.length) parts.push(`missing files: ${missing.join(', ')}`);
    throw new Error(`Implementer file-set mismatch: ${parts.join('; ')}`);
  }
  return actual;
}

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
  const files = normalizeImplementerFiles(input.files);
  assertNoScratchArtifacts(files);
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
    if (!files.length) throw new Error('changed outcome requires at least one declared file');
    if (blockedReason) throw new Error('changed outcome cannot include blocked_reason');
  } else if (outcome === IMPLEMENTER_OUTCOMES.alreadySatisfied) {
    if (changes.length) throw new Error('already_satisfied outcome requires changes: []');
    if (files.length) throw new Error('already_satisfied outcome requires files: []');
    if (blockedReason) throw new Error('already_satisfied outcome cannot include blocked_reason');
  } else {
    if (changes.length) throw new Error('blocked outcome requires changes: []');
    if (files.length) throw new Error('blocked outcome requires files: []');
    if (!blockedReason) throw new Error('blocked outcome requires blocked_reason');
  }

  return {
    ...input,
    title: clean(input.title),
    summary: clean(input.summary),
    changes,
    files,
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
