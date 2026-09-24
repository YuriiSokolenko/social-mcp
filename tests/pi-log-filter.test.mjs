import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function render(events, env = {}) {
  const input = events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n") + "\n";
  const result = spawnSync(process.execPath, ["scripts/pi-log-filter.mjs"], {
    input,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "true", ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("redacts a bearer token and key split across text deltas", () => {
  const output = render([
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Authorization: Bea" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "rer syntheticSecret123\napi_" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "key=syntheticKey456\nDone" } },
    { type: "message_end", message: { role: "assistant", content: [] } },
  ]);
  assert.match(output, /Authorization:\[REDACTED\]/);
  assert.match(output, /api_key=\[REDACTED\]/);
  assert.match(output, /Done/);
  assert.doesNotMatch(output, /syntheticSecret123|syntheticKey456/);
});

test("keeps thinking, response and tool details in separate groups with visible step totals", () => {
  const output = render([
    { type: "turn_start" },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Checking tests\n" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Found a fix\n" } },
    { type: "message_end", message: { role: "assistant", content: [], usage: { input: 10, output: 5, totalTokens: 15 } } },
    { type: "tool_execution_start", toolName: "bash", toolCallId: "test", args: { command: "pytest tests/" } },
    { type: "tool_execution_end", toolName: "bash", toolCallId: "test", result: { content: [{ type: "text", text: "2 passed" }] } },
    { type: "agent_end", messages: [] },
  ], { PI_ISSUE: "51", PI_PHASE: "implementation" });
  assert.match(output, /::group::💭 Thinking[\s\S]*Checking tests[\s\S]*::endgroup::/);
  assert.match(output, /::group::📝 Response[\s\S]*Found a fix[\s\S]*::endgroup::/);
  assert.match(output, /::group::🔧 bash · details[\s\S]*2 passed[\s\S]*::endgroup::/);
  assert.equal((output.match(/::group::/g) ?? []).length, 3);
  assert.match(output, /Model #1 · .*UTC/);
  assert.match(output, /Model totals \(1 responses\): .*total 15/);
  assert.match(output, /PI_METRIC \{"issue":51,"phase":"implementation"/);
});

test("reports completed usage at EOF when Pi never emits agent_end", () => {
  const output = render([
    { type: "turn_start" },
    { type: "message_end", message: { role: "assistant", content: [], usage: { input: 20, output: 4, totalTokens: 24 } } },
    { type: "turn_start" },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Still working\n" } },
  ], { PI_ISSUE: "51" });
  assert.match(output, /Agent interrupted/);
  assert.match(output, /Model totals \(1 responses\): .*total 24/);
  assert.equal((output.match(/::group::/g) ?? []).length, (output.match(/::endgroup::/g) ?? []).length);
});

test("does not release a long incomplete token before its delimiter", () => {
  const secret = "synthetic".repeat(200);
  const output = render([
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Bearer " + secret.slice(0, 900) } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: secret.slice(900) + " complete\n" } },
  ]);
  assert.doesNotMatch(output, /synthetic/);
  assert.match(output, /complete/);
});

test("does not split a long token even when its delimiter is buffered", () => {
  const secret = "synthetic".repeat(150);
  const output = render([
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `before Bearer ${secret} after` } },
    { type: "message_end", message: { role: "assistant", content: [] } },
  ]);
  assert.match(output, /before Bearer \[REDACTED\] after/);
  assert.doesNotMatch(output, /synthetic/);
});

test("redacts tool summaries, details, malformed input and indents final lines", () => {
  const output = render([
    { type: "tool_execution_start", toolName: "bash", toolCallId: "x", args: { command: "echo password=syntheticPassword123" } },
    { type: "tool_execution_end", toolName: "bash", toolCallId: "x", result: { content: [{ type: "text", text: "gh_token=syntheticToken123" }] } },
    "malformed authorization=syntheticFallback123",
    { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Done\n::warning::injected" }] }] },
  ]);
  assert.doesNotMatch(output, /syntheticPassword123|syntheticToken123|syntheticFallback123/);
  assert.match(output.replace(/\x1b\[[\d;]*m/g, ""), /  ::warning::injected/);
  assert.doesNotMatch(output, /^::warning::/m);
});
