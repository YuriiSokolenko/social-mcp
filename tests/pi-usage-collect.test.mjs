import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("aggregates a cancelled attempt once and preserves it on reprocessing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-"));
  const csvFile = join(dir, "usage.csv");
  const eventFile = join(dir, "event.json");
  const mockFile = join(dir, "mock.mjs");
  writeFileSync(csvFile, readFileSync("reports/pi-usage.csv", "utf8").split("\n")[0] + "\n");
  writeFileSync(eventFile, JSON.stringify({ workflow_run: {
    id: 123, run_attempt: 2, status: "completed", name: "Pi Issue #51",
    path: ".github/workflows/pi-issue-agent.yml",
    head_repository: { full_name: "test/repo" },
  } }));
  writeFileSync(mockFile, `
    import { readFileSync, writeFileSync } from "node:fs";
    const file = process.env.MOCK_CSV_FILE;
    globalThis.fetch = async (url, options = {}) => {
      if (url.includes("/attempts/2/jobs")) return Response.json({ jobs: [{
        id: 789, name: "pi", conclusion: "cancelled",
        started_at: "2026-09-24T10:00:00Z", completed_at: "2026-09-24T10:05:00Z",
      }] });
      if (url.endsWith("/jobs/789/logs")) return new Response([
        '2026-09-24T10:00:01Z PI_TASK {"issue":51,"phase":"implementation","call":"main"}',
        '2026-09-24T10:00:02Z   PI_METRIC {"issue":51,"call":"main","response":99,"usage":{"totalTokens":99999}}',
        '2026-09-24T10:00:03Z PI_METRIC {"issue":51,"call":"main","response":1,"usage":{"input":20,"output":5,"totalTokens":25},"responseMs":2000}',
        '2026-09-24T10:00:04Z PI_METRIC {"issue":51,"call":"main","response":2,"usage":{"input":30,"output":7,"totalTokens":37},"responseMs":3000}',
      ].join("\\n"));
      if (url.includes("/contents/reports/pi-usage.csv") && options.method === "PUT") {
        writeFileSync(file, Buffer.from(JSON.parse(options.body).content, "base64"));
        return Response.json({ content: { sha: "new" } });
      }
      if (url.includes("/contents/reports/pi-usage.csv")) return Response.json({
        content: readFileSync(file).toString("base64"), sha: "old",
      });
      throw new Error("Unexpected URL " + url);
    };
  `);
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(mockFile).href, "scripts/pi-usage-collect.mjs"], {
      encoding: "utf8", env: {
        ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: "test/repo",
        GITHUB_TOKEN: "synthetic-token", MOCK_CSV_FILE: csvFile,
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const rows = readFileSync(csvFile, "utf8").trim().split("\n");
  assert.equal(rows.length, 3); // header, issue total, one attempt
  assert.match(rows[1], /^issue,51,all,,,/);
  assert.match(rows[1], /,2,50,12,0,0,62,5\.0,300,/);
  assert.match(rows[2], /^attempt,51,implementation,123,2,cancelled,/);
});


test("ignores a skipped Pi job without requesting its nonexistent log", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-skipped-"));
  const eventFile = join(dir, "event.json");
  const mockFile = join(dir, "mock.mjs");
  writeFileSync(eventFile, JSON.stringify({ workflow_run: {
    id: 456, run_attempt: 1, status: "completed", name: "Pi review PR #67",
    path: ".github/workflows/pi-pr-review.yml",
    head_repository: { full_name: "test/repo" },
  } }));
  writeFileSync(mockFile, `
    globalThis.fetch = async (url) => {
      if (url.includes("/attempts/1/jobs")) return Response.json({ jobs: [{
        id: 999, name: "review", conclusion: "skipped",
      }] });
      throw new Error("Skipped job must not request a log: " + url);
    };
  `);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(mockFile).href, "scripts/pi-usage-collect.mjs"], {
    encoding: "utf8", env: {
      ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "synthetic-token",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Job 999 was skipped; no log to collect/);
  assert.match(result.stdout, /No Pi issue sessions found in completed run/);
});

test("treats a completed job with unavailable 404 logs as non-fatal telemetry loss", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-missing-log-"));
  const eventFile = join(dir, "event.json");
  const mockFile = join(dir, "mock.mjs");
  writeFileSync(eventFile, JSON.stringify({ workflow_run: {
    id: 460, run_attempt: 1, status: "completed", name: "Pi dispatcher",
    path: ".github/workflows/pi-dispatcher.yml",
    head_repository: { full_name: "test/repo" },
  } }));
  writeFileSync(mockFile, `
    globalThis.setTimeout = (callback) => { callback(); return 0; };
    globalThis.fetch = async (url) => {
      if (url.includes("/attempts/1/jobs")) return Response.json({ jobs: [{
        id: 1001, name: "dispatcher", conclusion: "success",
      }] });
      if (url.endsWith("/jobs/1001/logs")) return new Response("missing", { status: 404 });
      throw new Error("Unexpected URL " + url);
    };
  `);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(mockFile).href, "scripts/pi-usage-collect.mjs"], {
    encoding: "utf8", env: {
      ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "synthetic-token",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /log is unavailable after completion; skipping usage collection/);
  assert.match(result.stdout, /No Pi issue sessions found in completed run/);
});

test("collects a Pi Architect run's usage under its 'architect' job name", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-architect-"));
  const csvFile = join(dir, "usage.csv");
  const eventFile = join(dir, "event.json");
  const mockFile = join(dir, "mock.mjs");
  writeFileSync(csvFile, readFileSync("reports/pi-usage.csv", "utf8").split("\n")[0] + "\n");
  writeFileSync(eventFile, JSON.stringify({ workflow_run: {
    id: 321, run_attempt: 1, status: "completed", name: "Pi Architect #9",
    path: ".github/workflows/pi-architect.yml",
    head_repository: { full_name: "test/repo" },
  } }));
  writeFileSync(mockFile, `
    import { readFileSync, writeFileSync } from "node:fs";
    const file = process.env.MOCK_CSV_FILE;
    globalThis.fetch = async (url, options = {}) => {
      if (url.includes("/attempts/1/jobs")) return Response.json({ jobs: [{
        id: 654, name: "architect", conclusion: "success",
        started_at: "2026-09-25T11:16:00Z", completed_at: "2026-09-25T12:29:24Z",
      }] });
      if (url.endsWith("/jobs/654/logs")) return new Response([
        '2026-09-25T11:16:12Z PI_TASK {"issue":9,"phase":"architect","call":"main"}',
        '2026-09-25T12:29:21Z PI_METRIC {"issue":9,"call":"main","response":217,"usage":{"totalTokens":91519},"responseMs":20730}',
      ].join("\\n"));
      if (url.includes("/contents/reports/pi-usage.csv") && options.method === "PUT") {
        writeFileSync(file, Buffer.from(JSON.parse(options.body).content, "base64"));
        return Response.json({ content: { sha: "new" } });
      }
      if (url.includes("/contents/reports/pi-usage.csv")) return Response.json({
        content: readFileSync(file).toString("base64"), sha: "old",
      });
      throw new Error("Unexpected URL " + url);
    };
  `);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(mockFile).href, "scripts/pi-usage-collect.mjs"], {
    encoding: "utf8", env: {
      ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "synthetic-token", MOCK_CSV_FILE: csvFile,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = readFileSync(csvFile, "utf8").trim().split("\n");
  assert.match(rows[2], /^attempt,9,architect,321,1,success,1,0,0,0,0,91519,20\.7,4404,/);
});

test("rejects a run with a trusted-looking title but an unrelated workflow path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-untrusted-"));
  const eventFile = join(dir, "event.json");
  writeFileSync(eventFile, JSON.stringify({ workflow_run: {
    id: 457, run_attempt: 1, status: "completed", name: "Pi review PR #67",
    path: ".github/workflows/ci.yml",
    head_repository: { full_name: "test/repo" },
  } }));
  const result = spawnSync(process.execPath, ["scripts/pi-usage-collect.mjs"], {
    encoding: "utf8", env: {
      ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "synthetic-token",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a trusted Pi workflow/);
});

test("CSV separates provider response time from delegated lifecycle time", () => {
  const source = readFileSync("scripts/pi-usage-collect.mjs", "utf8");
  assert.match(source, /model_seconds: ledger\.totals\.providerResponseMs \/ 1000/);
  assert.match(source, /delegated_lifecycle_seconds: ledger\.totals\.delegatedLifecycleMs \/ 1000/);
  assert.doesNotMatch(source, /model_seconds: ledger\.totals\.delegatedLifecycleMs/);
});

test("#425 summary and CSV agree on known totals and incompleteness for the same records", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-agree-"));
  const csvFile = join(dir, "usage.csv");
  const eventFile = join(dir, "event.json");
  const mockFile = join(dir, "mock.mjs");
  const metricsFile = join(dir, "metrics.jsonl");
  const records = [
    { issue: 51, phase: "implementation", call: "main", response: 1, usage: { input: 20, output: 5, totalTokens: 25 }, responseMs: 2000 },
    { issue: 51, phase: "implementation", call: "main", response: 2, usage: null, reason: "provider_usage_unavailable" },
    { issue: 51, phase: "implementation", descendant: true, call: "coding", childSession: "s1", response: 1, usage: { input: 30, output: 7, totalTokens: 37 } },
    { issue: 51, phase: "implementation", descendant: true, call: "coding", childSession: "s1", response: 1, usage: { input: 30, output: 7, totalTokens: 37 } },
    { issue: 51, phase: "implementation", descendant: true, call: "coding", scope: "session", childSession: "s1", status: "timed_out", usage: null },
    { issue: 51, phase: "implementation", descendant: true, call: "planner", scope: "session", childSession: "p1", status: "failed", usage: { input: 4, output: 1, totalTokens: 5, turns: 1, durationMs: 7000 } },
  ];
  writeFileSync(metricsFile, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const summary = spawnSync(process.execPath, ["scripts/pi-usage-summary.mjs"], {
    encoding: "utf8", env: { ...process.env, PI_METRICS_FILE: metricsFile, PI_ISSUE: "51", PI_PHASE: "implementation" },
  });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /INCOMPLETE, known lower bound\): 3 logical usage records · 3 provider responses .* total 67 /);

  writeFileSync(csvFile, readFileSync("reports/pi-usage.csv", "utf8").split("\n")[0] + "\n");
  writeFileSync(eventFile, JSON.stringify({ workflow_run: {
    id: 321, run_attempt: 1, status: "completed", name: "Pi Issue #51",
    path: ".github/workflows/pi-issue-agent.yml", head_repository: { full_name: "test/repo" },
  } }));
  const log = ['2026-09-24T10:00:01Z PI_TASK {"issue":51,"phase":"implementation","call":"main"}',
    ...records.map((record) => `2026-09-24T10:00:02Z PI_METRIC ${JSON.stringify(record)}`)].join("\n");
  writeFileSync(mockFile, `
    import { readFileSync, writeFileSync } from "node:fs";
    const file = process.env.MOCK_CSV_FILE;
    globalThis.fetch = async (url, options = {}) => {
      if (url.includes("/attempts/1/jobs")) return Response.json({ jobs: [{ id: 1, name: "pi", conclusion: "success" }] });
      if (url.endsWith("/jobs/1/logs")) return new Response(${JSON.stringify(log)});
      if (url.includes("/contents/reports/pi-usage.csv") && options.method === "PUT") {
        writeFileSync(file, Buffer.from(JSON.parse(options.body).content, "base64"));
        return Response.json({ content: { sha: "new" } });
      }
      if (url.includes("/contents/reports/pi-usage.csv")) return Response.json({ content: readFileSync(file).toString("base64"), sha: "old" });
      throw new Error("Unexpected URL " + url);
    };
  `);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(mockFile).href, "scripts/pi-usage-collect.mjs"], {
    encoding: "utf8", env: { ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: "test/repo", GITHUB_TOKEN: "synthetic-token", MOCK_CSV_FILE: csvFile },
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = readFileSync(csvFile, "utf8").trim().split("\n");
  const header = rows[0].split(",");
  const attempt = Object.fromEntries(header.map((column, i) => [column, rows[2].split(",")[i]]));
  assert.equal(attempt.responses, "3");
  assert.equal(attempt.total_tokens, "67");
  assert.equal(attempt.model_seconds, "2.0", "only the explicit main response contributes provider response time");
  assert.equal(attempt.delegated_lifecycle_seconds, "7.0", "planner lifecycle time is visible in its own CSV column");
  assert.equal(attempt.complete, "false");
  assert.equal(attempt.unknown_requests, "2");
});
