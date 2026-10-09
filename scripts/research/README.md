# Tool-call boundary probe

Standalone Node.js 22+ probe for local OpenAI-compatible Chat Completions endpoints. It sends only synthetic prompts and records responses without executing tool calls or generated code. There are no npm dependencies.

From the repository root:

```bash
node scripts/research/tool-call-boundary-probe.mjs \
  --direct-url http://192.168.8.210:3009/v1 \
  --proxy-url http://192.168.8.184:4001/v1 \
  --suite quick
```

Run `--dry-run` first to print the manifest and request count without contacting either endpoint. The quick suite is 8 requests (4 cases x 2 endpoints). The full suite defaults to five repetitions: 10 scenarios, 50 attempts per endpoint, 100 total. Every matched pair uses the same body and randomizes which endpoint goes first.

```bash
node scripts/research/tool-call-boundary-probe.mjs \
  --direct-url http://192.168.8.210:3009/v1 \
  --proxy-url http://192.168.8.184:4001/v1 \
  --suite full --repeat 5 --timeout-ms 600000 --max-requests 100
```

Target one combination and repeat it as needed:

```bash
node scripts/research/tool-call-boundary-probe.mjs \
  --direct-url http://192.168.8.210:3009/v1 \
  --proxy-url http://192.168.8.184:4001/v1 \
  --suite targeted --tool write --tool-choice required --strict true \
  --stream true --payload large --budget 2048 --repeat 20
```

Supported flags: `--direct-url`, `--proxy-url`, `--suite quick|full|followup|targeted`, `--tool write|submit_result`, `--tool-choice auto|required|named`, `--strict true|false`, `--stream true|false`, `--payload small|large|result`, `--budget 2048|16384`, `--reasoning default|thinking-off`, `--probe-reasoning`, `--direct-model`, `--proxy-model`, `--seed`, `--repeat`, `--max-requests`, `--timeout-ms` (default 600000), `--concurrency` (default 1), `--output-dir`, and `--dry-run`. The followup suite runs scenarios 7–10 as 40 requests when a full run stops during the long cases. A supplied `--seed` is sent to both endpoints; omit it if unsupported. `thinking-off` adds `chat_template_kwargs.enable_thinking=false`; this is a separate experiment and might be ignored by an endpoint. Model names are discovered from `/v1/models`; comparison ends with `NOT_COMPARABLE` unless the pinned model identity is verified on both routes.

Endpoints must be explicit local/private HTTP URLs and cannot contain credentials. The script does not read credential environment variables or send Authorization headers. It makes read-only GETs to `/v1/models`, `/version`, and `/openapi.json`, then posts synthetic requests to `/v1/chat/completions`. It never calls a generated tool.

Each run writes `manifest.json`, `environment.json`, one complete request JSON per request, losslessly compressed response bytes under `raw-responses/*.bin.gz`, decoded parse details under `parsed-responses/*.json.gz`, `results.jsonl`, paired comparison CSV/JSONL, `checksums.txt`, `summary.json`, and `report.md` beneath `reports/tool-call-boundary-probe/<timestamp>/` (or `--output-dir`). Checksums record both the uncompressed response bytes and gzip artifact. Raw bytes are authoritative if decoded output differs. For streaming, the parser carries arbitrary chunk boundaries and preserves the original concatenated function argument strings; malformed JSON is never repaired to `{}`. Schema errors are reported separately from JSON syntax errors. A budget is only classified as reached when the provider reports `finish_reason=length` or usage reaches the requested ceiling; a client interruption is never labeled output truncation.

`constraint_activation` remains `unverified`: a successful `strict:true` call is not proof that grammar decoding was active. The probe records endpoint model IDs, version and OpenAPI responses when exposed. Parser/template/guided-decoding settings require server-side read-only configuration or logs; they are not guessed from successful output.

The earlier Beelink quick report recorded 15,011 ms p95 and a fetch abort, but its manifest omitted the timeout option and the direct endpoint was unreachable. Its 15 second limit is therefore not attributable from the saved evidence: an explicit CLI timeout is consistent with the AbortSignal error, while an external deadline cannot be ruled out; there is no HTTP response showing an upstream timeout. The current probe records the selected timeout and abort source per attempt. Do not interpret those earlier partial streams as model output truncation.

## Pi boundary

The repository pins `@earendil-works/pi-coding-agent` 1.1.0 and `pi-subagents` 0.76.1 in `infra/github-runner-autoscaler/worker.Dockerfile`. `scripts/pi-agent-runtime.mjs` applies request policy before the Pi provider sends requests; the stage runner inserts `scripts/pi-common/model-trace-proxy.mjs` as a local forwarding/telemetry boundary. That proxy inspects and forwards request/response bytes, but trace output serializes parsed/redacted bodies and is not authoritative raw-byte evidence. Its `hasUsableModelResponse` helper also treats a finish reason as a usable response signal; that signal does not validate tool arguments or change them. This probe therefore labels provider arguments `RAW_PROVIDER_ARGUMENTS` in parsed results, and its independent JSON/schema check is not represented as `PI_PARSED_ARGUMENTS`.

No Pi runtime package is installed in this repository checkout, and invoking Pi to replay a transcript would load session/extensions and risk tool dispatch. To obtain the actual representation safely, instrument the pinned Pi OpenAI-compatible provider adapter at the point after `function.arguments` is assembled and before tool invocation. Feed a fixture response through that adapter with a stub tool registry whose execute methods fail if called; capture (1) raw provider string, (2) Pi's parsed `ToolCall.arguments`, and (3) Pi validation error/result. Keep this replay isolated from a normal Pi session. Until that instrumentation is available, Pi parsing is unmeasured and the report does not assign a Pi cause.

## Tests

```bash
node --test tests/tool-call-boundary-probe.test.mjs
node scripts/research/tool-call-boundary-probe.mjs --suite quick --dry-run
node scripts/research/tool-call-boundary-probe.mjs --suite targeted --tool write --tool-choice required --strict true --stream true --payload large --budget 2048 --repeat 20 --dry-run
```

The test fixtures cover arbitrary SSE fragmentation, multiple calls indexed by choice and tool, malformed JSON and missing braces, absent required fields, empty deltas, unexpected finish reasons, and unknown tool names. They make no network requests.
