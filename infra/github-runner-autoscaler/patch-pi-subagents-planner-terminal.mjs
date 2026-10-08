// Narrow, version-pinned integration repair for pi-subagents 0.76.1.
// Its foreground text-output gate treats a successful terminal submit_plan as
// failure because the terminating assistant toolUse turn has no final prose.
// Main revalidates this same per-lifecycle sidecar independently.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED_VERSION = '0.76.1';

export function acceptedTerminalPlannerReceipt(messages, state, lifecycleId) {
  if (!Array.isArray(messages) || !state || state.phase !== 'submitted' ||
      state.failureKind || typeof state.planText !== 'string' || !state.planText.trim() ||
      !lifecycleId || !state.submissionReceipt) return false;
  const receipt = state.submissionReceipt;
  const budget = state.submissionBudget;
  const history = state.budgetHistory;
  const lastBudget = Array.isArray(history) ? history.at(-1) : null;
  if (receipt.lifecycleId !== lifecycleId ||
      typeof receipt.toolCallId !== 'string' || !receipt.toolCallId ||
      receipt.admitted !== true || receipt.executed !== true ||
      receipt.providerComplete !== true || receipt.stopReason !== 'tooluse' ||
      receipt.providerBudgetVerified !== true ||
      receipt.planTextBytes !== Buffer.byteLength(state.planText, 'utf8') ||
      (budget !== 4096 && budget !== 8192) ||
      receipt.submissionBudget !== budget || lastBudget?.phase !== 'submission_pending' ||
      lastBudget?.verified !== true || lastBudget.effective !== budget) return false;
  const assistant = messages.findLast(message => message?.role === 'assistant');
  if (!assistant || assistant.stopReason !== 'toolUse' || assistant.errorMessage) return false;
  const calls = Array.isArray(assistant.content)
    ? assistant.content.filter(part => part?.type === 'toolCall') : [];
  if (calls.length !== 1 || calls[0].name !== 'submit_plan' ||
      calls[0].id !== receipt.toolCallId) return false;
  const results = messages.filter(message => message?.role === 'toolResult' &&
    message.toolCallId === receipt.toolCallId);
  return results.length === 1 && results[0].isError === false;
}

export function patchPiSubagentsSource(source) {
  const importAnchor = 'import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";';
  const helperAnchor = 'const artifactOutputByResult = new WeakMap();';
  const decisionAnchor = 'const missingOutput = !finalText?.trim() && !validatedStructuredOutput;';
  const conditionAnchor = 'if ((missingOutput || terminalEmptyAfterUsefulWork) && (!errInfo.hasError || hasEmptyTerminalAssistantResponse(messages))) {';
  const errorConditionAnchor = 'else if (errInfo.hasError) {';
  const ensureOnce = (text, fragment) => {
    if (text.split(fragment).length !== 2) throw new Error('pi-subagents 0.76.1 source drift: ' + fragment);
  };
  ensureOnce(source, importAnchor);
  ensureOnce(source, helperAnchor);
  ensureOnce(source, decisionAnchor);
  ensureOnce(source, conditionAnchor);
  ensureOnce(source, errorConditionAnchor);
  const policy = acceptedTerminalPlannerReceipt.toString();
  const guard = [
    '// Planner-only exception to the upstream mandatory final-text rule.',
    '// An actual executed tool result AND a current-lifecycle durable receipt are required.',
    policy,
    'function trustedPlannerTerminalToolUse(messages, agentName) {',
    '  if (agentName !== "implementation-planner") return false;',
    '  const sidecar = process.env.PI_PLANNER_EVIDENCE_STATE_FILE;',
    '  const lifecycleId = process.env.PI_PLANNER_LIFECYCLE_ID;',
    '  if (!sidecar || !lifecycleId) return false;',
    '  try {',
    '    return acceptedTerminalPlannerReceipt(messages, JSON.parse(readFileSync(sidecar, "utf8")), lifecycleId);',
    '  } catch (error) {',
    '    // Log only the exception category; sidecar paths and plan content remain private.',
    '    const kind = error?.name === "ReferenceError" ? "injected_dependency_missing" : "receipt_unavailable";',
    '    console.warn("PI_PLANNER_TERMINAL_RECEIPT_CHECK_FAILED " + JSON.stringify({ kind }));',
    '    return false;',
    '  }',
    '}',
    '',
  ].join('\n');
  return source
    .replace(importAnchor, () => 'import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";')
    .replace(helperAnchor, () => guard + helperAnchor)
    .replace(decisionAnchor, () => 'const acceptedTerminalPlan = trustedPlannerTerminalToolUse(messages, agent.name);\n\t\t' + decisionAnchor)
    .replace(conditionAnchor, () => 'if (!acceptedTerminalPlan && (missingOutput || terminalEmptyAfterUsefulWork) && (!errInfo.hasError || hasEmptyTerminalAssistantResponse(messages))) {')
    // An earlier recoverable evidence-tool failure must not override a verified
    // successful terminal submission. Without the exact receipt, preserve the
    // original upstream hidden-error classification.
    .replace(errorConditionAnchor, () => 'else if (!acceptedTerminalPlan && errInfo.hasError) {');
}

function main() {
  const root = process.argv[2];
  if (!root) throw new Error('Pass the installed pi-subagents package directory');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'pi-subagents' || pkg.version !== PINNED_VERSION) {
    throw new Error('Expected pi-subagents@' + PINNED_VERSION + ', got ' + pkg.name + '@' + pkg.version);
  }
  // npm publishes compiled JavaScript in dist-pkg; the GitHub tag contains TypeScript only.
  const target = path.join(root, 'src/runs/foreground/execution.js');
  const original = fs.readFileSync(target, 'utf8');
  const patched = patchPiSubagentsSource(original);
  fs.writeFileSync(target, patched);
  console.log('PI_SUBAGENTS_PLANNER_TERMINAL_PATCH applied version=' + PINNED_VERSION);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
