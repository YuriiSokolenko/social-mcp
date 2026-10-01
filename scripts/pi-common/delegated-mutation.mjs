import fs from 'node:fs';
import path from 'node:path';

// Delegated large mutation: the parent Implementer decides WHAT to change (path, operation,
// intent, requirements); a dedicated writer subagent only materializes the payload under the
// large output ceiling; the runtime alone validates and applies it. The writer never touches
// the worktree, so snapshots, no-op detection, rollback and verification permits stay
// owned by the normal mutation path.

export const DELEGATED_MUTATION_TOOL = 'delegate_mutation';
export const DELEGATED_MUTATION_OPERATIONS = Object.freeze(['write', 'edit']);
// Upper bounds keep the writer prompt and its payload inside one 16K response.
export const MAX_DELEGATED_EDIT_SOURCE_CHARS = 120000;
export const MAX_DELEGATED_CONTENT_CHARS = 200000;

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

function resolveTarget(cwd, requestedPath) {
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
  if (relative.split(path.sep)[0] === '.git') reject('invalid_path', 'delegate_mutation cannot target .git');
  return { root, absolutePath, relative };
}

// Validates the parent's request before any writer is launched. Returns the normalized
// request plus the current target bytes (required for edit, optional context for write).
export function validateDelegationRequest(cwd, params) {
  const operation = params?.operation;
  if (!DELEGATED_MUTATION_OPERATIONS.includes(operation)) {
    reject('invalid_operation', `delegate_mutation operation must be one of ${DELEGATED_MUTATION_OPERATIONS.join('/')}`);
  }
  const { absolutePath, relative } = resolveTarget(cwd, params?.path);
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

  let currentContent = null;
  if (fs.existsSync(absolutePath)) {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) reject('invalid_path', `delegate_mutation target is not a regular file: ${relative}`);
    currentContent = fs.readFileSync(absolutePath, 'utf8');
  }
  if (operation === 'edit') {
    if (currentContent == null) reject('missing_target', `delegate_mutation edit target does not exist: ${relative}; use operation=write for a new file`);
    if (currentContent.length > MAX_DELEGATED_EDIT_SOURCE_CHARS) {
      reject('target_too_large', `delegate_mutation edit target is too large for one writer response (${currentContent.length} chars); use bounded direct structural_edit/safe_edit calls`);
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

// Atomic write of the validated payload. Returns changed=false (and touches nothing) when the
// bytes already match, mirroring the no-op rule for direct writes.
export function applyDelegatedMutation(absolutePath, content) {
  if (fs.existsSync(absolutePath) && fs.readFileSync(absolutePath).equals(Buffer.from(content, 'utf8'))) {
    return { changed: false, bytes: Buffer.byteLength(content, 'utf8') };
  }
  const mode = fs.existsSync(absolutePath) ? fs.statSync(absolutePath).mode & 0o777 : 0o644;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.pi-delegated-${process.pid}-${Date.now()}`,
  );
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode });
    fs.renameSync(tempPath, absolutePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return { changed: true, bytes: Buffer.byteLength(content, 'utf8') };
}
