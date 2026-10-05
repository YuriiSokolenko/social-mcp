import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const LOOP_GUARD_WINDOW_SIZE = 8;
export const LOOP_GUARD_REVISIT_THRESHOLD = 3;
export const LOOP_GUARD_MAX_WINDOW_SIZE = 64;
export const LOOP_GUARD_UNTRACKED_HASH_MAX_BYTES = 1024 * 1024;

export function loopGuardLimits(env = process.env) {
  const configured = (value, fallback) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const windowSize = Math.min(
    configured(env.PI_LOOP_GUARD_WINDOW, LOOP_GUARD_WINDOW_SIZE),
    LOOP_GUARD_MAX_WINDOW_SIZE,
  );
  const revisitThreshold = Math.min(
    configured(env.PI_LOOP_GUARD_THRESHOLD, LOOP_GUARD_REVISIT_THRESHOLD),
    windowSize,
  );
  return { windowSize, revisitThreshold };
}

const MUTATION_TOOLS = new Set([
  'structural_edit',
  'safe_edit',
  'edit',
  'write',
  'begin_coding_session',
  'rollback_last_mutation',
  'recover_worktree',
  'undo_mutation',
]);
const TERMINAL_TOOLS = new Set(['submit_result', 'submit_repair']);
const NEUTRAL_TOOLS = new Set([
  'set_response_budget',
  'need_more_evidence',
  'subagents_enable',
  'declare_task_complexity',
]);

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(name + ' must be a positive integer');
  }
  return value;
}

function digest(value) {
  const input = Buffer.isBuffer(value) ? value : String(value);
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function normalizeValue(value, depth = 0) {
  if (depth >= 5) return '[depth-capped]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length <= 512) return value;
    return value.slice(0, 256) + '#sha256:' + digest(value) + '#len:' + value.length;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 32).map(item => normalizeValue(item, depth + 1));
    if (value.length > 32) items.push('[items-capped:' + value.length + ']');
    return items;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const selected = keys.slice(0, 32);
    const result = {};
    for (const key of selected) result[key] = normalizeValue(value[key], depth + 1);
    if (keys.length > 32) result.__keys_capped__ = keys.length;
    return result;
  }
  return String(value);
}

export function boundedStableHash(value) {
  return digest(JSON.stringify(normalizeValue(value)));
}

function explicitResultText(result) {
  if (typeof result === 'string') return result;
  if (Array.isArray(result?.content)) {
    return result.content
      .filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('\n');
  }
  return null;
}

function boundedResultText(result) {
  const explicit = explicitResultText(result);
  if (explicit != null) return explicit.slice(0, 4096);
  return JSON.stringify(normalizeValue(result)).slice(0, 4096);
}

const EVIDENCE_COLLECTION_KEYS = Object.freeze([
  'matches',
  'results',
  'items',
  'files',
  'symbols',
  'hits',
  'entries',
  'commits',
]);

function candidateEvidencePresence(candidate) {
  for (const key of EVIDENCE_COLLECTION_KEYS) {
    if (Object.hasOwn(candidate, key) && Array.isArray(candidate[key])) {
      return candidate[key].length > 0;
    }
  }

  const hasStdout = Object.hasOwn(candidate, 'stdout');
  const hasStderr = Object.hasOwn(candidate, 'stderr');
  if (hasStdout || hasStderr) {
    const stdout = typeof candidate.stdout === 'string' ? candidate.stdout.trim() : '';
    const stderr = typeof candidate.stderr === 'string' ? candidate.stderr.trim() : '';
    return Boolean(stdout || stderr);
  }

  if (Object.hasOwn(candidate, 'output') && typeof candidate.output === 'string') {
    return candidate.output.trim().length > 0;
  }

  return null;
}

function textSerializesTopLevelResult(result, text) {
  if (!text?.trim()) return false;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

  const keys = Object.keys(parsed);
  if (keys.length === 0) return false;
  return keys.every(key =>
    Object.hasOwn(result, key) &&
    JSON.stringify(normalizeValue(parsed[key])) === JSON.stringify(normalizeValue(result[key]))
  );
}

function structuredEvidencePresence(result) {
  if (!result || typeof result !== 'object') return null;

  // Explicit structured payloads are authoritative: they describe the tool's
  // evidence result even when the human-readable content merely serializes it.
  const candidates = [];
  if (result.structuredContent && typeof result.structuredContent === 'object') candidates.push(result.structuredContent);
  if (result.details && typeof result.details === 'object') candidates.push(result.details);
  for (const candidate of candidates) {
    const presence = candidateEvidencePresence(candidate);
    if (presence != null) return presence;
  }

  // Top-level collection names are less trustworthy because wrappers may use
  // generic fields such as items/files/entries for unrelated metadata. Useful
  // human-readable text therefore wins unless it is just a JSON serialization
  // of fields already present on the top-level result.
  const topLevelPresence = candidateEvidencePresence(result);
  const explicitText = explicitResultText(result);
  if (explicitText?.trim()) {
    if (topLevelPresence === false && textSerializesTopLevelResult(result, explicitText)) return false;
    return null;
  }

  return topLevelPresence;
}

export function hasMeaningfulEvidence(result, toolName = '') {
  const structured = structuredEvidencePresence(result);
  if (structured != null) return structured;
  if (result == null) return false;
  if (Array.isArray(result) && result.length === 0) return false;
  if (typeof result === 'object' && Object.keys(result).length === 0) return false;
  const text = boundedResultText(result).trim();
  // Pi 0.87.x exposes no structured stdout/stderr for a successful empty bash call;
  // the built-in bash tool returns this exact result sentinel instead. This is result-shape
  // handling, not command-string inspection, and newer Pi structuredContent.output above wins.
  if (toolName === 'bash' && text === '(no output)') return false;
  return text.length > 0;
}

export function normalizeErrorClass(result, blocked = false) {
  if (blocked) return 'blocked';
  const text = boundedResultText(result).toLowerCase();
  if (/timed? ?out|timeout/.test(text)) return 'timeout';
  if (/permission denied|eacces|not permitted/.test(text)) return 'permission';
  if (/expected_marker|oldtext|old text|anchor/.test(text) && /not found|missing|match/.test(text)) {
    return 'anchor_not_found';
  }
  if (/not found|no such file|enoent/.test(text)) return 'not_found';
  if (/outside .*file|range|line .*outside/.test(text)) return 'invalid_range';
  if (/multiple .*match|more than one|ambiguous/.test(text)) return 'ambiguous_match';
  if (/blocked|refused|not allowed/.test(text)) return 'blocked';
  const normalized = text
    .replace(/["'][^"']{1,200}["']/g, '<quoted>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
  return normalized ? 'error_' + digest(normalized) : 'error_unknown';
}

function untrackedEntry(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stat = fs.lstatSync(absolutePath);
  const mode = (stat.mode & 0o7777).toString(8);
  if (stat.isSymbolicLink()) {
    return { path: relativePath, mode, type: 'symlink', digest: digest(fs.readlinkSync(absolutePath)) };
  }
  if (stat.isFile()) {
    if (stat.size <= LOOP_GUARD_UNTRACKED_HASH_MAX_BYTES) {
      return { path: relativePath, mode, type: 'file', digest: digest(fs.readFileSync(absolutePath)) };
    }
    return {
      path: relativePath,
      mode,
      type: 'file',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      digest: 'metadata-only',
    };
  }
  return { path: relativePath, mode, type: 'other' };
}

export function repositoryStateFingerprint(root) {
  try {
    const cwd = path.resolve(root);
    const diff = execFileSync(
      'git',
      ['diff', '--binary', '--no-ext-diff', '--full-index', '--no-renames', 'HEAD', '--'],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const untrackedRaw = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const untracked = untrackedRaw
      .split('\0')
      .filter(Boolean)
      .sort()
      .map(relativePath => untrackedEntry(cwd, relativePath));
    return digest(JSON.stringify({ diff: digest(diff), untracked }));
  } catch {
    // Fingerprinting is advisory. A transient Git/filesystem failure must not
    // prevent the requested tool from running or complete its progress hook.
    return null;
  }
}

export function isSemanticMutationTool(toolName) {
  return MUTATION_TOOLS.has(toolName);
}

function targetFamily(input) {
  const value = input?.path ?? input?.file ?? input?.filePath ?? input?.target ?? '';
  return typeof value === 'string' ? value.slice(0, 1000) : '';
}

// A failed terminal submission is identified by its unresolved obligation, not by prose.
// Keep only trusted structured fields that determine the next repair. Cleanup hints may echo
// expected_files or mutation ids; those are deliberately excluded from the fingerprint.
const OBLIGATION_LISTS = Object.freeze([
  ['unexpected', /unexpected files: ([^;]*?)(?=;|\. |$)/],
  ['missing', /missing files: ([^;]*?)(?=;|\. |$)/],
  ['scratch', /Runtime scratch artifacts cannot be submitted: (.*?)\. /],
]);

function parsePathList(text) {
  return text.split(',').map(item => item.trim()).filter(Boolean);
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => item.trim()))].sort();
}

function structuredSubmissionError(text) {
  const parseObject = value => {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const exact = parseObject(text);
  if (exact) return exact;
  // Tool runtimes may prefix a thrown Error message (for example "Error: {...}").
  // Recover only one bounded JSON object; prose outside it is not part of the obligation.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? parseObject(text.slice(start, end + 1)) : null;
}

const CONFLICT_OBLIGATION_PATTERNS = Object.freeze([
  /Latest dev conflicts with the implementation\. Resolve these files and retry submit_result: ([^\n\r]+)/,
  /PR conflicts with current dev\. Resolve these files and retry submit_repair: ([^\n\r]+)/,
]);

function structuredErrorStrings(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2) return [];
  const result = [];
  for (const key of ['message', 'error', 'reason', 'summary']) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) result.push(item);
    else if (item && typeof item === 'object') result.push(...structuredErrorStrings(item, depth + 1));
  }
  return result;
}

function conflictMessageCandidates(text) {
  const parse = value => {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };
  const decoded = [];
  for (const candidate of [text, text.replace(/^Error:\s*/, '')]) {
    const parsed = parse(candidate);
    if (typeof parsed === 'string' && parsed.trim()) decoded.push(parsed);
    else if (parsed && typeof parsed === 'object') decoded.push(...structuredErrorStrings(parsed));
  }
  if (!decoded.length) {
    const parsedObject = structuredSubmissionError(text);
    if (parsedObject) decoded.push(...structuredErrorStrings(parsedObject));
  }
  return uniqueStrings(decoded.length ? decoded : [text]);
}

function conflictObligation(text) {
  // Prefer decoded structured strings so escaped newlines and JSON delimiters can never become
  // part of a conflict path. Fall back to raw prose only when no structured wrapper is present.
  const candidates = conflictMessageCandidates(text);
  for (const candidate of candidates) {
    const match = CONFLICT_OBLIGATION_PATTERNS
      .map(pattern => pattern.exec(candidate))
      .find(Boolean);
    if (!match) continue;
    const conflictPaths = uniqueStrings(parsePathList(match[1]));
    if (!conflictPaths.length) continue;
    return {
      kind: 'conflict',
      code: 'latest_dev_conflict',
      paths: conflictPaths,
      conflictPaths,
      key: boundedStableHash({ code: 'latest_dev_conflict', conflict_paths: conflictPaths }),
    };
  }
  return null;
}

export function submissionObligation(result) {
  const text = boundedResultText(result);
  const lists = {};
  for (const [name, pattern] of OBLIGATION_LISTS) {
    const match = pattern.exec(text);
    if (match) lists[name] = uniqueStrings(parsePathList(match[1]));
  }
  const paths = uniqueStrings(Object.values(lists).flat());
  if (paths.length > 0) {
    return {
      kind: lists.scratch?.length ? 'file_set_cleanup' : 'file_set',
      code: 'implementer_file_set',
      paths,
      unexpected: lists.unexpected ?? [],
      missing: lists.missing ?? [],
      scratch: lists.scratch ?? [],
      key: boundedStableHash(lists),
    };
  }

  const conflict = conflictObligation(text);
  if (conflict) return conflict;

  const parsed = structuredSubmissionError(text);
  const code = typeof parsed?.code === 'string' ? parsed.code : '';
  if (!code) return null;

  if (code === 'missing_publication_fields') {
    const missingFields = uniqueStrings(parsed.missing_fields);
    return {
      kind: 'metadata',
      code,
      paths: [],
      missingFields,
      key: boundedStableHash({ code, missing_fields: missingFields }),
    };
  }
  if (code === 'TARGETED_BEHAVIORAL_VALIDATION_REQUIRED') {
    const requiredTargets = uniqueStrings(parsed.required_targets);
    const action = parsed.action && typeof parsed.action === 'object' && !Array.isArray(parsed.action)
      ? {
          kind: typeof parsed.action.kind === 'string' ? parsed.action.kind : null,
          paths: uniqueStrings(parsed.action.paths),
          targets: uniqueStrings(parsed.action.targets),
          profile: typeof parsed.action.profile === 'string' ? parsed.action.profile : null,
        }
      : null;
    return {
      kind: 'validation',
      code,
      // Validation targets are not mutation obligations: an unrelated edit to a test path must
      // not make the failed submission disappear. Only authoritative passing validation does.
      paths: [],
      requiredTargets,
      action,
      key: boundedStableHash({ code, required_targets: requiredTargets, action }),
    };
  }
  if (code === 'PREPARED_OUTPUTS_REQUIRED') {
    const missingOutputs = uniqueStrings(parsed.missing_outputs);
    return {
      kind: 'prepared_outputs',
      code,
      paths: missingOutputs,
      missingOutputs,
      key: boundedStableHash({ code, missing_outputs: missingOutputs }),
    };
  }

  return {
    kind: 'coded',
    code,
    paths: [],
    key: boundedStableHash({ code }),
  };
}

function passingValidationResult(result) {
  if (result?.details?.status === 'pass') return true;
  const text = explicitResultText(result);
  if (!text) return false;
  try {
    return JSON.parse(text)?.status === 'pass';
  } catch {
    return false;
  }
}

function exactValidationActionMatches(obligation, tool, input) {
  if (tool !== 'run_check' || obligation?.kind !== 'validation' || !obligation.action) return false;
  const expected = obligation.action;
  // A targeted validation obligation is authoritative only when it names an exact run_check
  // kind. An empty/malformed action must never be discharged by an unrelated passing check.
  if (!expected.kind || input?.kind !== expected.kind) return false;
  if (expected.profile && input?.profile !== expected.profile) return false;
  const same = (left, right) =>
    JSON.stringify(uniqueStrings(left)) === JSON.stringify(uniqueStrings(right));
  if (expected.paths.length && !same(input?.paths, expected.paths)) return false;
  if (expected.targets.length && !same(input?.targets, expected.targets)) return false;
  return true;
}

function mutationResultPaths(input, result) {
  // Explicit mutation input is the strongest target evidence. Aggregate result fields such as
  // files/paths/changed_files often describe the whole worktree and must not be treated as files
  // touched by this one mutation.
  const direct = targetFamily(input);
  if (direct) return [direct];

  const candidates = [];
  const collectSingularPath = value => {
    if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
  };
  collectSingularPath(result?.details?.path);
  collectSingularPath(result?.path);
  try {
    const parsed = JSON.parse(explicitResultText(result) ?? '');
    collectSingularPath(parsed?.path);
  } catch {
    // Unstructured mutation result: no authoritative target beyond the fields above.
  }
  return uniqueStrings(candidates);
}

function normalizedPath(value) {
  return String(value ?? '')
    .split(path.win32.sep).join('/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

function targetMatchesObligationPath(target, obligationPath, repositoryRoot = null) {
  let actual = normalizedPath(target);
  let expected = normalizedPath(obligationPath);
  if (!actual || !expected) return false;

  if (repositoryRoot) {
    const root = path.resolve(repositoryRoot);
    const relativizeInsideRoot = value => {
      if (!path.isAbsolute(value)) return normalizedPath(value);
      const relative = path.relative(root, value);
      if (!relative || relative === '.') return '';
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
      return normalizedPath(relative);
    };
    actual = relativizeInsideRoot(actual);
    expected = relativizeInsideRoot(expected);
    // When the repository root is known, path identity is repository-relative and exact.
    // An absolute path outside that root can never satisfy a repository obligation merely
    // because it shares the same suffix (for example /tmp/other/src/a.js vs src/a.js).
    return Boolean(actual && expected && actual === expected);
  }

  if (actual === expected) return true;
  const actualAbsolute = path.isAbsolute(actual);
  const expectedAbsolute = path.isAbsolute(expected);
  if (actualAbsolute && !expectedAbsolute) return actual.endsWith('/' + expected);
  if (expectedAbsolute && !actualAbsolute) return expected.endsWith('/' + actual);
  return false;
}

export function mutationResolvesSubmissionObligation(obligation, input, result, repositoryRoot = null) {
  const paths = obligation?.paths ?? [];
  const targets = mutationResultPaths(input, result);
  return targets.some(target =>
    paths.some(item => targetMatchesObligationPath(target, item, repositoryRoot))
  );
}

function strategyFamily(tool, input, productiveState, errorClass) {
  const operation = typeof input?.operation === 'string' ? input.operation : '';
  return boundedStableHash({
    tool,
    target: targetFamily(input),
    operation,
    productiveState,
    errorClass,
  });
}

export class SemanticLoopGuard {
  constructor({
    windowSize = LOOP_GUARD_WINDOW_SIZE,
    revisitThreshold = LOOP_GUARD_REVISIT_THRESHOLD,
  } = {}) {
    this.windowSize = positiveInteger(Number(windowSize), 'loop guard windowSize');
    this.revisitThreshold = positiveInteger(Number(revisitThreshold), 'loop guard revisitThreshold');
    this.observationWindow = [];
    this.failureWindow = [];
    this.repositoryWindow = [];
    this.steerOutstanding = false;
    // Paths named by the outstanding failed terminal submission. Only a mutation that
    // touches one of them can count as resolving that blocker.
    this.terminalObligation = null;
    // Intentional one-shot credit: need_more_evidence declares that one successful
    // evidence call may resolve the missing fact even with an empty result. Errors
    // and blocked calls preserve the credit; the next successful eligible evidence
    // call consumes it, while mutation/terminal completion clears it.
    this.declaredEvidencePending = false;
  }

  _push(window, value, max = this.windowSize) {
    window.push(value);
    while (window.length > max) window.shift();
  }

  _count(window, value) {
    return window.reduce((count, item) => count + (item === value ? 1 : 0), 0);
  }

  _markNovelEvidence() {
    const recoveringFromSteer = this.steerOutstanding;
    this.steerOutstanding = false;
    if (recoveringFromSteer) this.observationWindow = [];
  }

  _markNovelRepositoryState() {
    this.steerOutstanding = false;
    this.failureWindow = [];
    // Repository mutations can invalidate the meaning of prior observations.
    // Start evidence repetition tracking fresh, but preserve repository history
    // so A -> B -> A -> C -> A remains detectable.
    this.observationWindow = [];
  }

  _trip(base, reason, fingerprintClass, revisitCount, flags = {}) {
    const action = this.steerOutstanding ? 'abort' : 'steer';
    if (action === 'steer') this.steerOutstanding = true;
    return {
      ...base,
      tripped: true,
      action,
      reason,
      fingerprintClass,
      revisitCount,
      window: this.windowSize,
      noOp: flags.noOp === true,
      repeatedObservation: flags.repeatedObservation === true,
      repeatedFailure: flags.repeatedFailure === true,
      returnedToSeenState: flags.returnedToSeenState === true,
    };
  }

  observe({
    stage = 'implementer',
    tool,
    input = {},
    result = null,
    isError = false,
    blocked = false,
    productiveState = 'inactive',
    repositoryStateBefore = null,
    repositoryStateAfter = null,
    mutationChanged = null,
    repositoryRoot = null,
  }) {
    const base = {
      stage,
      tool,
      classification: 'success_new_observation',
      repositoryState: repositoryStateAfter,
      tripped: false,
      action: null,
    };
    const declaredEvidenceEligible =
      this.declaredEvidencePending &&
      !TERMINAL_TOOLS.has(tool) &&
      !MUTATION_TOOLS.has(tool) &&
      !NEUTRAL_TOOLS.has(tool);

    if (TERMINAL_TOOLS.has(tool) && !isError && !blocked) {
      this.declaredEvidencePending = false;
      this.terminalObligation = null;
      return { ...base, classification: 'terminal' };
    }

    if (isError || blocked) {
      const terminalTool = TERMINAL_TOOLS.has(tool);
      const obligation = terminalTool && !blocked ? submissionObligation(result) : null;
      const errorClass = obligation ? 'submission_' + obligation.key : normalizeErrorClass(result, blocked);
      if (terminalTool) {
        if (obligation) {
          this.terminalObligation = obligation;
        } else if (!blocked || !this.terminalObligation) {
          // A blocked retry cannot provide new terminal diagnostics. Preserve any already
          // recognized obligation rather than replacing it with a generic blocked-call class.
          this.terminalObligation = { paths: [], key: errorClass };
        }
      }
      const family = strategyFamily(tool, terminalTool ? {} : input, productiveState, errorClass);
      this._push(this.failureWindow, family);
      const count = this._count(this.failureWindow, family);
      const classification = blocked ? 'blocked' : 'error';
      const failed = {
        ...base,
        classification,
        errorClass,
        obligation: TERMINAL_TOOLS.has(tool) ? this.terminalObligation : null,
      };
      if (count >= this.revisitThreshold) {
        return this._trip(failed, 'repeated_failed_strategy', 'failure_strategy', count, {
          repeatedFailure: true,
        });
      }
      return failed;
    }

    if (
      this.terminalObligation?.kind === 'validation' &&
      exactValidationActionMatches(this.terminalObligation, tool, input) &&
      passingValidationResult(result)
    ) {
      this.terminalObligation = null;
      this.steerOutstanding = false;
      this.failureWindow = [];
      this.observationWindow = [];
      return { ...base, classification: 'success_obligation_resolved' };
    }

    if (MUTATION_TOOLS.has(tool)) {
      this.declaredEvidencePending = false;
      if (
        typeof mutationChanged !== 'boolean' &&
        (!repositoryStateBefore || !repositoryStateAfter)
      ) {
        // Fingerprinting failed and no target-local snapshot is available:
        // the effect is unknown, so do not classify it as a no-op or revisit.
        return {
          ...base,
          classification: 'success_unclassified',
          repositoryState: repositoryStateAfter ?? repositoryStateBefore,
        };
      }
      if (repositoryStateBefore && this.repositoryWindow.length === 0) {
        this._push(this.repositoryWindow, repositoryStateBefore, this.windowSize + 1);
      } else if (
        repositoryStateBefore &&
        this.repositoryWindow.at(-1) !== repositoryStateBefore
      ) {
        this._push(this.repositoryWindow, repositoryStateBefore, this.windowSize + 1);
      }

      const changed = typeof mutationChanged === 'boolean'
        ? mutationChanged
        : Boolean(
            repositoryStateBefore &&
            repositoryStateAfter &&
            repositoryStateBefore !== repositoryStateAfter
          );
      const seenBefore = repositoryStateAfter
        ? this._count(this.repositoryWindow, repositoryStateAfter)
        : 0;

      const resolvesObligation = mutationResolvesSubmissionObligation(
        this.terminalObligation,
        input,
        result,
        repositoryRoot,
      );
      if (changed && this.terminalObligation && resolvesObligation) {
        // A relevant fix resolves the blocker even when it restores an already-seen state
        // (undo of an accidental B back to A). Repository revisit tracking stays intact.
        this.terminalObligation = null;
        if (seenBefore === 0) {
          this._markNovelRepositoryState();
        } else {
          this.steerOutstanding = false;
          this.failureWindow = [];
        }
      } else if (changed && seenBefore === 0 && !this.terminalObligation) {
        this._markNovelRepositoryState();
      }
      if (repositoryStateAfter) {
        this._push(this.repositoryWindow, repositoryStateAfter, this.windowSize + 1);
      }
      const repositoryCount = repositoryStateAfter
        ? this._count(this.repositoryWindow, repositoryStateAfter)
        : 0;

      if (!changed) {
        const family = strategyFamily(tool, input, productiveState, 'success_no_change');
        this._push(this.failureWindow, family);
        const count = this._count(this.failureWindow, family);
        const noOp = {
          ...base,
          classification: 'success_no_change',
          repositoryState: repositoryStateAfter ?? repositoryStateBefore,
        };
        if (count >= this.revisitThreshold) {
          return this._trip(noOp, 'repeated_no_op_mutation', 'repository_state', count, {
            noOp: true,
            returnedToSeenState: repositoryCount >= this.revisitThreshold,
          });
        }
        return noOp;
      }

      const changedResult = {
        ...base,
        classification: seenBefore > 0 ? 'returned_to_seen_state' : 'success_changed',
        repositoryState: repositoryStateAfter,
      };
      if (seenBefore > 0 && repositoryCount >= this.revisitThreshold) {
        return this._trip(
          changedResult,
          'repository_state_revisit',
          'repository_state',
          repositoryCount,
          { returnedToSeenState: true },
        );
      }
      return changedResult;
    }

    if (NEUTRAL_TOOLS.has(tool)) {
      if (tool === 'need_more_evidence') this.declaredEvidencePending = true;
      return { ...base, classification: 'success_neutral' };
    }

    const declaredEvidence = declaredEvidenceEligible;
    if (declaredEvidence) this.declaredEvidencePending = false;
    const meaningfulEvidence = hasMeaningfulEvidence(result, tool);
    const resultHash = boundedStableHash(result);
    if (!meaningfulEvidence && !declaredEvidence) {
      const family = boundedStableHash({
        tool,
        input: normalizeValue(input),
        productiveState,
        classification: 'success_no_evidence',
      });
      this._push(this.failureWindow, family);
      const count = this._count(this.failureWindow, family);
      const noEvidence = {
        ...base,
        classification: 'success_no_evidence',
        observationHash: resultHash,
        noOp: true,
      };
      if (count >= this.revisitThreshold) {
        return this._trip(
          noEvidence,
          'repeated_no_evidence',
          'evidence_noop',
          count,
          { noOp: true, repeatedObservation: true },
        );
      }
      return noEvidence;
    }

    const fingerprint = boundedStableHash({
      tool,
      input: normalizeValue(input),
      resultHash,
      productiveState,
    });
    const seenBefore = this._count(this.observationWindow, fingerprint);
    if (seenBefore === 0 || declaredEvidence) this._markNovelEvidence();
    this._push(this.observationWindow, fingerprint);
    const count = this._count(this.observationWindow, fingerprint);
    const observed = {
      ...base,
      classification: !meaningfulEvidence && declaredEvidence
        ? 'success_declared_evidence'
        : seenBefore > 0
          ? 'success_same_observation'
          : 'success_new_observation',
      observationHash: resultHash,
      declaredEvidence,
    };
    if (count >= this.revisitThreshold) {
      return this._trip(
        observed,
        'repeated_observation',
        'observation',
        count,
        { repeatedObservation: true },
      );
    }
    return observed;
  }
}
