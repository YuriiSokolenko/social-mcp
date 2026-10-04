import path from 'node:path';

export const CODING_TARGETED_PYTEST_STATE_ENV = 'PI_CODING_TARGETED_PYTEST_STATE';

function canonicalRepoPath(value) {
  const text = String(value ?? '').trim().replaceAll('\\\\', '/');
  const file = text.split('::')[0];
  return path.posix.normalize(file).replace(/^\.\//, '');
}

function isPytestPath(file) {
  const normalized = canonicalRepoPath(file);
  const base = path.posix.basename(normalized);
  return normalized.endsWith('.py') && (
    base.startsWith('test_') ||
    base.endsWith('_test.py') ||
    normalized.split('/').includes('tests')
  );
}

export function requiredCodingPytestTargets(changedFiles) {
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : [])
    .map(canonicalRepoPath)
    .filter(Boolean))].sort();
  const python = files.filter(file => file.endsWith('.py'));
  const tests = python.filter(isPytestPath);
  const sources = python.filter(file => !isPytestPath(file));
  return sources.length && tests.length ? tests : [];
}

export function invalidateCodingBehavioralValidation(env = process.env) {
  if (!String(env.PI_CODING_SESSION ?? '').trim()) return false;
  const existed = Object.hasOwn(env, CODING_TARGETED_PYTEST_STATE_ENV);
  delete env[CODING_TARGETED_PYTEST_STATE_ENV];
  return existed;
}

export function recordCodingBehavioralValidation({
  scope,
  result,
  env = process.env,
} = {}) {
  if (!String(env.PI_CODING_SESSION ?? '').trim()) return null;
  if (result?.status !== 'pass' || result?.kind !== 'pytest') return null;
  const targets = Array.isArray(scope?.targets)
    ? [...new Set(scope.targets.map(canonicalRepoPath).filter(Boolean))].sort()
    : [];
  if (!targets.length) return null;
  const state = { schema_version: 1, kind: 'pytest', targets };
  env[CODING_TARGETED_PYTEST_STATE_ENV] = JSON.stringify(state);
  return state;
}

export function assertCodingBehavioralValidation({
  changedFiles,
  env = process.env,
} = {}) {
  if (!String(env.PI_CODING_SESSION ?? '').trim()) return [];
  const required = requiredCodingPytestTargets(changedFiles);
  if (!required.length) return [];

  let state = null;
  try {
    state = JSON.parse(String(env[CODING_TARGETED_PYTEST_STATE_ENV] ?? ''));
  } catch {
    state = null;
  }
  const validated = new Set(
    state?.schema_version === 1 && state?.kind === 'pytest' && Array.isArray(state.targets)
      ? state.targets.map(canonicalRepoPath)
      : [],
  );
  const missing = required.filter(file => !validated.has(file));
  if (missing.length) {
    const error = new Error(JSON.stringify({
      code: 'TARGETED_BEHAVIORAL_VALIDATION_REQUIRED',
      message: 'Changed Python source and directly affected pytest tests require a passing targeted pytest run after the latest mutation before submit_result.',
      required_targets: missing,
      action: { kind: 'pytest', targets: missing },
    }));
    error.code = 'TARGETED_BEHAVIORAL_VALIDATION_REQUIRED';
    error.requiredTargets = missing;
    throw error;
  }
  return required;
}
