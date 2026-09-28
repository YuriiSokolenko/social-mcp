import { spawnSync } from 'node:child_process';

export function timeoutSeconds(value, name = 'timeout') {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error(`${name} must be a positive integer`);
  return seconds;
}

export function runProcess(command, args, {
  cwd,
  env = process.env,
  allowFailure = false,
  timeoutSeconds: requestedTimeout = Number(process.env.PI_PROCESS_TIMEOUT_SECONDS ?? 300),
  stdio = 'pipe',
  maxBuffer = 16 * 1024 * 1024,
} = {}) {
  const seconds = timeoutSeconds(requestedTimeout, `${command} timeout`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio,
    timeout: seconds * 1000,
    killSignal: 'SIGKILL',
    maxBuffer,
  });
  const out = (result.stdout ?? '').trim();
  const err = (result.stderr ?? '').trim();
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') throw new Error(`${command} timed out after ${seconds}s`);
    throw result.error;
  }
  const status = result.status ?? 1;
  if (!allowFailure && status !== 0) throw new Error(err || out || `${command} failed with exit code ${status}`);
  return { status, out, err };
}
