import fs from 'node:fs';
import path from 'node:path';

const OPERATIONS = new Set(['insert_before', 'insert_after', 'replace']);

function positiveLine(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive 1-based line number`);
  }
  return value;
}

function resolveWorktreeFile(root, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    throw new Error('path is required');
  }
  const worktree = path.resolve(root);
  const absolutePath = path.resolve(worktree, requestedPath);
  if (absolutePath !== worktree && !absolutePath.startsWith(`${worktree}${path.sep}`)) {
    throw new Error('safe_edit path escapes the current worktree');
  }
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`safe_edit target is not an existing file: ${requestedPath}`);
  }
  const targetStat = fs.lstatSync(absolutePath);
  if (targetStat.isSymbolicLink()) {
    throw new Error('safe_edit refuses symbolic-link targets');
  }
  if (!targetStat.isFile()) {
    throw new Error(`safe_edit target is not an existing file: ${requestedPath}`);
  }
  return absolutePath;
}

function splitLogicalLines(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalNewline = source.endsWith('\n');
  const normalized = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (hasFinalNewline) lines.pop();
  return { lines, newline, hasFinalNewline };
}

function blockLines(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function atomicWrite(absolutePath, content) {
  const stat = fs.statSync(absolutePath);
  const tempPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.pi-safe-edit-${process.pid}-${Date.now()}`,
  );
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: stat.mode & 0o777 });
    fs.renameSync(tempPath, absolutePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export function safeEdit(root, params) {
  const operation = String(params?.operation ?? '');
  if (!OPERATIONS.has(operation)) {
    throw new Error(`safe_edit operation must be one of: ${[...OPERATIONS].join(', ')}`);
  }

  const absolutePath = resolveWorktreeFile(root, params.path);
  const source = fs.readFileSync(absolutePath, 'utf8');
  if (source.length === 0) throw new Error('safe_edit requires an existing target line; use write for an empty file');
  const { lines, newline, hasFinalNewline } = splitLogicalLines(source);
  if (lines.length === 0) {
    throw new Error('safe_edit requires an existing target line; use write for an empty file');
  }

  const startLine = positiveLine(params.start_line, 'start_line');
  const endLine = operation === 'replace'
    ? positiveLine(params.end_line ?? startLine, 'end_line')
    : startLine;
  if (endLine < startLine) throw new Error('end_line must be >= start_line');
  if (startLine > lines.length || endLine > lines.length) {
    throw new Error(`safe_edit range ${startLine}-${endLine} is outside the current file (1-${lines.length})`);
  }

  const selected = lines.slice(startLine - 1, endLine).join(newline);
  const expectedMarker = typeof params.expected_marker === 'string'
    ? params.expected_marker
    : '';
  if (expectedMarker && !selected.includes(expectedMarker)) {
    throw new Error(`safe_edit expected_marker was not found in current lines ${startLine}-${endLine}`);
  }

  const replacement = blockLines(params.text);
  if (replacement.length === 0) throw new Error('safe_edit text must contain at least one line');

  let changedStart;
  let changedEnd;
  if (operation === 'insert_before') {
    lines.splice(startLine - 1, 0, ...replacement);
    changedStart = startLine;
    changedEnd = startLine + replacement.length - 1;
  } else if (operation === 'insert_after') {
    lines.splice(startLine, 0, ...replacement);
    changedStart = startLine + 1;
    changedEnd = startLine + replacement.length;
  } else {
    lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
    changedStart = startLine;
    changedEnd = startLine + replacement.length - 1;
  }

  const output = lines.join(newline) + (hasFinalNewline ? newline : '');
  atomicWrite(absolutePath, output);

  return {
    path: params.path,
    operation,
    selected_start_line: startLine,
    selected_end_line: endLine,
    changed_start_line: changedStart,
    changed_end_line: changedEnd,
    line_delta: replacement.length - (operation === 'replace' ? endLine - startLine + 1 : 0),
  };
}
