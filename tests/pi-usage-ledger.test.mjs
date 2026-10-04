import assert from "node:assert/strict";
import test from "node:test";
import { completenessNote, summarizeUsage } from "../scripts/pi-common/usage-ledger.mjs";

const u = (input, output, totalTokens = input + output, extra = {}) => ({ input, output, totalTokens, ...extra });
const main = (response, usage) => ({ call: "main", response, usage });
const child = (childSession, response, usage, extra = {}) => ({ call: "coding", childSession, response, usage, ...extra });

test("#402: a null child aggregate cannot hide five completed child responses", () => {
  const records = [
    main(1, u(30000, 800)), main(2, u(20000, 600)), main(3, u(5163, 243)),
    { call: "planner", scope: "session", childSession: "p1", status: "completed", usage: u(2000, 293) },
    child("s1", 1, u(10000, 300)), child("s1", 2, u(12000, 400)), child("s1", 3, u(13000, 400)),
    child("s1", 4, u(14000, 400)), child("s1", 5, u(15573, 444)),
    { call: "coding", scope: "session", childSession: "s1", status: "ended_without_submit", usage: null },
  ];
  const ledger = summarizeUsage(records);
  assert.equal(ledger.calls.get("main").total, 56806);
  assert.equal(ledger.calls.get("coding").responses, 5);
  assert.equal(ledger.calls.get("coding").total, 66517);
  assert.equal(ledger.calls.get("planner").total, 2293);
  assert.equal(ledger.totals.total, 125616);
  assert.equal(ledger.complete, true);
});

test("#463: logical records expose provider turns while lifecycle duration stays separate from provider time", () => {
  const records = [
    { call: "planner", scope: "session", childSession: "p1", status: "completed",
      usage: u(30873, 1433, 32306, { turns: 4, durationMs: 92646 }) },
    { call: "main", response: 1, usage: u(23555, 133), responseMs: 12749 },
    { call: "main", response: 2, usage: u(11265, 390), responseMs: 26355 },
    { call: "main", response: 3, usage: u(11844, 108), responseMs: 11000 },
    child("c1", 1, u(15000, 3000)),
    child("c1", 2, u(16000, 2000)),
    child("c1", 3, u(17190, 432)),
    { call: "coding", scope: "session", childSession: "c1", status: "completed",
      usage: u(48190, 5432, 53622, { turns: 3, durationMs: 325000 }) },
  ];
  const ledger = summarizeUsage(records);
  assert.equal(ledger.totals.responses, 7, "existing logical-record count stays stable");
  assert.equal(ledger.totals.providerResponses, 10, "4 planner + 3 main + 3 coding provider turns");
  assert.equal(ledger.calls.get("planner").responses, 1);
  assert.equal(ledger.calls.get("planner").providerResponses, 4);
  assert.equal(ledger.calls.get("coding").responses, 3, "coding session roll-up does not duplicate its per-response records");
  assert.equal(ledger.calls.get("coding").providerResponses, 3);
  assert.equal(ledger.totals.providerResponseMs, 12749 + 26355 + 11000, "lifecycle duration is not provider response time");
  assert.equal(ledger.totals.delegatedLifecycleMs, 92646 + 325000, "planner/coding lifecycle time remains observable separately");
  assert.equal(ledger.complete, true);
});


test("a session roll-up is the fallback when a failed child has no per-response records", () => {
  const ledger = summarizeUsage([{
    call: "coding", scope: "session", childSession: "f", status: "error",
    usage: u(40, 2, 42, { turns: 2, durationMs: 9000 }),
  }]);
  assert.equal(ledger.totals.total, 42);
  assert.equal(ledger.totals.responses, 1);
  assert.equal(ledger.totals.providerResponses, 2);
  assert.equal(ledger.totals.providerResponseMs, 0, "a lifecycle-only roll-up cannot manufacture provider response time");
  assert.equal(ledger.totals.delegatedLifecycleMs, 9000);
  assert.equal(ledger.complete, true);
});

test("a main response without provider usage is an unknown obligation", () => {
  const ledger = summarizeUsage([main(1, u(10, 1)), main(2, null)]);
  assert.equal(ledger.complete, false);
  assert.equal(ledger.unknown[0].response, 2);
  assert.equal(ledger.totals.total, 11);
});

test("identical child-local response numbers in different sessions do not overwrite each other", () => {
  const ledger = summarizeUsage([child("a", 1, u(10, 1)), child("b", 1, u(20, 2))]);
  assert.equal(ledger.totals.responses, 2);
  assert.equal(ledger.totals.total, 33);
});

test("replayed duplicate records and an aggregate beside per-response usage do not double count", () => {
  const records = [
    child("a", 1, u(10, 1)), child("a", 1, u(10, 1)), child("a", 2, u(10, 1)),
    { call: "coding", aggregate: true, childSession: "a", response: 1, usage: u(20, 2) },
  ];
  const ledger = summarizeUsage(records);
  assert.equal(ledger.totals.total, 22);
  assert.equal(ledger.totals.responses, 2);
  assert.equal(ledger.totals.providerResponses, 2);
});

test("an aggregate with no per-response records is still attributed once", () => {
  const ledger = summarizeUsage([{ call: "subagent", aggregate: true, response: 1, usage: u(7, 3), responseMs: 1234 }]);
  assert.equal(ledger.totals.total, 10);
  assert.equal(ledger.totals.responseMs, 1234, "standalone aggregate keeps its generic elapsed timing");
  assert.equal(ledger.totals.providerResponseMs, 0, "aggregate tool elapsed time is not provider-only response time");
  assert.equal(ledger.totals.delegatedLifecycleMs, 1234, "aggregate tool elapsed time remains visible as delegated lifecycle time");
});

test("missing provider usage is unknown, not zero, and names the affected request", () => {
  const ledger = summarizeUsage([child("a", 1, u(10, 1)), child("a", 2, null, { reason: "provider_usage_unavailable" })]);
  assert.equal(ledger.complete, false);
  assert.deepEqual(ledger.unknown, [{ call: "coding", childSession: "a", response: 2, reason: "provider_usage_unavailable" }]);
  assert.equal(ledger.totals.total, 11);
  assert.match(completenessNote(ledger), /INCOMPLETE.*coding\/a#2.*lower bound/);
});

test("cancelled and timed-out sessions flag the in-flight request as unknown", () => {
  for (const status of ["cancelled", "timed_out"]) {
    const ledger = summarizeUsage([
      child("a", 1, u(10, 1)),
      { call: "coding", scope: "session", childSession: "a", status, usage: null },
    ]);
    assert.equal(ledger.complete, false, status);
    assert.equal(ledger.totals.total, 11);
    assert.equal(ledger.unknown[0].childSession, "a");
  }
});

test("a session that produced no usage at all is incomplete", () => {
  const ledger = summarizeUsage([{ call: "coding", scope: "session", childSession: "z", status: "error", usage: null }]);
  assert.equal(ledger.complete, false);
  assert.equal(ledger.unknown[0].reason, "session_usage_unavailable");
});

test("#399: 1,502,881 known tokens, root and reported totals rendered separately, planner flagged unknown", () => {
  const records = [
    main(1, u(1000000, 130945)),
    { call: "subagent", aggregate: true, response: 1, usage: u(14000, 2234) },
    child("c1", 1, u(300000, 55702)),
    { call: "planner", scope: "session", childSession: "p1", status: "timed_out", usage: null },
  ];
  const ledger = summarizeUsage(records);
  assert.equal(ledger.totals.total, 1130945 + 16234 + 355702);
  assert.equal(ledger.calls.get("main").total, 1130945);
  // The historical report counted the root plus its successful shell delegate only.
  assert.equal(ledger.calls.get("main").total + ledger.calls.get("subagent").total, 1147179);
  assert.equal(ledger.complete, false);
  assert.equal(ledger.unknown[0].call, "planner");
});

test("a timed-out session stays incomplete even when earlier responses were accounted", () => {
  const ledger = summarizeUsage([child("a", 1, u(10, 1)), { call: "planner", scope: "session", childSession: "a", status: "timed_out", usage: u(10, 1) }]);
  assert.equal(ledger.complete, false);
});

test("a larger session roll-up is kept as the lower bound next to smaller per-response sums, flagged as a mismatch", () => {
  const ledger = summarizeUsage([
    child("a", 1, u(10, 2)),
    { call: "coding", scope: "session", childSession: "a", status: "error", usage: u(50, 5) },
  ]);
  assert.equal(ledger.totals.total, 55);
  assert.equal(ledger.totals.responses, 1);
  assert.equal(ledger.complete, false);
  assert.equal(ledger.unknown[0].reason, "session_response_usage_mismatch");
});

test("a smaller roll-up never lowers the per-response sum", () => {
  const ledger = summarizeUsage([child("a", 1, u(50, 5)), { call: "coding", scope: "session", childSession: "a", status: "error", usage: u(10, 2) }]);
  assert.equal(ledger.totals.total, 55);
  assert.equal(ledger.complete, false);
});

test("equal totals with a different input/output breakdown is still a mismatch, never components above total", () => {
  const ledger = summarizeUsage([
    child("a", 1, u(50, 5)),
    { call: "coding", scope: "session", childSession: "a", status: "error", usage: u(40, 15) },
  ]);
  assert.equal(ledger.complete, false);
  assert.equal(ledger.unknown[0].reason, "session_response_usage_mismatch");
  const { input, output, cacheRead, cacheWrite, total } = ledger.totals;
  assert.deepEqual([input, output], [50, 15]);
  assert.ok(total >= input + output + cacheRead + cacheWrite);
});

test("a larger roll-up with redistributed components keeps total consistent with the components", () => {
  const ledger = summarizeUsage([
    child("a", 1, u(50, 5)),
    { call: "coding", scope: "session", childSession: "a", status: "error", usage: u(45, 15) },
  ]);
  const { input, output, cacheRead, cacheWrite, total } = ledger.totals;
  assert.deepEqual([input, output, total], [50, 15, 65]);
  assert.ok(total >= input + output + cacheRead + cacheWrite);
  assert.equal(ledger.complete, false);
});


test('#469 synthetic settlement stays logical but exact provider trace reports 24 real responses', () => {
  const records = [
    { call: 'planner', scope: 'session', childSession: 'planner-469', status: 'completed',
      usage: u(600, 60, 660, { turns: 6, durationMs: 6000 }) },
    main(1, u(100, 10)),
    ...Array.from({ length: 12 }, (_, index) => child('coding-469', index + 1, u(20, 2), { responseMs: 200 + index })),
    { call: 'coding', scope: 'session', childSession: 'coding-469', status: 'completed',
      usage: u(240, 24, 264, { turns: 12, durationMs: 12000 }) },
    ...Array.from({ length: 5 }, (_, index) => ({
      call: 'repair', response: index + 1, usage: u(15, 1), responseMs: 300 + index,
    })),
    {
      call: 'main',
      response: 2,
      usage: u(0, 0, 0),
      responseMs: 0,
      synthetic: true,
      record_type: 'synthetic_settlement',
    },
    ...Array.from({ length: 24 }, (_, index) => ({
      call: 'provider',
      provider_response: true,
      record_type: 'provider_response',
      response: index + 1,
      responseMs: 1000 + index,
    })),
  ];
  const ledger = summarizeUsage(records);
  assert.equal(ledger.totals.providerResponses, 24, '6 planner + 1 parent + 12 coding + 5 repair');
  assert.equal(
    ledger.totals.providerResponseMs,
    Array.from({ length: 24 }, (_, index) => 1000 + index).reduce((sum, value) => sum + value, 0),
  );
  assert.equal(ledger.calls.get('provider').providerResponses, 24);
  assert.equal(ledger.calls.get('provider').responses, 0);
  assert.ok(ledger.totals.responses > ledger.totals.providerResponses, 'logical roll-ups/synthetic records remain a separate dimension');
});

test('#469 synthetic zero-token response never increments fallback provider count', () => {
  const ledger = summarizeUsage([
    { call: 'main', response: 1, usage: u(10, 2), responseMs: 700 },
    {
      call: 'main',
      response: 2,
      usage: u(0, 0, 0),
      responseMs: 0,
      synthetic: true,
      record_type: 'synthetic_settlement',
    },
  ]);
  assert.equal(ledger.totals.responses, 2);
  assert.equal(ledger.totals.providerResponses, 1);
  assert.equal(ledger.totals.providerResponseMs, 700);
});
