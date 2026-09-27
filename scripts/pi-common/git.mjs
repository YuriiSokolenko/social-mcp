import { spawnSync } from 'node:child_process';

// One trusted synchronous Git runner for control-plane publication helpers.
// Token auth is injected only for commands that explicitly receive a token.
export function runGit(args, { cwd, allowFailure = false, token } = {}) {
  const prefix = token
    ? ['-c', `credential.helper=!f() { echo username=x-access-token; echo password="${token}"; }; f`]
    : [];
  const result = spawnSync('git', [...prefix, ...args], { cwd, encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'git failed').trim());
  }
  return { status: result.status ?? 1, out: (result.stdout ?? '').trim() };
}
