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
