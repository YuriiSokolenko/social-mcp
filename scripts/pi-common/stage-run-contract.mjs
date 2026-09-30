function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function optionalPath(value, name) {
  if (value == null) return null;
  return requiredString(value, name);
}

/**
 * Backend-neutral request for one model-driven stage execution.
 * Backend-specific runtime policy stays out of this contract.
 */
export function createStageRunSpec({
  stage,
  cwd,
  prompt,
  model,
  environment,
  artifacts,
}) {
  if (!model || typeof model !== 'object') throw new Error('model is required');
  if (!environment || typeof environment !== 'object') throw new Error('environment is required');
  if (!artifacts || typeof artifacts !== 'object') throw new Error('artifacts are required');

  const normalizedArtifacts = Object.freeze({
    terminalResultPath: requiredString(artifacts.terminalResultPath, 'artifacts.terminalResultPath'),
    metricsPath: requiredString(artifacts.metricsPath, 'artifacts.metricsPath'),
    rawLogPath: optionalPath(artifacts.rawLogPath, 'artifacts.rawLogPath'),
  });

  return Object.freeze({
    stage: requiredString(stage, 'stage'),
    cwd: requiredString(cwd, 'cwd'),
    prompt: requiredString(prompt, 'prompt'),
    model: Object.freeze({
      id: requiredString(model.id, 'model.id'),
      provider: requiredString(model.provider, 'model.provider'),
      baseUrl: requiredString(model.baseUrl, 'model.baseUrl'),
    }),
    environment: Object.freeze({ ...environment }),
    artifacts: normalizedArtifacts,
  });
}

/**
 * Backend-neutral successful stage result. Failed backends continue to throw so
 * existing workflow failure semantics remain unchanged.
 */
export function createStageRunResult({ backend, durationMs, artifacts }) {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('durationMs must be non-negative');
  if (!artifacts || typeof artifacts !== 'object') throw new Error('artifacts are required');

  return Object.freeze({
    backend: requiredString(backend, 'backend'),
    status: 'succeeded',
    exitCode: 0,
    signal: null,
    durationMs,
    artifacts: Object.freeze({
      terminalResultPath: requiredString(artifacts.terminalResultPath, 'artifacts.terminalResultPath'),
      metricsPath: requiredString(artifacts.metricsPath, 'artifacts.metricsPath'),
      rawLogPath: optionalPath(artifacts.rawLogPath, 'artifacts.rawLogPath'),
    }),
  });
}
