import fs from 'node:fs';
import path from 'node:path';

// Trusted containment for every Implementer file mutation (direct or inside the 16K coding
// session): the target must be a regular file, or a new file, physically inside the worktree.

export class MutationTargetRejected extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MutationTargetRejected';
    this.code = code;
  }
}

function reject(code, message) {
  throw new MutationTargetRejected(code, message);
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// Lexical containment is not enough: an existing symlinked parent (worktree/link -> /outside
// or -> .git) would redirect the write. Walk every existing component below the worktree root
// with lstat and refuse any symlink, so the physical target is guaranteed to be inside the
// worktree. Absolute paths are accepted when they name a file inside the worktree (the model
// sees and uses worktree-absolute paths).
export function resolveMutationTarget(cwd, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    reject('missing_path', 'a file mutation requires a concrete target path');
  }
  const root = path.resolve(cwd);
  const absolutePath = path.resolve(root, requestedPath);
  if (absolutePath === root || !absolutePath.startsWith(`${root}${path.sep}`)) {
    reject('invalid_path', 'mutation path escapes the current worktree');
  }
  const relative = path.relative(root, absolutePath);
  const parts = relative.split(path.sep);
  if (parts[0] === '.git') reject('invalid_path', 'mutations cannot target .git');

  let current = root;
  let targetStat = null;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) break; // the remaining components will be created as real directories/file
    if (stat.isSymbolicLink()) {
      reject('invalid_path', `mutations refuse symbolic links in the target path: ${path.relative(root, current)}`);
    }
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) reject('invalid_path', `mutation parent is not a directory: ${path.relative(root, current)}`);
    if (last) {
      if (!stat.isFile()) reject('invalid_path', `mutation target is not a regular file: ${relative}`);
      targetStat = stat;
    }
  }
  return { root, absolutePath, relative, exists: targetStat != null };
}
