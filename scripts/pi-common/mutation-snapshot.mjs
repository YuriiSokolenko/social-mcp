import fs from 'node:fs';
import path from 'node:path';

export function mutationSnapshotChanged(before, after) {
  if (!before || !after) return true;
  if (before.existed !== after.existed) return true;
  if (!before.existed) return false;
  if (before.mode !== after.mode) return true;
  return !before.content.equals(after.content);
}

export function captureMutationSnapshot(cwd, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath) return null;
  const root = path.resolve(cwd);
  const absolutePath = path.resolve(root, requestedPath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('Mutation path escapes the current worktree');
  }
  const existed = fs.existsSync(absolutePath);
  if (existed && !fs.statSync(absolutePath).isFile()) {
    throw new Error('Mutation rollback supports files only');
  }
  return {
    path: requestedPath,
    absolutePath,
    existed,
    content: existed ? fs.readFileSync(absolutePath) : null,
    mode: existed ? fs.statSync(absolutePath).mode & 0o7777 : null,
  };
}

// Conservative, provable no-op detection for the generic `write` tool: true only when an
// existing regular file's current bytes already equal the requested content exactly. Any
// ambiguity (missing path/content, escaping path, missing file, non-file target, read error)
// returns false so the real tool still runs and produces its own correct behavior/error.
export function detectNoOpWrite(cwd, input) {
  const requestedPath = input?.path;
  const content = input?.content;
  if (typeof requestedPath !== 'string' || !requestedPath || typeof content !== 'string') {
    return false;
  }
  try {
    const root = path.resolve(cwd);
    const absolutePath = path.resolve(root, requestedPath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      return false;
    }
    if (!fs.existsSync(absolutePath)) return false;
    if (!fs.lstatSync(absolutePath).isFile()) return false;
    const current = fs.readFileSync(absolutePath);
    return current.equals(Buffer.from(content, 'utf8'));
  } catch {
    return false;
  }
}
