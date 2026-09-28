import { runProcess } from './process.mjs';

function gitEnvironment(token) {
  if (!token) return process.env;
  const env = { ...process.env };
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const index = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = 'http.extraHeader';
  env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return env;
}

// One trusted synchronous Git runner for control-plane publication helpers.
// Authentication is passed through the child environment, never argv, so a
// self-hosted runner's process list cannot expose the token.
export function runGit(args, {
  cwd,
  allowFailure = false,
  token,
  timeoutSeconds = Number(process.env.PI_GIT_TIMEOUT_SECONDS ?? 300),
} = {}) {
  return runProcess('git', args, {
    cwd,
    allowFailure,
    timeoutSeconds,
    env: gitEnvironment(token),
  });
}
