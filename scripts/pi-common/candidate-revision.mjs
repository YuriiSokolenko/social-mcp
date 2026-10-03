import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runGit as git } from './git.mjs';
import { baseRef } from './project-config.mjs';

const gitPaths = text => text.split('\0').filter(Boolean);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resolveCandidatePath(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`candidate path escapes worktree: ${relativePath}`);
  }
  return absolute;
}

function candidateEntry(root, relativePath) {
  const absolute = resolveCandidatePath(root, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: relativePath,
        kind: 'deleted',
        mode: null,
        size: 0,
        content_sha256: null,
      };
    }
    throw error;
  }

  let bytes;
  let kind;
  let mode;
  if (stat.isSymbolicLink()) {
    kind = 'symlink';
    mode = '120000';
    bytes = Buffer.from(fs.readlinkSync(absolute), 'utf8');
  } else if (stat.isFile()) {
    kind = 'file';
    mode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
    bytes = fs.readFileSync(absolute);
  } else {
    throw new Error(`unsupported candidate path type: ${relativePath}`);
  }

  return {
    path: relativePath,
    kind,
    mode,
    size: bytes.length,
    content_sha256: sha256(bytes),
  };
}

/**
 * Content identity for the publishable candidate, independent of whether the
 * same bytes are still dirty or have already been checkpoint-committed.
 */
export function computeCandidateRevision({
  cwd = process.cwd(),
  base = baseRef(),
} = {}) {
  const root = fs.realpathSync(path.resolve(cwd));
  const baseCommit = git(['rev-parse', base], { cwd: root }).out.trim();
  const tracked = gitPaths(
    git(['diff', '--no-renames', '--name-only', '-z', base, '--'], { cwd: root }).out,
  );
  const untracked = gitPaths(
    git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).out,
  );
  const files = [...new Set([...tracked, ...untracked])].sort();
  const entries = files.map(file => candidateEntry(root, file));
  const identity = {
    schema_version: 1,
    base_commit: baseCommit,
    entries,
  };

  return {
    schema_version: 1,
    base_commit: baseCommit,
    digest: sha256(Buffer.from(JSON.stringify(identity), 'utf8')),
    files,
  };
}

export function sameCandidateRevision(left, right) {
  return Boolean(
    left &&
    right &&
    left.schema_version === 1 &&
    right.schema_version === 1 &&
    left.base_commit === right.base_commit &&
    left.digest === right.digest,
  );
}
