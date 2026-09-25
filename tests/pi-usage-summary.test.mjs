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

test("usageWarning flags a run stuck far past the response threshold", () => {
  // Real observed stuck Architect "keep" run: 217 responses, 4375.7s model time.
  const message = usageWarning(217, 4375.7, { maxResponses: 60, maxSeconds: 1800 });
  assert.match(message, /217 responses exceeds the 60-response guard threshold/);
});

test("usageWarning flags a run stuck past the model-time threshold alone", () => {
  const message = usageWarning(10, 2000, { maxResponses: 60, maxSeconds: 1800 });
  assert.match(message, /2000\.0s of model time exceeds the 1800s guard threshold/);
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

test("the CLI emits a warning annotation once a run is stuck", () => {
  const metrics = Array.from({ length: 61 }, (_, i) => (
    { call: "main", response: i + 1, usage: { input: 10, output: 5, totalTokens: 15 }, responseMs: 100 }
  ));
  const stdout = run(metrics);
  assert.match(stdout, /::warning::Pi usage: 61 responses exceeds the 60-response guard threshold/);
});
