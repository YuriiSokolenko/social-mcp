import fs from 'node:fs';
import path from 'node:path';

import { runProcess } from './process.mjs';

const PREVIEW_MAX_CHARS = 2000;

function requiredText(value, name, maxLength = 20000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`);
  return value;
}

function resolveWorktreeFile(root, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    throw new Error('path is required');
  }
  const worktree = path.resolve(root);
  const absolutePath = path.resolve(worktree, requestedPath);
  if (absolutePath !== worktree && !absolutePath.startsWith(`${worktree}${path.sep}`)) {
    throw new Error('structural_edit path escapes the current worktree');
  }
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`structural_edit target is not an existing file: ${requestedPath}`);
  }
  const targetStat = fs.lstatSync(absolutePath);
  if (targetStat.isSymbolicLink()) {
    throw new Error('structural_edit refuses symbolic-link targets');
  }
  if (!targetStat.isFile()) {
    throw new Error(`structural_edit target is not an existing file: ${requestedPath}`);
  }
  return absolutePath;
}

function atomicWrite(absolutePath, content) {
  const stat = fs.statSync(absolutePath);
  const tempPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.pi-structural-edit-${process.pid}-${Date.now()}`,
  );
  try {
    fs.writeFileSync(tempPath, content, { mode: stat.mode & 0o777 });
    fs.renameSync(tempPath, absolutePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function parseMatches(result) {
  if (![0, 1].includes(result.status)) {
    throw new Error(result.err || result.out || `ast-grep failed with exit code ${result.status}`);
  }
  if (!result.out) return [];
  let matches;
  try {
    matches = JSON.parse(result.out);
  } catch (error) {
    throw new Error(`ast-grep returned invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(matches)) throw new Error('ast-grep JSON result must be an array');
  return matches;
}

function bounded(text) {
  const value = String(text ?? '');
  return {
    text: value.length > PREVIEW_MAX_CHARS ? value.slice(0, PREVIEW_MAX_CHARS) : value,
    truncated: value.length > PREVIEW_MAX_CHARS,
  };
}

export function structuralEdit(root, params, options = {}) {
  const absolutePath = resolveWorktreeFile(root, params?.path);
  const pattern = requiredText(params?.pattern, 'pattern');
  const rewrite = requiredText(params?.rewrite, 'rewrite');
  const command = options.command || process.env.PI_AST_GREP_BIN || 'ast-grep';
  const run = options.run || runProcess;
  const timeout = Number(process.env.PI_AST_GREP_TIMEOUT_SECONDS ?? 10);

  const result = run(command, [
    'run',
    '--pattern', pattern,
    '--rewrite', rewrite,
    '--json=compact',
    '--color', 'never',
    absolutePath,
  ], {
    cwd: path.resolve(root),
    allowFailure: true,
    timeoutSeconds: timeout,
  });
  const matches = parseMatches(result);
  if (matches.length !== 1) {
    throw new Error(`structural_edit requires exactly one AST match; found ${matches.length}`);
  }

  const match = matches[0];
  const reportedPath = path.resolve(root, String(match.file ?? ''));
  if (reportedPath !== absolutePath) {
    throw new Error(`ast-grep matched an unexpected file: ${String(match.file ?? '')}`);
  }
  const start = Number(match.range?.byteOffset?.start);
  const end = Number(match.range?.byteOffset?.end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new Error('ast-grep returned an invalid byte range');
  }
  if (typeof match.text !== 'string' || typeof match.replacement !== 'string') {
    throw new Error('ast-grep result is missing text or replacement');
  }

  const source = fs.readFileSync(absolutePath);
  if (end > source.length) throw new Error('ast-grep byte range is outside the current file');
  const currentMatch = source.subarray(start, end).toString('utf8');
  if (currentMatch !== match.text) {
    throw new Error('structural_edit target changed after the ast-grep dry run; retry from fresh evidence');
  }

  const replacement = Buffer.from(match.replacement, 'utf8');
  const output = Buffer.concat([source.subarray(0, start), replacement, source.subarray(end)]);
  atomicWrite(absolutePath, output);

  const before = bounded(match.text);
  const after = bounded(match.replacement);
  return {
    path: params.path,
    engine: 'ast-grep',
    language: match.language ?? null,
    matched_range: match.range ?? null,
    byte_range: { start, end },
    before,
    after,
  };
}
