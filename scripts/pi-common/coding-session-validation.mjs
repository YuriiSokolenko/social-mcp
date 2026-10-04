import fs from 'node:fs';
import path from 'node:path';

export const CODING_TARGETED_PYTEST_STATE_ENV = 'PI_CODING_TARGETED_PYTEST_STATE';
export const CODING_SESSION_USED_ENV = 'PI_CODING_SESSION_USED';

function validationLifecycleActive(env = process.env) {
  return Boolean(
    String(env.PI_CODING_SESSION ?? '').trim() ||
    String(env[CODING_SESSION_USED_ENV] ?? '').trim() === 'true'
  );
}

function validationStatePath(env = process.env) {
  const explicit = String(env.PI_CODING_TARGETED_PYTEST_STATE_FILE ?? '').trim();
  if (explicit) return explicit;
  const ledger = String(env.PI_VALIDATION_LEDGER_FILE ?? '').trim();
  if (ledger) return `${ledger}.coding-targeted-pytest.json`;
  const terminal = String(env.PI_TERMINAL_RESULT_FILE ?? '').trim();
  return terminal ? `${terminal}.coding-targeted-pytest.json` : null;
}

function readValidationState(env = process.env) {
  const target = validationStatePath(env);
  if (target && fs.existsSync(target)) {
    try {
      return JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(String(env[CODING_TARGETED_PYTEST_STATE_ENV] ?? ''));
  } catch {
    return null;
  }
}

function writeValidationState(state, env = process.env) {
  env[CODING_TARGETED_PYTEST_STATE_ENV] = JSON.stringify(state);
  const target = validationStatePath(env);
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
}

function canonicalRepoPath(value) {
  const text = String(value ?? '').trim().replaceAll(/\\/g, '/');
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
  if (!validationLifecycleActive(env)) return false;
  const target = validationStatePath(env);
  const existed = Object.hasOwn(env, CODING_TARGETED_PYTEST_STATE_ENV) ||
    Boolean(target && fs.existsSync(target));
  delete env[CODING_TARGETED_PYTEST_STATE_ENV];
  if (target) fs.rmSync(target, { force: true });
  return existed;
}

export function recordCodingBehavioralValidation({
  scope,
  result,
  env = process.env,
} = {}) {
  if (!validationLifecycleActive(env)) return null;
  if (result?.status !== 'pass' || result?.kind !== 'pytest') return null;
  const targets = Array.isArray(scope?.targets)
    ? [...new Set(scope.targets.map(canonicalRepoPath).filter(Boolean))].sort()
    : [];
  if (!targets.length) return null;
  const state = { schema_version: 1, kind: 'pytest', targets };
  writeValidationState(state, env);
  return state;
}

export function assertCodingBehavioralValidation({
  changedFiles,
  env = process.env,
} = {}) {
  if (!validationLifecycleActive(env)) return [];
  const required = requiredCodingPytestTargets(changedFiles);
  if (!required.length) return [];

  const state = readValidationState(env);
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


function candidatePreparedPath(value) {
  const text = String(value ?? '').trim().replace(/^[`'"]+|[`'",.;:]+$/g, '');
  if (!text || text.length > 1000) return null;
  if (!/[A-Za-z0-9_]\.[A-Za-z0-9]{1,12}$/.test(text)) return null;
  if (text.startsWith('/') || text.startsWith('./') || /\\/.test(text) || /(^|\/)\.\.(\/|$)/.test(text)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return null;
  return path.posix.normalize(text);
}

export function requiredPreparedOutputPaths(prepared) {
  if (!prepared || prepared.status !== 'prepared') return [];
  const candidates = [];
  const hinted = candidatePreparedPath(prepared.layoutHint?.sourceTarget);
  if (hinted) candidates.push(hinted);
  for (const step of Array.isArray(prepared.plan) ? prepared.plan : []) {
    const matches = String(step).match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,12}/g) ?? [];
    for (const match of matches) {
      const candidate = candidatePreparedPath(match);
      if (candidate) candidates.push(candidate);
    }
  }
  return [...new Set(candidates)].sort();
}

export function codingSessionSubmissionReadiness({
  prepared,
  cwd = process.cwd(),
  changedFiles = [],
  resumed = false,
  validationRepair = false,
} = {}) {
  if (resumed || validationRepair) return { ready: true, missing_outputs: [] };
  const required = requiredPreparedOutputPaths(prepared);
  const missing = required.filter(file => !fs.existsSync(path.resolve(cwd, file)));
  return missing.length
    ? { ready: false, missing_outputs: missing }
    : { ready: true, missing_outputs: [] };
}
