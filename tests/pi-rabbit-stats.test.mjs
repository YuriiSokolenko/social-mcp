import assert from "node:assert/strict";
import test from "node:test";
import { classify, summarize } from "../scripts/pi-rabbit-stats.mjs";

const req = (id, maxTokens) => ({ direction: "request", id, time: "2026-09-29T00:00:00Z", body: { max_tokens: maxTokens } });
const chunk = (id, delta, finish = null, extra = {}) => ({
  direction: "response_chunk", id, time: "2026-09-29T00:00:01Z",
  body: { choices: [{ delta, finish_reason: finish }], ...extra },
});

test("summarize separates tool calls, mid-reasoning truncation and unparseable args", () => {
  const records = [
    req("a", 2048),
    chunk("a", { reasoning_content: "think" }),
    chunk("a", { tool_calls: [{ index: 0, function: { name: "read", arguments: '{"path":"x"}' } }] }, "tool_calls",
      { usage: { completion_tokens: 100, prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 } }, timings: { predicted_ms: 5000 } }),
    req("b", 2048),
    chunk("b", { reasoning_content: "very long thinking" }, "length",
      { usage: { completion_tokens: 2048, prompt_tokens: 1000 }, timings: { predicted_ms: 90000 } }),
    req("c", 4096),
    chunk("c", { tool_calls: [{ index: 0, function: { name: "write", arguments: '{"path":"x","content":"cut' } }] }, "length",
      { usage: { completion_tokens: 2048 }, timings: { predicted_ms: 60000 } }),
  ];
  const s = summarize(records);
  assert.equal(s.turns, 3);
  assert.deepEqual(s.outcomes, { tool_call: 2, truncated: 1 });
  assert.equal(s.truncated.outputTokens, 2048);
  assert.deepEqual(s.unparseableToolArgs, { write: 1 });
  assert.deepEqual(s.byCeiling.find((c) => c.ceiling === 2048), { ceiling: 2048, turns: 2, truncated: 1 });
  assert.equal(s.byTool.find((t) => t.tool === "write").seconds, 60);
  assert.equal(Math.round(s.cacheRatio * 100), 45);
});

test("summarize honours --since and classify handles non-streamed responses", () => {
  const old = { ...req("old", 512), time: "2026-09-01T00:00:00Z" };
  const nonStream = { direction: "response", id: "n", time: "2026-09-29T00:00:02Z",
    body: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } };
  const s = summarize([old, req("n", 100), nonStream], { since: "2026-09-29T00:00:00Z" });
  assert.equal(s.turns, 1);
  assert.deepEqual(s.outcomes, { text_only: 1 });
  assert.equal(classify({ calls: new Map(), reasoning: 5, content: 0, finish: "stop", timings: {}, usage: {} }), "reasoning_only");
});
