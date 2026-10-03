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
]);
const TERMINAL_TOOLS = new Set(['submit_result', 'submit_repair']);
const NEUTRAL_TOOLS = new Set([
  'set_response_budget',
  'need_more_evidence',
  'subagents_enable',
  'prepare_implementation',
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

    if (TERMINAL_TOOLS.has(tool)) {
      this.declaredEvidencePending = false;
      return { ...base, classification: 'terminal' };
    }

    if (isError || blocked) {
      const errorClass = normalizeErrorClass(result, blocked);
      const family = strategyFamily(tool, input, productiveState, errorClass);
      this._push(this.failureWindow, family);
      const count = this._count(this.failureWindow, family);
      const classification = blocked ? 'blocked' : 'error';
      const failed = { ...base, classification, errorClass };
      if (count >= this.revisitThreshold) {
        return this._trip(failed, 'repeated_failed_strategy', 'failure_strategy', count, {
          repeatedFailure: true,
        });
      }
      return failed;
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

      if (changed && seenBefore === 0) this._markNovelRepositoryState();
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
