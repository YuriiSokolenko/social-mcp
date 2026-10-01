import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Large mutation turn: the Implementer (2K responses) declares one already-decided mutation
// target; a one-shot FORK of the same Implementer session (16K, restricted to the declared
// write/edit) emits the payload through the normal tool-call protocol; the parent runtime
// alone validates and applies it. The forked turn never touches the worktree: its
// write/edit tools only stage the payload outside the worktree (see
// scripts/pi-mutation-turn-child.mjs), so snapshots, no-op detection, rollback, progress
// and verification permits stay owned by the parent's normal mutation path.

export const MUTATION_TURN_OPERATIONS = Object.freeze(['write', 'edit']);
// Sanity bound on one staged payload; what the turn can emit is bounded by its token ceiling.
export const MAX_STAGED_CONTENT_CHARS = 400000;

export class MutationTurnRejected extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MutationTurnRejected';
    this.code = code;
  }
}

function reject(code, message) {
  throw new MutationTurnRejected(code, message);
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
// sees and uses worktree-absolute paths). Called when the turn is requested AND again
// immediately before apply (the turn may run for minutes).
export function resolveMutationTarget(cwd, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    reject('missing_path', 'a mutation turn requires a concrete target path');
  }
  const root = path.resolve(cwd);
  const absolutePath = path.resolve(root, requestedPath);
  if (absolutePath === root || !absolutePath.startsWith(`${root}${path.sep}`)) {
    reject('invalid_path', 'mutation turn path escapes the current worktree');
  }
  const relative = path.relative(root, absolutePath);
  const parts = relative.split(path.sep);
  if (parts[0] === '.git') reject('invalid_path', 'a mutation turn cannot target .git');

  let current = root;
  let targetStat = null;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) break; // the remaining components will be created as real directories/file
    if (stat.isSymbolicLink()) {
      reject('invalid_path', `mutation turn refuses symbolic links in the target path: ${path.relative(root, current)}`);
    }
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) reject('invalid_path', `mutation turn parent is not a directory: ${path.relative(root, current)}`);
    if (last) {
      if (!stat.isFile()) reject('invalid_path', `mutation turn target is not a regular file: ${relative}`);
      targetStat = stat;
    }
  }
  return { root, absolutePath, relative, exists: targetStat != null };
}

// Validates the declaration made by the 2K Implementer before any turn starts. For an edit,
// the current content is recorded so apply can refuse a target that changed meanwhile.
export function validateMutationTurnRequest(cwd, params) {
  const operation = params?.operation;
  if (!MUTATION_TURN_OPERATIONS.includes(operation)) {
    reject('invalid_operation', `mutation turn operation must be one of ${MUTATION_TURN_OPERATIONS.join('/')}`);
  }
  const { relative, absolutePath, exists } = resolveMutationTarget(cwd, params?.path);
  if (operation === 'edit' && !exists) {
    reject('missing_target', `mutation turn edit target does not exist: ${relative}; declare operation=write for a new file`);
  }
  return {
    operation,
    path: relative,
    expectedContent: operation === 'edit' ? fs.readFileSync(absolutePath, 'utf8') : null,
  };
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Exact-match multi-replace with the builtin edit tool's contract: every oldText must occur
// exactly once in the ORIGINAL content and edits must not overlap. No fuzzy matching.
export function applyExactEdits(original, edits) {
  if (!Array.isArray(edits) || edits.length === 0) reject('invalid_edit', 'edit requires at least one {oldText, newText} entry');
  const spans = edits.map((edit, index) => {
    if (typeof edit?.oldText !== 'string' || !edit.oldText || typeof edit?.newText !== 'string') {
      reject('invalid_edit', `edits[${index}] must have a non-empty oldText and a newText string`);
    }
    const start = original.indexOf(edit.oldText);
    if (start < 0) reject('invalid_edit', `edits[${index}].oldText was not found in the file`);
    if (original.indexOf(edit.oldText, start + 1) >= 0) reject('invalid_edit', `edits[${index}].oldText is not unique in the file`);
    return { start, end: start + edit.oldText.length, newText: edit.newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].start < spans[i - 1].end) reject('invalid_edit', 'edits overlap');
  }
  let result = '';
  let cursor = 0;
  for (const span of spans) {
    result += original.slice(cursor, span.start) + span.newText;
    cursor = span.end;
  }
  return result + original.slice(cursor);
}

// Validates a staged payload against the declaration, re-validates the target, then writes
// atomically. An edit must still see exactly the content it was computed from; otherwise a
// concurrent change would be silently discarded. Returns changed=false (touching nothing)
// when the bytes already match, mirroring the no-op rule for direct writes.
export function applyStagedMutation(cwd, declared, staged) {
  if (!staged || typeof staged !== 'object') reject('invalid_stage', 'staged mutation is missing or malformed');
  if (staged.operation !== declared.operation) {
    reject('operation_mismatch', `staged operation ${String(staged.operation)} does not match declared ${declared.operation}`);
  }
  if (typeof staged.path !== 'string' || path.normalize(staged.path) !== path.normalize(declared.path)) {
    reject('path_mismatch', `staged path ${String(staged.path)} does not match declared ${declared.path}`);
  }
  if (typeof staged.content !== 'string' || staged.content.length > MAX_STAGED_CONTENT_CHARS) {
    reject('invalid_stage', 'staged content is missing or oversized');
  }
  if (staged.sha256 !== sha256(staged.content)) reject('invalid_stage', 'staged content digest mismatch');

  const { absolutePath, exists } = resolveMutationTarget(cwd, declared.path);
  if (declared.operation === 'edit') {
    if (!exists) reject('target_changed', `edit target disappeared before apply: ${declared.path}`);
    const current = fs.readFileSync(absolutePath, 'utf8');
    if (current !== declared.expectedContent || staged.baseSha256 !== sha256(current)) {
      reject('target_changed', `edit target changed during the mutation turn: ${declared.path}; nothing was applied`);
    }
  }
  if (exists && fs.readFileSync(absolutePath).equals(Buffer.from(staged.content, 'utf8'))) {
    return { changed: false, bytes: Buffer.byteLength(staged.content, 'utf8') };
  }
  const mode = exists ? fs.statSync(absolutePath).mode & 0o777 : 0o644;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.pi-mutation-turn-${process.pid}-${Date.now()}`,
  );
  try {
    fs.writeFileSync(tempPath, staged.content, { encoding: 'utf8', mode, flag: 'wx' });
    fs.renameSync(tempPath, absolutePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return { changed: true, bytes: Buffer.byteLength(staged.content, 'utf8') };
}

export function readStagedMutation(stagingFile) {
  if (!stagingFile || !fs.existsSync(stagingFile)) return null;
  return JSON.parse(fs.readFileSync(stagingFile, 'utf8'));
}

// Written only by the forked turn's staging tools. JSON.stringify/parse is lossless for the
// payload string; the model's own tool-call arguments are never re-encoded or rewritten.
export function writeStagedMutation(stagingFile, record) {
  fs.writeFileSync(stagingFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}
