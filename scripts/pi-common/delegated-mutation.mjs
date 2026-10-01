import fs from 'node:fs';
import path from 'node:path';

// Delegated large mutation: the parent Implementer decides WHAT to change (path, operation,
// intent, requirements); a dedicated writer subagent only materializes the payload under the
// large output ceiling; the runtime alone validates and applies it. The writer never touches
// the worktree, so snapshots, no-op detection, rollback and verification permits stay
// owned by the normal mutation path.

export const DELEGATED_MUTATION_OPERATIONS = Object.freeze(['write', 'edit']);
// Sanity bound for the structured schema only; what the writer can actually return is bounded
// by its output-token ceiling.
export const MAX_DELEGATED_CONTENT_CHARS = 200000;

// An edit makes the writer return the WHOLE rewritten file, so the admissible source size is
// derived from the writer's OUTPUT ceiling, not its context window. Source code averages
// roughly 3-4 chars/token; 2.5 is deliberately pessimistic to absorb JSON string escaping.
// The reserve covers writer reasoning, the structured-output wrapper and the added change.
export const CONSERVATIVE_CHARS_PER_TOKEN = 2.5;
export const WRITER_OUTPUT_RESERVE_RATIO = 0.4;

export function maxEditSourceChars(writerMaxTokens) {
  const tokens = Number(writerMaxTokens);
  if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error('writer max tokens must be a positive integer');
  return Math.floor(tokens * (1 - WRITER_OUTPUT_RESERVE_RATIO) * CONSERVATIVE_CHARS_PER_TOKEN);
}

export const MUTATION_WRITER_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    operation: { type: 'string', enum: [...DELEGATED_MUTATION_OPERATIONS] },
    path: { type: 'string', minLength: 1, maxLength: 1000 },
    content: { type: 'string', minLength: 1, maxLength: MAX_DELEGATED_CONTENT_CHARS },
  },
  required: ['operation', 'path', 'content'],
  additionalProperties: false,
});

// "fix the issue", "implement task #12", "resolve it": a request that still asks the writer
// to decide what to change. The parent must delegate an already-decided mutation.
const VAGUE_INTENT = /^(please\s+)?(fix|implement|resolve|solve|address|complete|do|handle|finish|work\s+on)\s+(the\s+|this\s+|it|that)?\s*(issue|task|bug|ticket|problem|request|change|it)?\s*(#?\d+)?\s*\.?$/i;

export class DelegatedMutationRejected extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DelegatedMutationRejected';
    this.code = code;
  }
}

function reject(code, message) {
  throw new DelegatedMutationRejected(code, message);
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
// worktree. Called at request time AND again immediately before apply (the writer may run for
// minutes, so request-time validation alone leaves a TOCTOU window).
export function resolveDelegatedTarget(cwd, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    reject('missing_path', 'delegate_mutation requires a concrete target path');
  }
  if (path.isAbsolute(requestedPath)) reject('invalid_path', 'delegate_mutation path must be relative to the worktree');
  const root = path.resolve(cwd);
  const absolutePath = path.resolve(root, requestedPath);
  if (absolutePath === root || !absolutePath.startsWith(`${root}${path.sep}`)) {
    reject('invalid_path', 'delegate_mutation path escapes the current worktree');
  }
  const relative = path.relative(root, absolutePath);
  const parts = relative.split(path.sep);
  if (parts[0] === '.git') reject('invalid_path', 'delegate_mutation cannot target .git');

  let current = root;
  let targetStat = null;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) break; // the remaining components will be created as real directories/file
    if (stat.isSymbolicLink()) {
      reject('invalid_path', `delegate_mutation refuses symbolic links in the target path: ${path.relative(root, current)}`);
    }
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) reject('invalid_path', `delegate_mutation parent is not a directory: ${path.relative(root, current)}`);
    if (last) {
      if (!stat.isFile()) reject('invalid_path', `delegate_mutation target is not a regular file: ${relative}`);
      targetStat = stat;
    }
  }
  return { root, absolutePath, relative, exists: targetStat != null };
}

// Validates the parent's request before any writer is launched. Returns the normalized
// request plus, for edit only, the current target content handed to the writer.
export function validateDelegationRequest(cwd, params, { writerMaxTokens } = {}) {
  const operation = params?.operation;
  if (!DELEGATED_MUTATION_OPERATIONS.includes(operation)) {
    reject('invalid_operation', `delegate_mutation operation must be one of ${DELEGATED_MUTATION_OPERATIONS.join('/')}`);
  }
  const { absolutePath, relative, exists } = resolveDelegatedTarget(cwd, params?.path);
  const intent = typeof params?.intent === 'string' ? params.intent.trim() : '';
  if (intent.length < 12 || VAGUE_INTENT.test(intent)) {
    reject('vague_intent', 'delegate_mutation intent must state the concrete change already decided (for example "Create the complete standalone curses game"), not a request to figure out or fix the issue');
  }
  const requirements = Array.isArray(params?.requirements)
    ? params.requirements.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean)
    : [];
  if (requirements.length === 0) {
    reject('missing_requirements', 'delegate_mutation requires at least one concrete requirement/postcondition');
  }
  const context = typeof params?.context === 'string' ? params.context.trim() : '';

  // A full-replacement write never needs the old file; only an edit sends it to the writer.
  let currentContent = null;
  if (operation === 'edit') {
    if (!exists) reject('missing_target', `delegate_mutation edit target does not exist: ${relative}; use operation=write for a new file`);
    const limit = maxEditSourceChars(writerMaxTokens);
    const size = fs.statSync(absolutePath).size;
    if (size > limit) {
      reject('target_too_large', `delegate_mutation edit target (${size} bytes) cannot be rewritten in full within the writer output ceiling (limit ${limit} chars); use bounded direct structural_edit/safe_edit calls`);
    }
    currentContent = fs.readFileSync(absolutePath, 'utf8');
    if (currentContent.length > limit) {
      reject('target_too_large', `delegate_mutation edit target (${currentContent.length} chars) cannot be rewritten in full within the writer output ceiling (limit ${limit} chars); use bounded direct structural_edit/safe_edit calls`);
    }
  }
  return {
    request: { operation, path: relative, intent, requirements, context },
    absolutePath,
    currentContent,
  };
}

// The writer gets only what it needs to materialize this one decided mutation.
export function mutationWriterTask({ request, currentContent, issue, preparation }) {
  const lines = [
    `Materialize exactly one already-decided repository mutation. Return only the structured result: operation "${request.operation}", path "${request.path}", and content.`,
    request.operation === 'edit'
      ? 'content must be the COMPLETE new contents of the existing file below with the requested change applied. Preserve every unrelated line exactly.'
      : 'content must be the COMPLETE contents of the file at this path.',
    'Do not choose another path or operation, do not redesign the task, and do not add work beyond the intent and requirements.',
    '',
    `Target path: ${request.path}`,
    `Operation: ${request.operation}`,
    `Intent: ${request.intent}`,
    'Requirements:',
    ...request.requirements.map(item => `- ${item}`),
  ];
  if (request.context) lines.push('', 'Parent-provided evidence:', request.context);
  if (preparation?.state === 'PREPARATION_FALLBACK') {
    lines.push('', 'Preparation: PREPARATION_FALLBACK (no planner output is available; rely on the issue, intent and requirements).');
  } else if (preparation?.steps?.length) {
    lines.push('', 'Prepared plan:', ...preparation.steps.map((step, index) => `${index + 1}. ${step}`));
  }
  if (issue) lines.push('', 'Issue title:', issue.title, '', 'Issue body:', issue.body);
  if (currentContent != null) {
    lines.push('', `Current contents of ${request.path}:`, '<<<CURRENT_FILE', currentContent, 'CURRENT_FILE>>>');
  }
  return lines.join('\n');
}

// A writer result is applied only when it is exactly the requested mutation.
export function validateWriterResult(value, request) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject('invalid_output', 'Mutation writer returned a non-object structured result');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'content,operation,path') {
    reject('invalid_output', 'Mutation writer returned unexpected structured fields');
  }
  if (value.operation !== request.operation) {
    reject('operation_mismatch', `Mutation writer returned operation ${String(value.operation)} for a delegated ${request.operation}`);
  }
  if (typeof value.path !== 'string' || path.normalize(value.path) !== path.normalize(request.path)) {
    reject('path_mismatch', `Mutation writer returned path ${String(value.path)} for delegated path ${request.path}`);
  }
  if (typeof value.content !== 'string' || !value.content.trim()) {
    reject('empty_content', 'Mutation writer returned empty content');
  }
  if (value.content.length > MAX_DELEGATED_CONTENT_CHARS) {
    reject('oversized_content', `Mutation writer content exceeds ${MAX_DELEGATED_CONTENT_CHARS} chars`);
  }
  return value.content;
}

// Re-validates the target immediately before writing, then writes the validated payload
// atomically. For an edit, the file must still hold exactly the content the writer rewrote;
// otherwise the full rewrite would silently discard a concurrent change. Returns
// changed=false (and touches nothing) when the bytes already match.
export function applyDelegatedMutation(cwd, request, content, { expectedContent = null } = {}) {
  const { absolutePath, exists } = resolveDelegatedTarget(cwd, request.path);
  if (request.operation === 'edit') {
    if (!exists) reject('target_changed', `delegate_mutation edit target disappeared before apply: ${request.path}`);
    if (fs.readFileSync(absolutePath, 'utf8') !== expectedContent) {
      reject('target_changed', `delegate_mutation edit target changed while the writer ran: ${request.path}; nothing was applied`);
    }
  }
  if (exists && fs.readFileSync(absolutePath).equals(Buffer.from(content, 'utf8'))) {
    return { changed: false, bytes: Buffer.byteLength(content, 'utf8') };
  }
  const mode = exists ? fs.statSync(absolutePath).mode & 0o777 : 0o644;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.pi-delegated-${process.pid}-${Date.now()}`,
  );
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode, flag: 'wx' });
    fs.renameSync(tempPath, absolutePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return { changed: true, bytes: Buffer.byteLength(content, 'utf8') };
}
