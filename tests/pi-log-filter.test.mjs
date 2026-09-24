import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function render(events) {
  const input = events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n") + "\n";
  const result = spawnSync(process.execPath, ["scripts/pi-log-filter.mjs"], {
    input,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "true" },
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
  assert.match(output, /  ::warning::injected/);
  assert.doesNotMatch(output, /^::warning::/m);
});
