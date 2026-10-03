import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Trusted run-start evidence for unjournaled cleanup (#438). The set of untracked, non-ignored
// paths present before the model's first action is written once (exclusive create) to a sidecar
// that parent and fork processes share through PI_WORKTREE_BASELINE_FILE. A path outside that
// set and outside the accepted scope appeared during this stage, so the runtime may remove it.
// Without the sidecar, ownership cannot be proven and callers must refuse deletion.

const SCHEMA_VERSION = 2;

function untrackedPaths(cwd) {
  const out = execFileSync('git', ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z'], {
    cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

// Tracked paths already differing from HEAD (staged or unstaged) at run start: their bytes are
// pre-existing work that revert_tracked must not discard.
function trackedDirtyPaths(cwd) {
  const out = execFileSync('git', ['--literal-pathspecs', 'diff', '--no-renames', '--name-only', '-z', 'HEAD'], {
    cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

function sidecarPath(env) {
  return String(env?.PI_WORKTREE_BASELINE_FILE ?? '').trim() || null;
}

export function captureWorktreeBaseline(cwd, env = process.env) {
  const target = sidecarPath(env);
  if (!target) return false;
  const body = JSON.stringify({ schema_version: SCHEMA_VERSION, untracked: untrackedPaths(cwd), tracked_dirty: trackedDirtyPaths(cwd) }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(target, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

// Returns { untracked, trackedDirty } Sets of run-start paths, or null when baseline identity is unavailable.
export function readWorktreeBaseline(env = process.env) {
  const target = sidecarPath(env);
  if (!target || !fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (parsed?.schema_version !== SCHEMA_VERSION || !Array.isArray(parsed.untracked)) return null;
    if (!Array.isArray(parsed.tracked_dirty)) return null;
    if ([...parsed.untracked, ...parsed.tracked_dirty].some(item => typeof item !== 'string')) return null;
    return { untracked: new Set(parsed.untracked), trackedDirty: new Set(parsed.tracked_dirty) };
  } catch {
    return null;
  }
}
