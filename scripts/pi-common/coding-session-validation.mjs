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
    base.endsWith('_test.py')
  );
}

export function requiredCodingPytestTargets(changedFiles, { cwd = null } = {}) {
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : [])
    .map(canonicalRepoPath)
    .filter(Boolean))].sort();
  const python = files.filter(file => file.endsWith('.py'));
  const tests = python
    .filter(isPytestPath)
    .filter(file => !cwd || fs.existsSync(path.resolve(cwd, file)));
  const sources = python.filter(file => !isPytestPath(file));
  return sources.length && tests.length ? tests : [];
}

function pytestCoverageFromState(state) {
  if (!state || state.kind !== 'pytest') {
    return { targets: [], directories: [], wholeRepo: false };
  }
  if (state.schema_version === 1) {
    return {
      targets: Array.isArray(state.targets) ? state.targets.map(canonicalRepoPath).filter(Boolean) : [],
      directories: [],
      wholeRepo: false,
    };
  }
  if (state.schema_version !== 2) {
    return { targets: [], directories: [], wholeRepo: false };
  }
  return {
    targets: Array.isArray(state.targets) ? state.targets.map(canonicalRepoPath).filter(Boolean) : [],
    directories: Array.isArray(state.directories) ? state.directories.map(canonicalRepoPath).filter(Boolean) : [],
    wholeRepo: state.whole_repo === true,
  };
}

function pytestScopeCoverage(scope, cwd) {
  const wholeRepo = scope?.whole_repo === true || scope?.profile === 'pytest_all';
  const targets = [];
  const directories = [];
  for (const raw of Array.isArray(scope?.targets) ? scope.targets : []) {
    const target = canonicalRepoPath(raw);
    if (!target) continue;
    const absolute = path.resolve(cwd, target);
    if (target.endsWith('.py') || (fs.existsSync(absolute) && fs.statSync(absolute).isFile())) {
      targets.push(target);
    } else {
      directories.push(target);
    }
  }
  return {
    targets: [...new Set(targets)].sort(),
    directories: [...new Set(directories)].sort(),
    wholeRepo,
  };
}

function coveredByDirectory(file, directory) {
  const relative = path.posix.relative(directory, file);
  return relative === '' || (relative && relative !== '..' && !relative.startsWith('../'));
}

export function repositoryFingerprintRequiresValidation(before, after) {
  return !(typeof before === 'string' && before && typeof after === 'string' && after && before === after);
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
  cwd = process.cwd(),
} = {}) {
  if (!validationLifecycleActive(env)) return null;
  const pytestResult =
    result?.kind === 'pytest' ||
    (result?.kind === 'profile' && result?.profile === 'pytest_all');
  if (!pytestResult) return null;
  if (result?.status !== 'pass') {
    invalidateCodingBehavioralValidation(env);
    return null;
  }

  const current = pytestScopeCoverage(scope, cwd);
  if (!current.wholeRepo && !current.targets.length && !current.directories.length) return null;
  const previous = pytestCoverageFromState(readValidationState(env));
  const state = {
    schema_version: 2,
    kind: 'pytest',
    targets: [...new Set([...previous.targets, ...current.targets])].sort(),
    directories: [...new Set([...previous.directories, ...current.directories])].sort(),
    whole_repo: previous.wholeRepo || current.wholeRepo,
  };
  writeValidationState(state, env);
  return state;
}

export function assertCodingBehavioralValidation({
  changedFiles,
  env = process.env,
  cwd = null,
} = {}) {
  if (!validationLifecycleActive(env)) return [];
  // git diff --name-only includes deleted paths. A deleted pytest file cannot be
  // executed and must never become an impossible terminal requirement.
  const required = requiredCodingPytestTargets(changedFiles, { cwd });
  if (!required.length) return [];

  const coverage = pytestCoverageFromState(readValidationState(env));
  const validated = new Set(coverage.targets);
  const missing = coverage.wholeRepo
    ? []
    : required.filter(file =>
        !validated.has(file) &&
        !coverage.directories.some(directory => coveredByDirectory(file, directory))
      );
  if (missing.length) {
    const error = new Error(JSON.stringify({
      code: 'TARGETED_BEHAVIORAL_VALIDATION_REQUIRED',
      message: 'Changed Python source and directly affected pytest tests require a passing pytest run after the latest mutation before submit_result. Exact files, node ids within those files, an enclosing directory target, or the pytest_all profile all satisfy the requirement.',
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
  const text = String(value ?? '').trim();
  if (!text || text.length > 1000) return null;
  if (!/[A-Za-z0-9_]\.[A-Za-z0-9]{1,12}$/.test(text)) return null;
  if (text.startsWith('/') || text.startsWith('./') || /\\/.test(text) || /(^|\/)\.\.(\/|$)/.test(text)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return null;
  return path.posix.normalize(text);
}

export function requiredPreparedOutputPaths(prepared) {
  if (!prepared || prepared.status !== 'prepared') return [];
  // Prepared output gating consumes only model-free structured layout facts. Planner prose is
  // advisory and must never become a filesystem requirement through regex extraction.
  return [...new Set([
    candidatePreparedPath(prepared.layoutHint?.sourceTarget),
    candidatePreparedPath(prepared.layoutHint?.testTarget),
  ].filter(Boolean))].sort();
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
