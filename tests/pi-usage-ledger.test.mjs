import assert from "node:assert/strict";
import test from "node:test";
import { completenessNote, summarizeUsage } from "../scripts/pi-common/usage-ledger.mjs";

const u = (input, output, totalTokens = input + output) => ({ input, output, totalTokens });
const main = (response, usage) => ({ call: "main", response, usage });
const child = (childSession, response, usage, extra = {}) => ({ call: "coding", childSession, response, usage, ...extra });

test("#402: a null child aggregate cannot hide five completed child responses", () => {
  const records = [
    main(1, u(50000, 1000, 55163 - 5000)), main(2, u(5000, 643, 5643)), main(3, u(0, 0, 0)),
    // Planner usage and five child responses (64,573 in / 1,944 out / 66,517 total).
    { call: "planner", response: 1, usage: u(2000, 293, 2293) },
    child("s1", 1, u(10000, 300, 10300)), child("s1", 2, u(12000, 400, 12400)), child("s1", 3, u(13000, 400, 13400)),
    child("s1", 4, u(14000, 400, 14400)), child("s1", 5, u(15573, 444, 16017)),
    { call: "coding", scope: "session", childSession: "s1", status: "ended_without_submit", usage: null },
  ];
  const ledger = summarizeUsage(records);
  assert.equal(ledger.calls.get("coding").responses, 5);
  assert.equal(ledger.calls.get("coding").total, 66517);
  assert.equal(ledger.complete, true);
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
});

test("an aggregate with no per-response records is still attributed once", () => {
  const ledger = summarizeUsage([{ call: "subagent", aggregate: true, response: 1, usage: u(7, 3) }]);
  assert.equal(ledger.totals.total, 10);
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

test("#399: 1,502,881 known tokens while the timed-out planner stays flagged unknown", () => {
  const records = [
    main(1, u(1000000, 130945, 1130945)),
    child("c1", 1, u(300000, 71936, 371936)),
    { call: "planner", scope: "session", childSession: "p1", status: "timed_out", usage: null },
  ];
  const ledger = summarizeUsage(records);
  assert.equal(ledger.totals.total, 1502881);
  assert.equal(ledger.calls.get("main").total, 1130945);
  assert.equal(ledger.complete, false);
  assert.equal(ledger.unknown[0].call, "planner");
});
