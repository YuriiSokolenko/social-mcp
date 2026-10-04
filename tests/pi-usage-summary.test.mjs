import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { usageWarning } from "../scripts/pi-usage-summary.mjs";

test("usageWarning is silent for a normal-sized run", () => {
  // Real observed Architect "revise" run: 14 responses, 1207.5s model time.
  assert.equal(usageWarning(14, 1207.5), null);
});

test("default thresholds sit above the loop guard's own turn/timeout budget", () => {
  // Defaults must not fire on legitimate long split runs: they should clear
  // PI_MAX_TURNS (100) and stay well under timeout-minutes (120) for Architect.
  assert.equal(usageWarning(100, 5000), null);
  assert.ok(usageWarning(121, 100));
  assert.ok(usageWarning(10, 5401));
});

test("usageWarning flags a run stuck far past the response threshold", () => {
  // Real observed stuck Architect "keep" run: 217 responses, 4375.7s model time.
  const message = usageWarning(217, 4375.7, { maxResponses: 60, maxSeconds: 1800 });
  assert.match(message, /217 provider responses exceeds the 60-response guard threshold/);
});

test("usageWarning flags a run stuck past the model-time threshold alone", () => {
  const message = usageWarning(10, 2000, { maxResponses: 60, maxSeconds: 1800 });
  assert.match(message, /2000\.0s of provider response time exceeds the 1800s guard threshold/);
});

function run(metricsLines) {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-summary-"));
  const metricsFile = join(dir, "metrics.jsonl");
  const summaryFile = join(dir, "summary.md");
  writeFileSync(metricsFile, metricsLines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  writeFileSync(summaryFile, "");
  const result = spawnSync(process.execPath, ["scripts/pi-usage-summary.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env, PI_METRICS_FILE: metricsFile, GITHUB_STEP_SUMMARY: summaryFile,
      PI_ISSUE: "9", PI_PHASE: "architect", PI_USAGE_WARN_RESPONSES: "60", PI_USAGE_WARN_SECONDS: "1800",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("the CLI emits no warning annotation for a small run", () => {
  const stdout = run([{ call: "main", response: 1, usage: { input: 10, output: 5, totalTokens: 15 }, responseMs: 2000 }]);
  assert.doesNotMatch(stdout, /::warning::/);
});

test("the CLI includes finalized subagent usage without applying main guard thresholds to delegates", () => {
  const metrics = [
    { call: "main", response: 1, usage: { input: 10, output: 5, totalTokens: 15 }, responseMs: 2000 },
    ...Array.from({ length: 80 }, (_, i) => ({
      call: "subagent", response: i + 1,
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5, totalTokens: 175 },
      responseMs: 1000,
    })),
  ];
  const stdout = run(metrics);
  assert.match(stdout, /Pi usage: 81 logical usage records · 81 provider responses · fresh 8,010 in \/ 1,605 out · cache read 4,000 · total 14,015 · 82\.0 s known provider response time · 0\.0 s delegated lifecycle time/);
  assert.doesNotMatch(stdout, /::warning::Pi usage:/);
});

test("the CLI reports delegated lifecycle time without mislabeling it as provider response time", () => {
  const stdout = run([
    {
      call: "planner", scope: "session", childSession: "p1", status: "completed",
      usage: { input: 100, output: 20, totalTokens: 120, turns: 4, durationMs: 90000 },
    },
    { call: "main", response: 1, usage: { input: 10, output: 5, totalTokens: 15 }, responseMs: 2000 },
    { call: "coding", childSession: "c1", response: 1, usage: { input: 20, output: 10, totalTokens: 30 } },
    { call: "coding", childSession: "c1", response: 2, usage: { input: 30, output: 10, totalTokens: 40 } },
    {
      call: "coding", scope: "session", childSession: "c1", status: "completed",
      usage: { input: 50, output: 20, totalTokens: 70, turns: 2, durationMs: 120000 },
    },
  ]);
  assert.match(stdout, /Pi usage: 4 logical usage records · 7 provider responses/);
  assert.match(stdout, /2\.0 s known provider response time/);
  assert.match(stdout, /210\.0 s delegated lifecycle time/);
});

test("the CLI emits a warning annotation once a run is stuck", () => {
  const metrics = Array.from({ length: 61 }, (_, i) => (
    { call: "main", response: i + 1, usage: { input: 10, output: 5, totalTokens: 15 }, responseMs: 100 }
  ));
  const stdout = run(metrics);
  assert.match(stdout, /::warning::Pi usage: 61 provider responses exceeds the 60-response guard threshold/);
});

test("the CLI labels totals as a known lower bound when child usage is unavailable", () => {
  const stdout = run([
    { call: "main", response: 1, usage: { input: 10, output: 5, totalTokens: 15 }, responseMs: 1000 },
    { call: "coding", scope: "session", childSession: "s1", status: "timed_out", usage: null },
  ]);
  assert.match(stdout, /Pi usage \(INCOMPLETE, known lower bound\): 1 logical usage records · 1 provider responses/);
  assert.match(stdout, /::warning::INCOMPLETE: usage unavailable.*coding\/s1/);
});
