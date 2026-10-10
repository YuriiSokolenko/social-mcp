import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  activeResponseCeiling, responseHitOutputCeiling, turnStartBudgetTelemetry,
  plannerTelemetryRecords, codingSessionTelemetryRecords,
} from '../scripts/pi-common/runtime-budget-telemetry.mjs';

test('#741 budget precedence is unchanged (action cap > fixed > level)', () => {
  assert.equal(activeResponseCeiling(8192, 16384, 2048), 8192);
  assert.equal(activeResponseCeiling(0, 16384, 2048), 16384);
  assert.equal(activeResponseCeiling(0, 0, 2048), 2048);
  assert.equal(activeResponseCeiling(undefined, null, 0), 0);
  assert.equal(activeResponseCeiling(0, undefined, undefined), undefined);
  assert.equal(activeResponseCeiling(-1, 0, 100), -1, 'preserve original truthy fallback without policy rewriting');
});

test('#741 ceiling hit classification preserves strictly-positive cap and equality', () => {
  assert.equal(responseHitOutputCeiling(2048, 2048), true);
  assert.equal(responseHitOutputCeiling(2049, 2048), true);
  assert.equal(responseHitOutputCeiling(2047, 2048), false);
  assert.equal(responseHitOutputCeiling(0, 0), false);
  assert.equal(responseHitOutputCeiling(2000, -1), false);
  assert.equal(responseHitOutputCeiling(10, undefined), false);
});

test('#741 turn-start budget metric preserves field order, booleans and fixed status', () => {
  const args = {
    turn: 7, stage: 'implementer', fixedMaxTokens: 0, turnLevel: 'normal',
    levelMaxTokens: 4096, appliedActionCap: 8192, productiveState: 'action_required',
    largeMutationBudget: 'armed',
  };
  const metric = turnStartBudgetTelemetry(args);
  assert.deepEqual(metric, {
    turn: 7, stage: 'implementer', budget: 'normal', maxTokens: 8192,
    productiveState: 'action_required', actionCapApplied: true, largeMutationBudget: 'armed',
  });
  assert.equal(JSON.stringify(metric), '{"turn":7,"stage":"implementer","budget":"normal","maxTokens":8192,"productiveState":"action_required","actionCapApplied":true,"largeMutationBudget":"armed"}');
  assert.deepEqual(turnStartBudgetTelemetry({ ...args, fixedMaxTokens: 16384, appliedActionCap: 0 }),
    { ...metric, budget: 'fixed', maxTokens: 16384, actionCapApplied: false });
});

test('#741 prepared planner emits ordered and byte-stable summary/plan/complexity/bootstrap records', () => {
  const prepared = {
    status: 'prepared', planText: 'é😀', complexity: 'large', largeMutation: true,
    reason: 'prepare', plannerUsage: { input: 10, output: 7 },
    plannerDurationMs: 23, plannerEvidenceActions: 2, plannerProviderTurns: 1,
  };
  const records = plannerTelemetryRecords(prepared, { largeMutationArmed: true });
  assert.deepEqual(records.map(r => r.level), ['log', 'log', 'log', 'log']);
  assert.equal(records[0].text,
    '[PI][planner] prepared status=prepared duration=23ms evidence_actions=2 turns=1 in=10 out=7 plan_bytes=6');
  assert.deepEqual(JSON.parse(records[1].text.slice('PI_PLAN '.length)), {
    stage: 'implementer', planTextBytes: 6, complexity: 'large', largeMutation: true,
    largeMutationArmed: true, reason: 'prepare', usage: { input: 10, output: 7 },
    plannerDurationMs: 23, evidenceActions: 2, providerTurns: 1,
  });
  assert.deepEqual(JSON.parse(records[2].text.slice('PI_COMPLEXITY '.length)), {
    stage: 'implementer', complexity: 'large', requiredMutationAnchors: [],
    largeMutation: false, reason: 'prepare', usage: { input: 10, output: 7 },
    source: 'implementation-planner-harness-default',
  });
  assert.equal(records[3].text, 'PI_BOOTSTRAP {"phase":"prepared_state_applied","status":"prepared","beforeFirstProviderRequest":true}');
});

test('#741 fallback planner preserves unknown token counts, warn levels and nullable fields', () => {
  const prepared = { status: 'fallback', failureClass: 'provider_timeout', reason: 'network' };
  const records = plannerTelemetryRecords(prepared, { preparationState: 'PREPARATION_FALLBACK', evidenceBudget: 0 });
  assert.deepEqual(records.map(r => r.level), ['log', 'warn', 'log']);
  assert.equal(records[0].text,
    '[PI][planner] prepared status=fallback duration=unknownms evidence_actions=unknown turns=unknown in=unknown out=unknown plan_bytes=0');
  assert.deepEqual(JSON.parse(records[1].text.slice('PI_PREPARATION_FALLBACK '.length)), {
    stage: 'implementer', preparationState: 'PREPARATION_FALLBACK', evidenceBudget: 0,
    source: 'implementation-planner', failureClass: 'provider_timeout',
    recovery: 'continue_without_planner_output', reason: 'network',
    plannerDurationMs: undefined, evidenceActions: null, providerTurns: null,
  });
  assert.equal(records[2].text, 'PI_BOOTSTRAP {"phase":"prepared_state_applied","status":"fallback","beforeFirstProviderRequest":true}');
});

test('#741 coding telemetry preserves structured payload, readable projection and channel levels', () => {
  const fields = { side: 'fork', agent: 'coder', status: 'ok', durationMs: 3, reason: 'hello\nthere', secret: 'unprojected' };
  const events = codingSessionTelemetryRecords('completed', fields);
  assert.deepEqual(events.map(r => r.level), ['log', 'log']);
  assert.equal(events[0].text, '[PI][coding] phase=completed side=fork agent=coder status=ok durationMs=3 reason=hello there');
  assert.equal(events[1].text, 'PI_CODING_SESSION {"phase":"completed","side":"fork","agent":"coder","status":"ok","durationMs":3,"reason":"hello\\nthere","secret":"unprojected"}');
  for (const phase of ['failed', 'rejected', 'cancelled']) {
    assert.deepEqual(codingSessionTelemetryRecords(phase, { side: 'fork' }).map(r => r.level), ['warn', 'warn']);
  }
  for (const phase of ['blocked', 'ended_without_submit']) {
    assert.deepEqual(codingSessionTelemetryRecords(phase, { side: 'fork' }).map(r => r.level), ['warn', 'log']);
  }
  assert.deepEqual(codingSessionTelemetryRecords('started', {}).map(r => r.level), ['log', 'log']);
});

test('#741 readable coding log redacts from summary by allowlist and truncates long values', () => {
  const reason = 'x'.repeat(130);
  const [human, structured] = codingSessionTelemetryRecords('rejected', {
    reason, irrelevantSecret: 'secret', tool: 'write', side: null,
  });
  assert.equal(human.text, '[PI][coding] phase=rejected tool=write reason=' + 'x'.repeat(100));
  assert.ok(!human.text.includes('secret'));
  assert.match(structured.text, /"irrelevantSecret":"secret"/);
});

test('#741 runtime retains live-state reads and owns console/emission hooks', () => {
  const source = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  assert.match(source, /from '\.\/pi-common\/runtime-budget-telemetry\.mjs'/);
  assert.match(source, /pi\.on\('turn_start'/);
  assert.match(source, /turnStartBudgetTelemetry\(/);
  assert.match(source, /plannerTelemetryRecords\(/);
  assert.match(source, /codingSessionTelemetryRecords\(/);
  assert.match(source, /responseHitOutputCeilingValue\(outputTokens, activeResponseCap\)/);
  assert.match(source, /controller\.afterTurn\(outputTokens\)/);
});
