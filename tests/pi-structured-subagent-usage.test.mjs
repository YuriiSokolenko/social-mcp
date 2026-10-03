import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runStructuredSubagent } from "../scripts/pi-common/structured-subagent.mjs";
import { summarizeUsage } from "../scripts/pi-common/usage-ledger.mjs";

const REQUEST = "prompt-template:subagent:request";
const RESPONSE = "prompt-template:subagent:response";

function harness(replies) {
  const handlers = [];
  const queue = [...replies];
  const pi = {
    events: {
      on: (name, fn) => { if (name === RESPONSE) handlers.push(fn); return () => handlers.splice(handlers.indexOf(fn), 1); },
      emit: (name, request) => {
        if (name !== REQUEST) return;
        const reply = queue.shift();
        if (reply === "never") return;
        setImmediate(() => handlers.slice().forEach((fn) => fn({ requestId: request.requestId, ownerRunId: "root", nodeId: request.nodeId, ...reply })));
      },
    },
  };
  const ctx = { sessionManager: { getSessionId: () => "root" }, cwd: process.cwd() };
  const dir = mkdtempSync(join(tmpdir(), "pi-sub-usage-"));
  const file = join(dir, "metrics.jsonl");
  process.env.PI_METRICS_FILE = file;
  const records = () => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { pi, ctx, records };
}
const options = (extra = {}) => ({ agent: "planner", nodeId: "n", task: "t", timeoutMs: 40, metricCall: "planner", ...extra });
const usage = (input, output) => ({ input, output, totalTokens: input + output });

test("a failed planner envelope keeps its usage in the ledger", async () => {
  const h = harness([{ status: "failed", error: "boom", usage: usage(30, 3) }]);
  await assert.rejects(runStructuredSubagent(h.pi, h.ctx, options()), /failed: boom/);
  const ledger = summarizeUsage(h.records());
  assert.equal(ledger.totals.total, 33);
  assert.equal(ledger.complete, true);
});

test("planner fallback and repair attempts are each attributed once, with the timeout flagged", async () => {
  const h = harness([
    { status: "failed", error: "Structured output validation failed: x", usage: usage(10, 1) },
    { status: "completed", result: { kind: "structured", value: {} }, usage: usage(20, 2) },
    "never",
  ]);
  await assert.rejects(runStructuredSubagent(h.pi, h.ctx, options({ schema: {} })));
  await runStructuredSubagent(h.pi, h.ctx, options({ schema: {} }));
  await assert.rejects(runStructuredSubagent(h.pi, h.ctx, options({ schema: {} })), /did not return within/);
  const records = h.records();
  assert.deepEqual(records.map((r) => r.status), ["failed", "completed", "timed_out"]);
  const ledger = summarizeUsage(records);
  assert.equal(ledger.totals.total, 33);
  assert.equal(ledger.complete, false);
  assert.match(ledger.unknown[0].reason, /timed_out/);
});
