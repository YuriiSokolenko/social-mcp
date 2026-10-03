import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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

// Trusted post-state for unjournaled tracked drift (#438). Bounded bash can change tracked files
// without a mutation id. The runtime snapshots the fingerprint of every stage-owned tracked change
// right after each bash call ('after'), and before the next bash call ('before') it compares the
// current bytes with that snapshot: a path that changed outside an observed action is tainted for
// good, so a later external rewrite can never be absorbed as the stage's own work. revert_tracked
// is allowed only while the current fingerprint still equals the observed post-state.

const OBSERVED_SCHEMA_VERSION = 1;

function observedPath(env) {
  const base = sidecarPath(env);
  return base ? `${base}.observed.json` : null;
}

export function worktreeFingerprint(cwd, relative) {
  const absolute = path.join(path.resolve(cwd), relative);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'deleted';
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return 'unsafe';
  const content = fs.readFileSync(absolute);
  return `${stat.mode & 0o7777}:${createHash('sha256').update(content).digest('hex')}`;
}

export function readWorktreeObserved(env = process.env) {
  const target = observedPath(env);
  if (!target || !fs.existsSync(target)) return { fingerprints: new Map(), tainted: new Set() };
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (parsed?.schema_version !== OBSERVED_SCHEMA_VERSION || !parsed.paths || !Array.isArray(parsed.tainted)) return null;
    return { fingerprints: new Map(Object.entries(parsed.paths)), tainted: new Set(parsed.tainted) };
  } catch {
    return null;
  }
}

function writeObserved(env, observed) {
  const target = observedPath(env);
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify({
    schema_version: OBSERVED_SCHEMA_VERSION,
    paths: Object.fromEntries(observed.fingerprints),
    tainted: [...observed.tainted].sort(),
  }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
}

export function observeWorktreeDrift(cwd, env = process.env, phase) {
  if (!observedPath(env)) return false;
  const baseline = readWorktreeBaseline(env);
  const observed = readWorktreeObserved(env);
  if (!baseline || !observed) return false;
  if (phase === 'before') {
    for (const [file, fingerprint] of observed.fingerprints) {
      if (worktreeFingerprint(cwd, file) !== fingerprint) observed.tainted.add(file);
    }
  } else {
    for (const file of trackedDirtyPaths(cwd)) {
      if (baseline.trackedDirty.has(file) || observed.tainted.has(file)) continue;
      observed.fingerprints.set(file, worktreeFingerprint(cwd, file));
    }
  }
  writeObserved(env, observed);
  return true;
}
