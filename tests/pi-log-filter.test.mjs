import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function renderWithSummary(events, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-log-filter-"));
  const summaryPath = join(dir, "summary.md");
  const stdout = render(events, { ...env, GITHUB_STEP_SUMMARY: summaryPath });
  const summary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
  return { stdout, summary };
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
  assert.match(output, /::group::\[PI\]\[implementation\/main\] 💭 Thinking[\s\S]*Checking tests[\s\S]*::endgroup::/);
  assert.match(output, /::group::\[PI\]\[implementation\/main\] 📝 Response[\s\S]*Found a fix[\s\S]*::endgroup::/);
  assert.match(output, /::group::\[PI\]\[implementation\/main\] ✓ bash · \$ pytest tests\/ · [\d.]+ (ms|s)[\s\S]*2 passed[\s\S]*::endgroup::/);
  assert.equal((output.match(/::group::/g) ?? []).length, 3);
  assert.match(output, /Model #1 · .*UTC/);
  assert.match(output, /Model totals \(1 responses\): .*total 15/);
  assert.match(output, /PI_METRIC \{"issue":51,"phase":"implementation"/);
});

test('failed tool diagnostics stay visible and the complete sanitized event is retained by reference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-log-filter-diagnostics-'));
  const file = join(dir, 'diagnostics.jsonl');
  const detail = 'validation detail '.repeat(2200);
  const output = render([
    { type: 'tool_execution_start', toolName: 'run_check', toolCallId: 'bad-check', args: { kind: 'pytest' } },
    { type: 'tool_execution_end', toolName: 'run_check', toolCallId: 'bad-check', isError: true, result: { content: [{ type: 'text', text: `api_key=syntheticToolSecret123\nopaque=abcd\n${detail}` }] } },
  ], { PI_DIAGNOSTICS_FILE: file, PI_PHASE: 'implementer', PI_CALL: 'main', GH_TOKEN: 'abcd' });
  assert.match(output, /\[PI\]\[implementer\/main\] ✗ run_check/);
  assert.doesNotMatch(output, /::group::✗ run_check/);
  assert.match(output, /truncated [0-9]+ -> 8000 chars/);
  const artifact = readFileSync(file, 'utf8');
  assert.match(artifact, /api_key=\[REDACTED\]/);
  assert.match(artifact, /opaque=\[REDACTED\]/);
  assert.match(artifact, /validation detail/);
  assert.doesNotMatch(artifact, /syntheticToolSecret123|opaque=abcd/);
  assert.match(output, /api_key=\[REDACTED\]/);
  assert.match(output, /opaque=\[REDACTED\]/);
});

test('malformed tool arguments remain visible and are retained only on failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-log-filter-malformed-'));
  const file = join(dir, 'diagnostics.jsonl');
  const output = render([
    { type: 'tool_execution_start', toolName: 'edit', toolCallId: 'bad-args', args: { path: 'src/a.js', oldText: 'password: "two words"', input_token: 'syntheticSensitiveValue123' } },
    { type: 'tool_execution_end', toolName: 'edit', toolCallId: 'bad-args', isError: true, result: { content: [{ type: 'text', text: 'Malformed tool arguments: expected a string' }] } },
  ], { PI_DIAGNOSTICS_FILE: file });
  const artifact = readFileSync(file, 'utf8');
  assert.match(output, /Malformed tool arguments/);
  assert.match(artifact, /Malformed tool arguments/);
  assert.match(artifact, /password:\s*\[REDACTED\]/);
  assert.match(artifact, /input_token.*\[REDACTED\]/);
  assert.doesNotMatch(output + artifact, /two words|syntheticSensitiveValue123/);
});

test('nested stage/call streams have stable distinct lifecycle prefixes', () => {
  const main = render([{ type: 'agent_start' }], { PI_PHASE: 'implementer', PI_CALL: 'main' });
  const coding = render([{ type: 'agent_start' }], { PI_PHASE: 'implementer', PI_CALL: 'coding' });
  assert.match(main, /\[PI\]\[implementer\/main\] ▶ Agent started/);
  assert.match(coding, /\[PI\]\[implementer\/coding\] ▶ Agent started/);
});

test('final failure summary carries lifecycle, latest check, checkpoint and usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-log-filter-final-failure-'));
  const failureFile = join(dir, 'failure.json');
  const diagnosticsFile = join(dir, 'diagnostics.jsonl');
  writeFileSync(failureFile, JSON.stringify({
    stage: 'implementer', failure_code: 'PI_TERMINAL_RECOVERY_BLOCKED',
    checkpoint: { worktree_preserved: true },
  }));
  const output = render([
    { type: 'turn_start' },
    { type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 120, output: 30, totalTokens: 150 } } },
    { type: 'tool_execution_start', toolName: 'run_check', toolCallId: 'check', args: { kind: 'pytest' } },
    { type: 'tool_execution_end', toolName: 'run_check', toolCallId: 'check', result: { details: {
      kind: 'pytest', status: 'fail', exit_code: 1, duration_ms: 8200,
      summary: '5 failures', diagnostics: [{}, {}, {}, {}, {}],
    }, content: [{ type: 'text', text: JSON.stringify({ status: 'fail', kind: 'pytest' }) }] } },
  ], { PI_PHASE: 'implementer', PI_CALL: 'main', PI_RUNTIME_FAILURE_FILE: failureFile, PI_DIAGNOSTICS_FILE: diagnosticsFile });
  assert.match(output, /\[PI\]\[check\] pytest fail exit=1 failures=5 duration=8\.2 s/);
  assert.match(output, /\[PI\]\[failure\] lifecycle=implementer\/main status=blocked category=PI_TERMINAL_RECOVERY_BLOCKED/);
  assert.match(output, /last_check=pytest:fail worktree_preserved=true usage="in 120 · out 30 · cache read 0 · cache write 0 · total 150" diagnostics=diagnostics\.jsonl#runtime-failure-/);
});

test('interrupted run still ends with a failure summary when runtime metadata is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-log-filter-missing-failure-'));
  const diagnosticsFile = join(dir, 'diagnostics.jsonl');
  const output = render([
    { type: 'tool_execution_start', toolName: 'run_check', toolCallId: 'check', args: { kind: 'pytest' } },
    { type: 'tool_execution_end', toolName: 'run_check', toolCallId: 'check', result: { details: {
      kind: 'pytest', status: 'timeout', exit_code: null, duration_ms: 120000, diagnostics: [],
    }, content: [{ type: 'text', text: 'timeout' }] } },
  ], { PI_PHASE: 'implementer', PI_CALL: 'main', PI_DIAGNOSTICS_FILE: diagnosticsFile });
  assert.match(output, /\[PI\]\[failure\] lifecycle=implementer\/main status=interrupted category=RUNTIME_FAILURE_METADATA_UNAVAILABLE/);
  assert.match(output, /last_tool=run_check.*last_check=pytest:timeout worktree_preserved=unknown/);
  assert.match(readFileSync(diagnosticsFile, 'utf8'), /RUNTIME_FAILURE_METADATA_UNAVAILABLE/);
});

test('diagnostic artifact write failure does not mask the failed tool result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-log-filter-artifact-error-'));
  const invalidPath = join(dir, 'is-a-directory');
  mkdirSync(invalidPath);
  const output = render([
    { type: 'tool_execution_end', toolName: 'edit', toolCallId: 'fail', isError: true, result: { content: [{ type: 'text', text: 'original tool failure' }] } },
  ], { PI_DIAGNOSTICS_FILE: invalidPath });
  assert.match(output, /original tool failure/);
});

test('short successful tool calls do not write full payloads to diagnostics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-log-filter-success-'));
  const file = join(dir, 'diagnostics.jsonl');
  const output = render([
    { type: 'tool_execution_start', toolName: 'read', toolCallId: 'read-1', args: { path: 'README.md' } },
    { type: 'tool_execution_end', toolName: 'read', toolCallId: 'read-1', result: { content: [{ type: 'text', text: 'short source' }] } },
    { type: 'agent_end', messages: [] },
  ], { PI_DIAGNOSTICS_FILE: file });
  assert.match(output, /short source/);
  assert.equal(existsSync(file), false);
});

test('run-check marker lines remain valid JSON for existing parsers', () => {
  const output = render([
    { type: 'turn_start' },
    { type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 2, output: 1 } } },
  ], { PI_ISSUE: '500', PI_PHASE: 'implementer' });
  const marker = output.split('\n').find(line => line.startsWith('PI_METRIC '));
  assert.ok(marker);
  assert.equal(JSON.parse(marker.slice('PI_METRIC '.length)).issue, 500);
});

test('every workflow that runs a Pi stage uploads its stage diagnostics file', () => {
  const paths = [
    ['pi-issue-agent.yml', 'implementer'], ['pi-pr-fix.yml', 'repair'],
    ['pi-triage.yml', 'triage'], ['pi-dispatcher.yml', 'dispatcher'],
    ['pi-architect.yml', 'architect'], ['pi-pr-review.yml', 'reviewer'],
  ];
  for (const [file, stage] of paths) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.match(workflow, new RegExp(`pi-diagnostics-${stage}-.*github\\.run_id`), `${file} uploads ${stage} diagnostics`);
  }
});

test("records finalized subagent tool usage as separate PI_METRIC rows", () => {
  const output = render([
    { type: "turn_start" },
    { type: "message_end", message: { role: "assistant", content: [], usage: { input: 10, output: 5, totalTokens: 15 } } },
    { type: "tool_execution_start", toolName: "subagent", toolCallId: "scout-1", args: { agent: "scout", task: "Return edit anchor", async: false } },
    { type: "tool_execution_end", toolName: "subagent", toolCallId: "scout-1", result: {
      content: [{ type: "text", text: "tasks/README.md" }],
      details: {},
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5 },
    } },
    { type: "agent_end", messages: [] },
  ], { PI_ISSUE: "115", PI_PHASE: "implementation" });

  assert.match(output, /PI_METRIC \{"issue":115,"phase":"implementation","call":"main","response":1/);
  assert.match(output, /PI_METRIC \{"issue":115,"phase":"implementation","call":"subagent","aggregate":true,"response":1,"agent":"scout","usage":\{"input":100,"output":20,"cacheRead":50,"cacheWrite":5,"totalTokens":175\},"responseMs":\d+\}/);
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

test("writes a nested Job Summary with a details block per turn and per tool call", () => {
  const { summary } = renderWithSummary([
    { type: "turn_start" },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Checking tests\n" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Found a fix\n" } },
    { type: "message_end", message: { role: "assistant", content: [], usage: { input: 10, output: 5, totalTokens: 15 } } },
    { type: "tool_execution_start", toolName: "bash", toolCallId: "test", args: { command: "pytest tests/" } },
    { type: "tool_execution_end", toolName: "bash", toolCallId: "test", result: { content: [{ type: "text", text: "2 passed" }] } },
    { type: "agent_end", messages: [] },
  ], { PI_ISSUE: "51", PI_PHASE: "implementation" });

  // Turn > tool is two levels of <details> nesting, which GitHub's raw log
  // ::group:: cannot express but the Job Summary (rendered as markdown/HTML) can.
  assert.match(summary, /<details>\s*<summary>◉ Model #1 ·/);
  assert.match(summary, /<details><summary>💭 Thinking<\/summary>[\s\S]*Checking tests[\s\S]*<\/details>/);
  assert.match(summary, /<details><summary>📝 Response<\/summary>[\s\S]*Found a fix[\s\S]*<\/details>/);
  assert.match(summary, /<details><summary>✓ bash · \$ pytest tests\/ · [\d.]+ (ms|s)<\/summary>/);
  assert.match(summary, /\*\*Result\*\*[\s\S]*2 passed/);
  assert.match(summary, /## Pi agent run · issue #51 · implementation\/main/);
  const opens = (summary.match(/<details>/g) ?? []).length;
  const closes = (summary.match(/<\/details>/g) ?? []).length;
  assert.equal(opens, closes);
  assert.ok(opens >= 4, `expected turn + thinking + response + tool nesting, got ${opens} <details> blocks`);
});

test("redacts secrets in the Job Summary and skips it when GITHUB_STEP_SUMMARY is unset", () => {
  const { summary } = renderWithSummary([
    { type: "tool_execution_start", toolName: "bash", toolCallId: "x", args: { command: "echo password=syntheticPassword123" } },
    { type: "tool_execution_end", toolName: "bash", toolCallId: "x", result: { content: [{ type: "text", text: "gh_token=syntheticToken123" }] } },
    { type: "agent_end", messages: [] },
  ]);
  assert.doesNotMatch(summary, /syntheticPassword123|syntheticToken123/);

  const output = render([{ type: "agent_end", messages: [] }]);
  assert.ok(output.length > 0);
});


test("emits issue=0 metrics for system agents without PI_ISSUE", () => {
  const output = render([
    { type: "turn_start" },
    { type: "message_end", message: { role: "assistant", content: [], usage: { input: 12, output: 3, totalTokens: 15 } } },
    { type: "agent_end", messages: [] },
  ], { PI_PHASE: "dispatcher", PI_CALL: "main", PI_ISSUE: "" });
  assert.match(output, /PI_METRIC \{"issue":0,"phase":"dispatcher","call":"main","response":1/);
});

test("waits until EOF to finalize totals across post-settle continuations", () => {
  const { stdout, summary } = renderWithSummary([
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_end", message: { role: "assistant", content: [], usage: { input: 10, output: 4, totalTokens: 14 } } },
    { type: "agent_end", messages: [] },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_end", message: { role: "assistant", content: [], usage: { input: 20, output: 6, totalTokens: 26 } } },
    { type: "agent_end", messages: [] },
  ], { PI_ISSUE: "97" });
  assert.equal((stdout.match(/Model totals \(2 responses\)/g) ?? []).length, 1);
  assert.match(stdout, /Agent completed/);
  assert.match(summary, /Responses:\*\* 2/);
  assert.equal((summary.match(/<summary>◉ Model #/g) ?? []).length, 2);
});

test("redacts generic token, secret and PEM private-key material", () => {
  const output = render([
    { type: "message_update", assistantMessageEvent: { type: "text_delta",
      delta: "token=syntheticToken\nsecret=syntheticSecret\n-----BEGIN PRIVATE KEY-----\nsyntheticPem\n-----END PRIVATE KEY-----\n" } },
    { type: "message_end", message: { role: "assistant", content: [] } },
  ]);
  assert.doesNotMatch(output, /syntheticToken|syntheticSecret|syntheticPem/);
  assert.match(output, /token=\[REDACTED\]/);
  assert.match(output, /secret=\[REDACTED\]/);
  assert.match(output, /\[REDACTED PRIVATE KEY\]/);
});


test("redacts secret-bearing environment variable names and add-mask payloads", () => {
  const output = render([
    { type: "message_update", assistantMessageEvent: { type: "text_delta",
      delta: "META_APP_SECRET=metaSynthetic\nTIKTOK_CLIENT_SECRET=tiktokSynthetic\nTOKEN_ENCRYPTION_KEY=fernetSynthetic\nDATABASE_PASSWORD=dbSynthetic\nMY_CREDENTIAL=credentialSynthetic\n::add-mask::maskSynthetic\n" } },
    { type: "message_end", message: { role: "assistant", content: [] } },
  ]);
  assert.doesNotMatch(output, /metaSynthetic|tiktokSynthetic|fernetSynthetic|dbSynthetic|credentialSynthetic|maskSynthetic/);
  assert.match(output, /META_APP_SECRET=\[REDACTED\]/);
  assert.match(output, /TIKTOK_CLIENT_SECRET=\[REDACTED\]/);
  assert.match(output, /TOKEN_ENCRYPTION_KEY=\[REDACTED\]/);
  assert.match(output, /DATABASE_PASSWORD=\[REDACTED\]/);
  assert.match(output, /MY_CREDENTIAL=\[REDACTED\]/);
  assert.match(output, /::add-mask::\[REDACTED\]/);
});

test("replays failed child-session usage from the metrics file into the job log", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-log-filter-metrics-"));
  const file = join(dir, "metrics.jsonl");
  const record = { issue: 115, phase: "implementation", descendant: true, call: "coding", childSession: "s1", response: 1, usage: { input: 5, output: 2, totalTokens: 7 } };
  writeFileSync(file, `${JSON.stringify(record)}\n${JSON.stringify({ call: "main", response: 1 })}\n`);
  const output = render([], { PI_METRICS_FILE: file });
  assert.ok(output.includes(`PI_METRIC ${JSON.stringify(record)}`));
  assert.equal((output.match(/"call":"main"/g) ?? []).length, 0);
});


test('#470 zero-usage tool-call-only provider response is not synthetic after a prior runtime failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-log-filter-tool-call-'));
  const failureFile = join(dir, 'runtime-failure.json');
  writeFileSync(failureFile, '{"failure_code":"PI_ACTION_REQUIRED_ABORT"}');
  try {
    const output = render([
      { type: 'turn_start' },
      { type: 'message_end', message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'submit_result', arguments: {} }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      } },
      { type: 'agent_end', messages: [] },
    ], { PI_ISSUE: '470', PI_CALL: 'main', PI_RUNTIME_FAILURE_FILE: failureFile });

    assert.doesNotMatch(output, /"synthetic":true/);
    assert.match(output, /PI_METRIC .*"totalTokens":0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('#470 byte-identical runtime failures each get their own synthetic settlement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-log-filter-failure-generation-'));
  const failureFile = join(dir, 'runtime-failure.json');
  const failure = '{"failure_code":"PI_ACTION_REQUIRED_ABORT"}';
  writeFileSync(failureFile, failure);
  const child = spawn(process.execPath, ['scripts/pi-log-filter.mjs'], {
    env: {
      ...process.env,
      GITHUB_ACTIONS: 'true',
      PI_ISSUE: '470',
      PI_CALL: 'main',
      PI_RUNTIME_FAILURE_FILE: failureFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  const send = event => child.stdin.write(JSON.stringify(event) + '\n');
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for pi-log-filter output: ' + stdout + stderr);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

  try {
    send({ type: 'turn_start' });
    send({ type: 'message_end', message: {
      role: 'assistant',
      content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    } });
    await waitFor(() => (stdout.match(/"synthetic":true/g) ?? []).length === 1);

    const replacement = failureFile + '.replacement';
    writeFileSync(replacement, failure);
    renameSync(replacement, failureFile);

    send({ type: 'turn_start' });
    send({ type: 'message_end', message: {
      role: 'assistant',
      content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    } });
    child.stdin.end();

    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exitCode, 0, stderr);
    assert.equal((stdout.match(/"synthetic":true/g) ?? []).length, 2, stdout);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('#470 a real empty provider response after a runtime failure is not synthetic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-log-filter-real-empty-'));
  const failureFile = join(dir, 'runtime-failure.json');
  writeFileSync(failureFile, '{"failure_code":"PI_ACTION_REQUIRED_ABORT"}');
  try {
    const output = render([
      { type: 'turn_start' },
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_end', message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'provider returned an empty error response',
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      } },
      { type: 'agent_end', messages: [] },
    ], { PI_ISSUE: '470', PI_CALL: 'main', PI_RUNTIME_FAILURE_FILE: failureFile });

    assert.doesNotMatch(output, /"synthetic":true/);
    assert.match(output, /PI_METRIC .*"totalTokens":0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('#469 abort settlement is explicitly synthetic without retyping ordinary zero usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-log-filter-settlement-'));
  const failureFile = join(dir, 'runtime-failure.json');
  writeFileSync(failureFile, '{"failure_code":"PI_UNAVAILABLE_CAPABILITY_ABORT"}');
  try {
    const synthetic = render([
      { type: 'turn_start' },
      { type: 'message_end', message: { role: 'assistant', content: [], usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      } } },
      { type: 'agent_end', messages: [] },
    ], { PI_ISSUE: '469', PI_CALL: 'repair', PI_RUNTIME_FAILURE_FILE: failureFile });
    assert.match(synthetic, /"synthetic":true,"record_type":"synthetic_settlement"/);

    const ordinary = render([
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }], usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      } } },
    ], { PI_ISSUE: '469', PI_CALL: 'repair' });
    assert.doesNotMatch(ordinary, /"synthetic":true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
