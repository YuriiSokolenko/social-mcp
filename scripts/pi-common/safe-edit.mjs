import fs from 'node:fs';
import path from 'node:path';

const OPERATIONS = new Set(['insert_before', 'insert_after', 'replace']);
const POST_EDIT_PREVIEW_MAX_CHARS = 2000;
const FAILURE_CONTEXT_PADDING_LINES = 3;
const FAILURE_CONTEXT_MAX_CHARS = 2000;

// Bounded current-worktree context around a failed deterministic anchor, so the caller can
// retry the same local edit without opening broad repository evidence merely to see the
// current few lines near the mismatch.
function failureContext(lines, start, end) {
  const from = Math.max(1, start - FAILURE_CONTEXT_PADDING_LINES);
  const to = Math.min(lines.length, end + FAILURE_CONTEXT_PADDING_LINES);
  const numbered = [];
  for (let n = from; n <= to; n += 1) numbered.push(`${n}: ${lines[n - 1]}`);
  const joined = numbered.join('\n');
  const truncated = joined.length > FAILURE_CONTEXT_MAX_CHARS;
  const text = truncated ? joined.slice(0, FAILURE_CONTEXT_MAX_CHARS) : joined;
  return `Current lines ${from}-${to}:\n${text}`;
}

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

function adjacentOverlap(lines, startLine, operation, replacement) {
  const maxOverlap = operation === 'insert_after'
    ? Math.min(replacement.length, lines.length - startLine)
    : Math.min(replacement.length, startLine - 1);

  for (let count = maxOverlap; count >= 2; count -= 1) {
    const inserted = operation === 'insert_after'
      ? replacement.slice(-count)
      : replacement.slice(0, count);
    const adjacent = operation === 'insert_after'
      ? lines.slice(startLine, startLine + count)
      : lines.slice(startLine - 1 - count, startLine - 1);
    if (inserted.every((line, index) => line === adjacent[index])) {
      return count;
    }
  }
  return 0;
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

  const startLine = positiveLine(params.start_line, 'start_line');
  if (operation !== 'replace' && params.end_line != null) {
    throw new Error('end_line is supported only for replace operations');
  }
  const endLine = operation === 'replace'
    ? positiveLine(params.end_line ?? startLine, 'end_line')
    : startLine;
  if (endLine < startLine) throw new Error('end_line must be >= start_line');
  if (startLine > lines.length || endLine > lines.length) {
    const tail = failureContext(lines, lines.length, lines.length);
    throw new Error(`safe_edit range ${startLine}-${endLine} is outside the current file (1-${lines.length}). ${tail}`);
  }

  const selected = lines.slice(startLine - 1, endLine).join(newline);
  const expectedMarker = typeof params.expected_marker === 'string'
    ? params.expected_marker
    : '';
  if (expectedMarker && !selected.includes(expectedMarker)) {
    const context = failureContext(lines, startLine, endLine);
    throw new Error(`safe_edit expected_marker was not found in current lines ${startLine}-${endLine}. ${context}`);
  }

  const replacement = blockLines(params.text);
  if (replacement.length === 0) throw new Error('safe_edit text must contain at least one line');

  if (operation === 'insert_before' || operation === 'insert_after') {
    const overlap = adjacentOverlap(lines, startLine, operation, replacement);
    if (overlap > 0) {
      throw new Error(
        `safe_edit refuses insertion that duplicates ${overlap} adjacent existing lines; insert only the new content`,
      );
    }
  }

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
  const changed = output !== source;
  if (changed) atomicWrite(absolutePath, output);

  // Re-read only after an effective mutation. A successful no-op is explicit
  // so runtime progress and rollback state are not reset by identical content.
  const written = changed ? fs.readFileSync(absolutePath, 'utf8') : source;
  const { lines: writtenLines } = splitLogicalLines(written);
  const postEditText = writtenLines.slice(changedStart - 1, changedEnd).join('\n');
  const postEditTruncated = postEditText.length > POST_EDIT_PREVIEW_MAX_CHARS;

  return {
    path: params.path,
    operation,
    changed,
    selected_start_line: startLine,
    selected_end_line: endLine,
    changed_start_line: changedStart,
    changed_end_line: changedEnd,
    line_delta: replacement.length - (operation === 'replace' ? endLine - startLine + 1 : 0),
    post_edit: {
      start_line: changedStart,
      end_line: changedEnd,
      text: postEditTruncated
        ? postEditText.slice(0, POST_EDIT_PREVIEW_MAX_CHARS)
        : postEditText,
      truncated: postEditTruncated,
    },
  };
}
