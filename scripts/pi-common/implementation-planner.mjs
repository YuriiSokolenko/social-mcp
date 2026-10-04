import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import { recordDescendantMetric, runStructuredSubagent } from './structured-subagent.mjs';
import { baseRef } from './project-config.mjs';
import { PREPARATION_FALLBACK_EVIDENCE_BUDGET } from './progress-controller.mjs';

// Evidence needs are reported independently of complexity: a nontrivial task can still need
// zero repository evidence (a fresh standalone file from a complete spec), so complexity is
// not a valid proxy for how many evidence actions the Implementer should be granted.
export const MAX_PLANNER_EVIDENCE_BUDGET = 6;

const MAX_PLANNER_STEP_LENGTH = 240;
const MAX_PLANNER_FACTS = 6;
const MAX_PLANNER_FACT_LENGTH = 200;

// Planner evidence budget: how many read-only repository actions the planner itself may spend
// while preparing the plan. Deliberately separate from the output `evidence_budget` above (the
// planner's estimate for the main Implementer); neither value is ever derived from the other.
export const MAX_PLANNER_REPOSITORY_EVIDENCE = 6;
export const DEFAULT_PLANNER_EVIDENCE_BUDGET = MAX_PLANNER_REPOSITORY_EVIDENCE;
export const PLANNER_EVIDENCE_BUDGET_ENV = 'PI_PLANNER_EVIDENCE_BUDGET';
export const PLANNER_EVIDENCE_STATE_FILE_ENV = 'PI_PLANNER_EVIDENCE_STATE_FILE';
export const PLANNER_OUTPUT_ONLY_ENV = 'PI_PLANNER_OUTPUT_ONLY';

// Smallest equivalent read-only surface that pi-subagents children expose reliably. The
// extension-backed repo_search/LSP tools live in the parent runtime and are not available in the
// isolated planner child, so the documented fallback allowlist is used. The agent definition's
// `tools:` frontmatter must match this list exactly (pinned by a test).
export const PLANNER_EVIDENCE_TOOLS = Object.freeze(['read', 'grep', 'find', 'ls']);
// The structured-output call is the planner's result channel, never repository evidence.
export const PLANNER_RESULT_TOOL = 'structured_output';

export function plannerEvidenceBudget(config = {}) {
  const configured = Number(config.implementationPlannerEvidenceBudget ?? DEFAULT_PLANNER_EVIDENCE_BUDGET);
  if (!Number.isSafeInteger(configured) || configured < 0) {
    throw new Error(`implementationPlannerEvidenceBudget must be a non-negative integer, got ${String(config.implementationPlannerEvidenceBudget)}`);
  }
  return Math.min(configured, MAX_PLANNER_REPOSITORY_EVIDENCE);
}

// Trusted, runtime-side admission for the planner's evidence actions. Every admitted evidence
// call consumes one unit whether or not it later fails or returns nothing, there is no way to
// extend the budget, and once exhausted no further repository exploration is admitted.
export function createPlannerEvidenceGate(budget) {
  const cap = Math.min(Math.max(Number.isSafeInteger(budget) ? budget : 0, 0), MAX_PLANNER_REPOSITORY_EVIDENCE);
  let used = 0;
  return {
    cap,
    admit(toolName) {
      if (toolName === PLANNER_RESULT_TOOL) return { allowed: true, evidence: false, used, remaining: cap - used };
      if (!PLANNER_EVIDENCE_TOOLS.includes(toolName)) {
        return { allowed: false, evidence: false, used, remaining: cap - used, reason: `${toolName} is not available to the implementation planner (read-only evidence tools only)` };
      }
      if (used >= cap) {
        return { allowed: false, evidence: true, used, remaining: 0, reason: `Planner evidence budget of ${cap} is exhausted; return the structured plan now without further repository exploration` };
      }
      used += 1;
      return { allowed: true, evidence: true, used, remaining: cap - used };
    },
  };
}

function readPlannerEvidenceUsed(file, cap) {
  if (!file) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const used = Number(state?.used);
    if (!Number.isSafeInteger(used) || used < 0) return null;
    return Math.min(used, cap);
  } catch {
    return null;
  }
}

// Transport boundary only: tolerates repairable deviations (overlong steps, extra fields) so they
// reach normalizeImplementationPreparation() instead of failing before the runtime sees a value.
// The strict canonical contract is enforced locally by validateImplementationPreparation().
export const IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 1 },
    },
    facts: {
      type: 'array',
      maxItems: MAX_PLANNER_FACTS,
      items: { type: 'string', minLength: 1 },
    },
    complexity: { type: 'string', enum: ['trivial', 'nontrivial'] },
    evidence_budget: { type: 'integer', minimum: 0, maximum: MAX_PLANNER_EVIDENCE_BUDGET },
    large_mutation: { type: 'boolean' },
    reason: { type: 'string', minLength: 1, maxLength: 300 },
  },
  required: ['steps', 'facts', 'complexity', 'evidence_budget', 'reason'],
  additionalProperties: true,
});

export function implementerIssueContext(env = process.env) {
  const contextFile = env.PI_ISSUE_CONTEXT;
  if (!contextFile) throw new Error('PI_ISSUE_CONTEXT is required for runtime implementation preparation');
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  return {
    title: String(context.title ?? ''),
    body: String(context.body ?? ''),
  };
}

function repoRelativePath(...parts) {
  return path.join(...parts).split(path.sep).join('/');
}

function nearestPythonSibling(directory, preferredPrefix, excludeName = '') {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.py') && entry.name !== '__init__.py' && entry.name !== excludeName)
    .map(entry => entry.name);
  if (files.length === 0) return null;
  files.sort((left, right) => {
    const leftPreferred = preferredPrefix && left.startsWith(preferredPrefix) ? 0 : 1;
    const rightPreferred = preferredPrefix && right.startsWith(preferredPrefix) ? 0 : 1;
    return leftPreferred - rightPreferred || left.localeCompare(right);
  });
  return files[0];
}

function issuePythonFileTargets(issueText) {
  const seen = new Set();
  const targets = [];
  for (const match of String(issueText).matchAll(/\b((?:src|tests)\/[A-Za-z0-9_./-]+\.py)\b/g)) {
    const candidate = match[1];
    if (candidate.split('/').includes('..') || seen.has(candidate)) continue;
    seen.add(candidate);
    targets.push(candidate);
  }
  return targets;
}

function explicitAdditivePythonLayout(cwd, issueText) {
  const targets = issuePythonFileTargets(issueText);
  const sourceTargets = targets.filter(target => target.startsWith('src/'));
  const testTargets = targets.filter(target => target.startsWith('tests/'));

  for (const sourceTarget of sourceTargets) {
    const sourceTargetAbsolute = path.resolve(cwd, sourceTarget);
    const workspaceRoot = path.resolve(cwd);
    if (!sourceTargetAbsolute.startsWith(`${workspaceRoot}${path.sep}`)) continue;
    const sourceDirectory = path.dirname(sourceTargetAbsolute);
    if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) continue;
    if (fs.existsSync(sourceTargetAbsolute)) continue;

    const moduleName = path.basename(sourceTarget, '.py');
    const matchingTestName = `test_${moduleName}.py`;
    const explicitTestTarget = testTargets.find(target => path.basename(target) === matchingTestName) ?? testTargets[0] ?? null;
    const mirroredTestParts = path.dirname(sourceTarget).split('/').slice(1);
    const fallbackTestDirectories = [
      path.join(cwd, 'tests', ...mirroredTestParts),
      path.join(cwd, 'tests'),
    ];
    const explicitTestDirectory = explicitTestTarget ? path.resolve(cwd, path.dirname(explicitTestTarget)) : null;
    const testDirectory = explicitTestDirectory && explicitTestDirectory.startsWith(`${workspaceRoot}${path.sep}`) &&
        fs.existsSync(explicitTestDirectory) && fs.statSync(explicitTestDirectory).isDirectory()
      ? explicitTestDirectory
      : fallbackTestDirectories.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
    if (!testDirectory) continue;

    const sharedPrefix = moduleName.includes('_') ? `${moduleName.split('_')[0]}_` : '';
    const sourceSibling = nearestPythonSibling(sourceDirectory, sharedPrefix, `${moduleName}.py`);
    const testSibling = nearestPythonSibling(testDirectory, `test_${sharedPrefix}`, matchingTestName);
    const testTarget = explicitTestTarget ??
      repoRelativePath(path.relative(cwd, path.join(testDirectory, matchingTestName)));

    return {
      dottedTarget: null,
      sourceRoot: 'src',
      sourceDirectory: repoRelativePath(path.relative(cwd, sourceDirectory)),
      sourceTarget,
      sourceConvention: sourceSibling
        ? repoRelativePath(path.relative(cwd, path.join(sourceDirectory, sourceSibling)))
        : null,
      testDirectory: repoRelativePath(path.relative(cwd, testDirectory)),
      testTarget,
      testConvention: testSibling
        ? repoRelativePath(path.relative(cwd, path.join(testDirectory, testSibling)))
        : null,
    };
  }
  return null;
}

// Bounded, model-free orientation for additive Python work. Exact source/test paths named by the
// issue win first; otherwise it recognizes a conventional src/ layout from a dotted target and
// looks only at that package directory plus the nearest mirrored tests directory. Package names
// remain data from the issue and worktree; the generic runtime never hard-codes product paths.
export function discoverAdditivePythonLayout(cwd, issue) {
  const srcRoot = path.join(cwd, 'src');
  const testsRoot = path.join(cwd, 'tests');
  if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory() ||
      !fs.existsSync(testsRoot) || !fs.statSync(testsRoot).isDirectory()) return null;

  const issueText = `${String(issue?.title ?? '')}\n${String(issue?.body ?? '')}`;
  const explicitLayout = explicitAdditivePythonLayout(cwd, issueText);
  if (explicitLayout) return explicitLayout;

  const dottedTargets = [...issueText.matchAll(/`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*){2,})`/g)]
    .map(match => match[1]);

  for (const dottedTarget of dottedTargets) {
    const parts = dottedTarget.split('.');
    let existingPackageParts = 0;
    for (let length = 1; length < parts.length; length += 1) {
      const candidate = path.join(srcRoot, ...parts.slice(0, length));
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) break;
      existingPackageParts = length;
    }
    // A safe additive hint needs an explicit new module *and* a symbol inside it. If only one
    // dotted segment remains after the existing package, it could just as well be an existing
    // function/class exported from that package, so leave discovery to normal evidence tools.
    if (existingPackageParts === 0 || parts.length - existingPackageParts < 2) continue;

    const moduleName = parts[existingPackageParts];
    if (!/^[a-z_]\w*$/.test(moduleName)) continue;
    const sourceDirectoryParts = parts.slice(0, existingPackageParts);
    const sourceDirectory = path.join(srcRoot, ...sourceDirectoryParts);
    const sourceTargetAbsolute = path.join(sourceDirectory, `${moduleName}.py`);
    if (fs.existsSync(sourceTargetAbsolute)) continue;

    const mirroredTestParts = sourceDirectoryParts.slice(1);
    const testCandidates = [
      path.join(testsRoot, ...mirroredTestParts),
      path.join(testsRoot, ...sourceDirectoryParts),
      testsRoot,
    ];
    const testDirectory = testCandidates.find(candidate =>
      fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
    );
    if (!testDirectory) continue;

    const sharedPrefix = moduleName.includes('_') ? `${moduleName.split('_')[0]}_` : '';
    const sourceSibling = nearestPythonSibling(sourceDirectory, sharedPrefix, `${moduleName}.py`);
    const testPrefix = `test_${sharedPrefix}`;
    const testSibling = nearestPythonSibling(testDirectory, testPrefix, `test_${moduleName}.py`);

    return {
      dottedTarget,
      sourceRoot: 'src',
      sourceDirectory: repoRelativePath(path.relative(cwd, sourceDirectory)),
      sourceTarget: repoRelativePath(path.relative(cwd, sourceTargetAbsolute)),
      sourceConvention: sourceSibling
        ? repoRelativePath(path.relative(cwd, path.join(sourceDirectory, sourceSibling)))
        : null,
      testDirectory: repoRelativePath(path.relative(cwd, testDirectory)),
      testTarget: repoRelativePath(path.relative(cwd, path.join(testDirectory, `test_${moduleName}.py`))),
      testConvention: testSibling
        ? repoRelativePath(path.relative(cwd, path.join(testDirectory, testSibling)))
        : null,
    };
  }
  return null;
}

// Safe repairs only: keep the canonical fields, trim strings, and bound step/fact lengths.
// facts is a compact repository-derived handoff, never raw evidence or planner transcript.
// large_mutation is an optional planner hint: omission safely defaults to false, while an
// explicitly present non-boolean value is preserved so strict validation rejects it.
export function normalizeImplementationPreparation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const trim = item => typeof item === 'string' ? item.trim() : item;
  const normalized = {};
  for (const key of ['steps', 'facts', 'complexity', 'evidence_budget', 'large_mutation', 'reason']) {
    if (!(key in value)) continue;
    if (key === 'steps' && Array.isArray(value.steps)) {
      normalized.steps = value.steps.map(step => typeof step === 'string' ? step.trim().slice(0, MAX_PLANNER_STEP_LENGTH).trim() : step);
    } else if (key === 'facts' && Array.isArray(value.facts)) {
      normalized.facts = value.facts.slice(0, MAX_PLANNER_FACTS)
        .map(fact => typeof fact === 'string' ? fact.trim().slice(0, MAX_PLANNER_FACT_LENGTH).trim() : fact);
    } else {
      normalized[key] = trim(value[key]);
    }
  }
  if (!('facts' in normalized)) normalized.facts = [];
  if (!('large_mutation' in normalized)) normalized.large_mutation = false;
  return normalized;
}

export function validateImplementationPreparation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Implementation planner returned a non-object structured result');
  }
  const keys = Object.keys(value);
  const requiredKeys = ['steps', 'complexity', 'evidence_budget', 'large_mutation', 'reason'];
  const allowedKeys = new Set([...requiredKeys, 'facts']);
  if (!requiredKeys.every(key => keys.includes(key)) || keys.some(key => !allowedKeys.has(key))) {
    throw new Error('Implementation planner returned unexpected structured fields');
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8) {
    throw new Error('Implementation planner returned an invalid step list');
  }
  const steps = value.steps.map(step => typeof step === 'string' ? step.trim() : '');
  if (steps.some(step => !step || step.length > MAX_PLANNER_STEP_LENGTH)) {
    throw new Error('Implementation planner returned an invalid plan step');
  }
  const factsValue = value.facts ?? [];
  if (!Array.isArray(factsValue) || factsValue.length > MAX_PLANNER_FACTS) {
    throw new Error('Implementation planner returned an invalid repository facts list');
  }
  const facts = factsValue.map(fact => typeof fact === 'string' ? fact.trim() : '');
  if (facts.some(fact => !fact || fact.length > MAX_PLANNER_FACT_LENGTH)) {
    throw new Error('Implementation planner returned an invalid repository fact');
  }
  if (!['trivial', 'nontrivial'].includes(value.complexity)) {
    throw new Error(`Implementation planner returned invalid complexity: ${String(value.complexity)}`);
  }
  const evidenceBudget = Number(value.evidence_budget);
  if (!Number.isSafeInteger(evidenceBudget) || evidenceBudget < 0 || evidenceBudget > MAX_PLANNER_EVIDENCE_BUDGET) {
    throw new Error(`Implementation planner returned invalid evidence_budget: ${String(value.evidence_budget)}`);
  }
  if (typeof value.large_mutation !== 'boolean') {
    throw new Error(`Implementation planner returned invalid large_mutation: ${String(value.large_mutation)}`);
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (!reason || reason.length > 300) throw new Error('Implementation planner returned an invalid reason');
  return { steps, facts, complexity: value.complexity, evidenceBudget, largeMutation: value.large_mutation, reason };
}

export function plannerTask(env = process.env, { repair = false, layoutHint = null, outputOnly = false } = {}) {
  const issue = implementerIssueContext(env);
  const layoutGuidance = layoutHint
    ? `\n\nRuntime repository layout hint (current worktree, model-free): source_root=${layoutHint.sourceRoot}; source_target=${layoutHint.sourceTarget}; source_directory=${layoutHint.sourceDirectory}; nearest_source_convention=${layoutHint.sourceConvention ?? 'none'}; test_directory=${layoutHint.testDirectory}; test_target=${layoutHint.testTarget ?? 'unknown'}; nearest_test_convention=${layoutHint.testConvention ?? 'none'}. Treat these resolved targets/directories as authoritative. If conventions matter, inspect only the nearest relevant sibling source/test; do not re-discover the same paths broadly.`
    : '';
  const evidencePolicy = outputOnly
    ? `EVIDENCE PHASE CLOSED. This retry is output-only: do not inspect the repository again and do not call read, grep, find, or ls. Use the issue plus the runtime facts already present in this prompt. Your only valid successful completion is structured_output.`
    : `Use at most ${MAX_PLANNER_REPOSITORY_EVIDENCE} read-only repository evidence actions across the lifecycle. If the issue names an exact path/directory/symbol/test, your first evidence action must target that named location (or the authoritative nearest sibling supplied by the runtime). Broad find/ls/search is escalation only after a targeted location is missing, stale, contradictory, or leaves a concrete planning uncertainty unresolved. Prefer one representative sibling source plus one representative sibling test when conventions matter. Stop as soon as exact targets, conventions, invariants, blast radius, and verification scope are clear. Do not spend evidence proving facts explicit in the issue, and do not spend evidence re-proving fresh-worktree provenance already established by the runtime.`;
  return `Prepare the smallest repository-informed handoff that reduces uncertainty for the next Implementer request.

MANDATORY COMPLETION: a successful attempt ends only by calling structured_output. Never finish a planner attempt with prose. After the final evidence result, call structured_output immediately in the same provider lifecycle instead of spending a reasoning-only turn.
${evidencePolicy}

Synthesize what you learn into the handoff. Return facts as 0-${MAX_PLANNER_FACTS} concise repository-derived facts (each <=${MAX_PLANNER_FACT_LENGTH} characters): observed conventions, resolved paths/symbols, invariants, or verification locations that reduce main uncertainty. No raw file dumps, evidence payloads, tool history, transcript, or chain-of-thought. If you established a useful fact, preserve it in facts and make plan steps act on it instead of telling main to rediscover it.

Keep the plan concise: 1-8 ordered steps, each <=240 characters. Include exact implementation/test targets, useful sibling conventions, key symbols, invariants, blast radius, and smallest verification scope when known. Do not name evidence tools or routing tools in steps.

Set evidence_budget (0-${MAX_PLANNER_EVIDENCE_BUDGET}) to ONLY the repository evidence main still needs after consuming your handoff. Resolved discovery/convention facts cost main 0, but they do not replace a current mutation anchor: reserve at least one action for each existing file main must modify and has not itself seen, so it can read the current text/AST before editing. New-file-only work may use 0. Complexity is independent of evidence needs.

Set large_mutation=true only when the next implementation work clearly needs the large coding/write budget (for example a substantial new module plus tests), not merely because complexity is nontrivial. Do not implement the task.

The 2048-token ceiling exists to avoid structured-output truncation, not for verbose prose.${layoutGuidance}${repair ? `\n\nREPAIR: the previous structured_output envelope was rejected. Evidence remains closed; follow the exact output contract immediately below.` : ''}

Output contract: call structured_output with exactly { "value": { "steps": [...], "facts": [...], "complexity": "trivial|nontrivial", "evidence_budget": 0-${MAX_PLANNER_EVIDENCE_BUDGET}, "large_mutation": true|false, "reason": "..." } }. reason must be one concise sentence <=300 characters.

Issue title:
${issue.title}

Issue body:
${issue.body}`;
}

// pi-subagents reports a terminal schema/envelope rejection as `Structured output validation failed: <details>`
// (readStructuredOutput). The structured_output tool's own per-call "Validation failed for tool" errors stay
// inside the subagent loop; if that loop cannot recover, the runtime sees a timeout, which is not retried.
const STRUCTURED_SCHEMA_FAILURE = /(^|: )Structured output validation failed:/;

// Sums numeric usage fields (recursively) across planner attempts; null when nothing was reported.
export function addUsage(total, next) {
  if (!next || typeof next !== 'object') return total ?? null;
  if (!total) return structuredClone(next);
  const sum = { ...total };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'number') sum[key] = (typeof sum[key] === 'number' ? sum[key] : 0) + value;
    else if (value && typeof value === 'object' && !Array.isArray(value)) sum[key] = addUsage(sum[key] && typeof sum[key] === 'object' ? sum[key] : null, value);
    else if (!(key in sum)) sum[key] = value;
  }
  return sum;
}

export async function runStructuredImplementationPlanner(pi, ctx, config, signal, layoutHint = null) {
  const request = {
    agent: config.implementationPlannerAgent,
    nodeId: 'implementation-plan',
    task: plannerTask(process.env, { layoutHint }),
    schema: IMPLEMENTATION_PREPARATION_TRANSPORT_SCHEMA,
    timeoutMs: 0,
    maxTokens: Number(config.implementationPlannerMaxTokens ?? 2048),
  };
  const evidenceCap = plannerEvidenceBudget(config);
  // Keep the sidecar inside a lifecycle-owned directory. If the parent times out/aborts before
  // the delegated child has actually stopped, removing the directory prevents a late child write
  // from recreating an orphaned state file directly under the shared tmpdir.
  const evidenceStateDir = fs.mkdtempSync(path.join(tmpdir(), 'pi-planner-evidence-'));
  const evidenceStateFile = path.join(evidenceStateDir, `${randomUUID()}.json`);
  // Every attempt is a fresh child with a fresh gate, so the cap must be spent across the whole
  // planning lifecycle, not per attempt. The parent cannot see how much a failed child used, so
  // fail closed: only the first attempt may gather evidence; a retry gets 0 (structured_output
  // stays available) and can never push the lifecycle past the hard cap.
  const applyEvidenceCap = attempt => {
    const cap = attempt === 0 ? evidenceCap : 0;
    // Backstop only: pi-subagents counts every child tool call (including structured_output
    // attempts) and, past `hard`, blocks read/grep/find/ls. The authoritative cap is the child-side
    // gate (pi-planner-evidence.mjs); leave headroom for the result call and its schema retry.
    request.toolBudget = { hard: cap + 3 };
    if (attempt > 0) request.toolBudget = { hard: 1 };
    request.childEnv = {
      [PLANNER_EVIDENCE_BUDGET_ENV]: String(cap),
      [PLANNER_EVIDENCE_STATE_FILE_ENV]: evidenceStateFile,
      [PLANNER_OUTPUT_ONLY_ENV]: attempt > 0 ? 'true' : 'false',
    };
  };
  const retries = Number(config.implementationPlannerStructuredRetry ?? 1);
  // One hard deadline for the whole planning lifecycle: retries only get the remaining time.
  const deadlineMs = Number(config.implementationPlannerTimeoutMs ?? 45000);
  const startedAt = Date.now();
  let response;
  // Planner usage is one lifecycle-level record: attempts are summed and recorded exactly once.
  let usage = null;
  let status = 'error';
  const childSession = randomUUID();
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        applyEvidenceCap(attempt);
        request.timeoutMs = deadlineMs - (Date.now() - startedAt);
        if (request.timeoutMs <= 0) {
          throw Object.assign(new Error(`${config.implementationPlannerAgent} planning deadline of ${deadlineMs} ms exhausted`), { delegationStatus: 'timed_out' });
        }
        response = await runStructuredSubagent(pi, ctx, request, signal);
        usage = addUsage(usage, response.usage);
        if (attempt > 0 && (Number(response.usage?.turns ?? 0) > 1 || Number(response.usage?.toolCalls ?? 0) > 1)) {
          console.warn(`PI_PLANNER_OUTPUT_ONLY_ANOMALY ${JSON.stringify({
            providerTurns: response.usage?.turns ?? null,
            toolCalls: response.usage?.toolCalls ?? null,
            handling: 'retry_completed_but_output_only_surface_was_not_single_turn',
          })}`);
        }
        break;
      } catch (error) {
        usage = addUsage(usage, error?.delegationUsage);
        const message = String(error?.message ?? error);
        const missing = message.includes('Missing structured_output call');
        const schemaFailure = !missing && STRUCTURED_SCHEMA_FAILURE.test(message);
        const outputOnlyInvalidTool = attempt > 0 && /(?:tool .* not found|unknown tool|tool budget)/i.test(message);
        const retryable = !outputOnlyInvalidTool && (missing || schemaFailure);
        const reason = outputOnlyInvalidTool
          ? 'output_only_invalid_tool'
          : missing ? 'missing_structured_output'
            : schemaFailure ? 'structured_output_schema_failure'
              : 'planner_infrastructure_failure';
        if (retryable && attempt < retries) {
          request.task = plannerTask(process.env, { repair: schemaFailure, layoutHint, outputOnly: true });
        }
        console.warn(`PI_SUBAGENT_FAILURE ${JSON.stringify({
          agent: config.implementationPlannerAgent,
          reason,
          attempt: attempt + 1,
          retriesExhausted: retryable && attempt >= retries,
          error: message,
        })}`);
        if (!retryable || attempt >= retries) throw error;
        console.log(`PI_SUBAGENT_RETRY ${JSON.stringify({
          agent: config.implementationPlannerAgent,
          reason,
          attempt: attempt + 1,
        })}`);
      }
    }
    const validated = validateImplementationPreparation(normalizeImplementationPreparation(response.result.value));
    status = 'completed';
    return {
      ...validated,
      usage,
      layoutHint,
      evidenceUsed: readPlannerEvidenceUsed(evidenceStateFile, evidenceCap),
      evidenceCap,
    };
  } catch (error) {
    if (error && typeof error === 'object') {
      error.delegationUsage = usage;
      error.plannerEvidenceUsed = readPlannerEvidenceUsed(evidenceStateFile, evidenceCap);
      error.plannerEvidenceCap = evidenceCap;
      status = error.delegationStatus ?? 'error';
    }
    throw error;
  } finally {
    recordDescendantMetric({
      call: 'planner', scope: 'session', childSession, parentSession: ctx.sessionManager.getSessionId(), status, usage,
    });
    fs.rmSync(evidenceStateDir, { recursive: true, force: true });
  }
}

// Hard maximum for the bootstrap planner (not an expected duration). A healthy-but-slow planner
// behind a shared model endpoint must not be cancelled early; a genuine timeout falls back.
export const IMPLEMENTATION_PLANNER_DEADLINE_MS = 15 * 60 * 1000;

// Resolves fresh-work preparation before any main Implementer session exists. Returns the explicit
// PreparedImplementation artifact: either a validated planner result or a resolved fallback.
// Cancellation is never a recovery request and propagates.
export async function prepareImplementation(pi, ctx, config, signal, { env = process.env } = {}) {
  const startedAt = Date.now();
  const freshBaseCommit = String(env.PI_IMPLEMENTER_START_COMMIT ?? '').trim();
  const common = { version: 1, workspaceRoot: ctx.cwd, freshBaseCommit, baseRef: baseRef() };
  let layoutHint = null;
  try {
    layoutHint = discoverAdditivePythonLayout(ctx.cwd, implementerIssueContext(env));
    const planned = await runStructuredImplementationPlanner(pi, ctx, config, signal, layoutHint);
    return {
      ...common,
      status: 'prepared',
      plan: planned.steps,
      repositoryFacts: planned.facts,
      complexity: planned.complexity,
      evidenceBudget: planned.evidenceBudget,
      largeMutation: planned.largeMutation,
      reason: planned.reason,
      layoutHint,
      plannerUsage: planned.usage,
      plannerEvidenceUsed: planned.evidenceUsed,
      plannerEvidenceCap: planned.evidenceCap,
      plannerProviderTurns: Number.isSafeInteger(planned.usage?.turns) ? planned.usage.turns : null,
      plannerDurationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...common,
      status: 'fallback',
      failureClass: error?.delegationStatus === 'timed_out' ? 'planner_deadline_timeout' : 'preparation_infrastructure_failure',
      reason: String(error?.message ?? error),
      layoutHint,
      plannerUsage: error?.delegationUsage ?? null,
      plannerEvidenceUsed: Number.isSafeInteger(error?.plannerEvidenceUsed) ? error.plannerEvidenceUsed : null,
      plannerEvidenceCap: Number.isSafeInteger(error?.plannerEvidenceCap) ? error.plannerEvidenceCap : plannerEvidenceBudget(config),
      plannerProviderTurns: Number.isSafeInteger(error?.delegationUsage?.turns) ? error.delegationUsage.turns : null,
      plannerDurationMs: Date.now() - startedAt,
    };
  }
}

// The bootstrap process itself failed (crash, no artifact): still infrastructure failure, so the
// fresh Implementer starts with the same already-resolved fallback instead of being blocked.
export function bootstrapFailureFallback(cwd, reason, env = process.env, elapsedMs = 0) {
  return {
    version: 1,
    status: 'fallback',
    failureClass: 'bootstrap_process_failure',
    reason: String(reason),
    workspaceRoot: cwd,
    freshBaseCommit: String(env.PI_IMPLEMENTER_START_COMMIT ?? '').trim(),
    baseRef: baseRef(),
    layoutHint: null,
    plannerUsage: null,
    plannerDurationMs: elapsedMs,
  };
}

const PREPARED_STATUSES = new Set(['prepared', 'fallback']);

export function validatePreparedImplementation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !PREPARED_STATUSES.has(value.status)) {
    throw new Error('Prepared implementation artifact is malformed');
  }
  if (value.status === 'prepared') {
    validateImplementationPreparation({
      steps: value.plan, facts: value.repositoryFacts ?? [], complexity: value.complexity, evidence_budget: value.evidenceBudget,
      large_mutation: value.largeMutation, reason: value.reason,
    });
  } else if (typeof value.reason !== 'string' || !value.failureClass) {
    throw new Error('Prepared implementation fallback is missing its reason');
  }
  return value;
}

export function writePreparedImplementation(file, prepared) {
  validatePreparedImplementation(prepared);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(prepared)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// Returns null when no artifact exists; a present but malformed artifact fails closed.
export function readPreparedImplementation(file) {
  if (!file || !fs.existsSync(file)) return null;
  return validatePreparedImplementation(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function layoutGuidance(layoutHint, { authoritative }) {
  if (!layoutHint) return '';
  const source = `Repository layout hint: source root ${layoutHint.sourceRoot}; new module target ${layoutHint.sourceTarget}; ` +
    `source directory ${layoutHint.sourceDirectory}${layoutHint.sourceConvention ? `; nearest source convention ${layoutHint.sourceConvention}` : ''}; ` +
    `tests ${layoutHint.testDirectory}${layoutHint.testConvention ? `; nearest test convention ${layoutHint.testConvention}` : ''}.`;
  return `\n${source} ${authoritative}`;
}

// The compact, trusted block that replaces the old model-visible prepare_implementation exchange.
// It carries only the normalized artifact: never planner reasoning, retries or transcript.
export function preparedImplementationBlock(prepared, { largeMutationArmed = false } = {}) {
  const provenance = `Fresh worktree base: latest fetched ${prepared.baseRef}${prepared.freshBaseCommit ? ` at ${prepared.freshBaseCommit}` : ''}; no saved issue work was applied. ` +
    'Until the first successful structural_edit/safe_edit/edit/write, direct reads of this worktree are authoritative latest-base evidence; do not use extra Git/evidence calls to re-prove that provenance.\n' +
    `LSP workspace root: ${prepared.workspaceRoot}. Use only inspection/control tools currently exposed by the runtime; runtime steering is authoritative for valid tool names.`;
  if (prepared.status === 'fallback') {
    return `Runtime-prepared implementation state (planner output unavailable):
PREPARATION_FALLBACK: implementation planner infrastructure failed (${prepared.failureClass}). Preparation is already resolved before this session; no plan or complexity was recorded and there is nothing to prepare or retry.
If the canonical source/test layout is not already clear, use the bounded fallback evidence window to orient before creating new files; this is guidance, not a mutation gate. You may use up to ${PREPARATION_FALLBACK_EVIDENCE_BUDGET} repository evidence attempts; every accepted non-control evidence action consumes one attempt even if it fails or returns no useful result. The window closes when the attempts are consumed or on the first successful mutation. Direct mutation remains allowed during the window and closes it on success. The coding-session action becomes valid only after the evidence window is closed. Focused verification becomes available only after a successful mutation. Final submission rules are unchanged. After the window closes, use only the blocker action exposed by the runtime when one concrete implementation fact is still missing.
${provenance}${layoutGuidance(prepared.layoutHint, { authoritative: 'This current-worktree hint is authoritative layout evidence; do not broad-search to re-prove it.' })}`;
  }
  const numberedPlan = prepared.plan.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const repositoryFacts = Array.isArray(prepared.repositoryFacts) && prepared.repositoryFacts.length > 0
    ? `\nRepository facts already established by planner:\n${prepared.repositoryFacts.map(fact => `- ${fact}`).join('\n')}\n`
    : '\n';
  return `Runtime-prepared implementation state:
Implementation plan:
${numberedPlan}
${repositoryFacts}
Complexity: ${prepared.complexity} — ${prepared.reason}
Evidence budget: ${prepared.evidenceBudget}
Large mutation: ${largeMutationArmed ? 'auto-arm one-shot elevated mutation budget when evidence is complete' : 'normal mutation budget'}
Preparation complete; do not re-plan unless concrete repository evidence invalidates a plan assumption.
${provenance}${layoutGuidance(prepared.layoutHint, { authoritative: 'This bounded current-worktree lookup is authoritative layout evidence. Prefer one targeted convention read if needed; do not broad-search or re-prove the fresh-worktree provenance.' })}`;
}
