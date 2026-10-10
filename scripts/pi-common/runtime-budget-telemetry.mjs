// Pure runtime budget calculations and log-record serialization.
// Emitters and mutable budget policy stay in pi-agent-runtime.mjs / ProgressController.

export function activeResponseCeiling(appliedActionCap, fixedMaxTokens, levelMaxTokens) {
  return appliedActionCap || fixedMaxTokens || levelMaxTokens;
}

export function responseHitOutputCeiling(outputTokens, activeResponseCap) {
  return activeResponseCap > 0 && outputTokens >= activeResponseCap;
}

export function turnStartBudgetTelemetry({
  turn, stage, fixedMaxTokens, turnLevel, levelMaxTokens, appliedActionCap,
  productiveState, largeMutationBudget,
}) {
  return {
    turn,
    stage,
    budget: fixedMaxTokens ? 'fixed' : turnLevel,
    maxTokens: activeResponseCeiling(appliedActionCap, fixedMaxTokens, levelMaxTokens),
    productiveState,
    actionCapApplied: appliedActionCap > 0,
    largeMutationBudget,
  };
}

export function* plannerTelemetryRecords(prepared, applied) {
  const stage = 'implementer';
  const usage = prepared.plannerUsage ?? null;
  const planTextBytes = prepared.status === 'prepared' ? Buffer.byteLength(prepared.planText, 'utf8') : 0;
  yield { level: 'log', text: `[PI][planner] prepared status=${prepared.status} duration=${prepared.plannerDurationMs ?? 'unknown'}ms evidence_actions=${prepared.plannerEvidenceActions ?? 'unknown'} turns=${prepared.plannerProviderTurns ?? 'unknown'} in=${usage?.input ?? 'unknown'} out=${usage?.output ?? 'unknown'} plan_bytes=${planTextBytes}` };
  if (prepared.status === 'fallback') {
    yield { level: 'warn', text: `PI_PREPARATION_FALLBACK ${JSON.stringify({
      stage,
      preparationState: applied.preparationState,
      evidenceBudget: applied.evidenceBudget,
      source: 'implementation-planner',
      failureClass: prepared.failureClass,
      recovery: 'continue_without_planner_output',
      reason: prepared.reason,
      plannerDurationMs: prepared.plannerDurationMs,
      evidenceActions: prepared.plannerEvidenceActions ?? null,
      providerTurns: prepared.plannerProviderTurns ?? null,
    })}` };
  } else {
    yield { level: 'log', text: `PI_PLAN ${JSON.stringify({
      stage,
      planTextBytes,
      complexity: prepared.complexity,
      largeMutation: prepared.largeMutation,
      largeMutationArmed: applied.largeMutationArmed,
      reason: prepared.reason,
      usage,
      plannerDurationMs: prepared.plannerDurationMs,
      evidenceActions: prepared.plannerEvidenceActions ?? null,
      providerTurns: prepared.plannerProviderTurns ?? null,
    })}` };
    yield { level: 'log', text: `PI_COMPLEXITY ${JSON.stringify({
      stage,
      complexity: prepared.complexity,
      requiredMutationAnchors: [],
      largeMutation: false,
      reason: prepared.reason,
      usage,
      source: 'implementation-planner-harness-default',
    })}` };
  }
  yield { level: 'log', text: `PI_BOOTSTRAP ${JSON.stringify({ phase: 'prepared_state_applied', status: prepared.status, beforeFirstProviderRequest: true })}` };
}

export function* codingSessionTelemetryRecords(phase, fields) {
  const line = `PI_CODING_SESSION ${JSON.stringify({ phase, ...fields })}`;
  const summaryFields = ['side', 'agent', 'tool', 'status', 'durationMs', 'reason']
    .filter(key => fields[key] != null)
    .map(key => `${key}=${String(fields[key]).replace(/\s+/g, ' ').slice(0, 100)}`)
    .join(' ');
  const readable = `[PI][coding] phase=${phase}${summaryFields ? ` ${summaryFields}` : ''}`;
  if (['failed', 'rejected', 'cancelled', 'blocked', 'ended_without_submit'].includes(phase)) yield { level: 'warn', text: readable };
  else yield { level: 'log', text: readable };
  if (['failed', 'rejected', 'cancelled'].includes(phase)) yield { level: 'warn', text: line };
  else yield { level: 'log', text: line };
}
