# Tool-call boundary A/B probe — partial run

**PARTIAL_STOPPED: 96/100 attempts; 95 raw response artifacts; 4 requests unattempted.** The 16384 token non-streaming case repeatedly exceeded the 600000 ms client deadline or failed before HTTP headers. Read-only health and model discovery remained responsive, but repeated long inference failures made continuing that case unwise. The active request was interrupted after its request JSON was saved; its in-flight SSE bytes were buffered in memory and could not be persisted. No generated tool was executed.

## Comparability

Same model, same request body, and same client were verified before the run. Both endpoints advertised Qwen3.8-Flash-Next-NVFP4. Host: MacBookPro.lan. Direct: http://192.168.8.210:3009/v1; proxy: http://192.168.8.184:4001/v1. Timeout: 600000 ms, explicit CLI; request aborts came from the probe AbortSignal or recorded fetch transport errors.

## Counts

- HTTP 2xx headers: 90/96; completed HTTP bodies: 89/96; valid tool calls: 69/96.
- Proxy: 34/48 valid; 45 HTTP 2xx headers, 44 completed bodies; 1 client deadlines; 4 transport errors.
- Direct: 35/48 valid; 45 HTTP 2xx headers, 45 completed bodies; 1 client deadlines; 3 transport errors.
- Complete matched pairs: 48; proxy-only valid 0; direct-only valid 1; both valid 34; neither valid 13. No route reliability verdict from this incomplete campaign.
- Failure categories: {"MODEL_OR_BACKEND":10,"PROXY":0,"PI_PARSING":0,"OUTPUT_TRUNCATION":10,"SCHEMA_ERROR":0,"SERVER_ERROR":0,"TRANSPORT_ERROR":7,"UNKNOWN":69}.
- Root-cause status: {"writePath":"NOT_REPRODUCED","submitResultFiles":"VALID_OR_NOT_REPRODUCED","toolChoiceRequired":"NO_VIOLATION_OBSERVED","finishReason":"LENGTH_OBSERVED"}. Missing write.path and submit_result.files problems were not reproduced; required tool-choice violations and finish_reason=length were observed where classified.
- Endpoint latency p50/p95: direct 11511.124389648438/414864.4675292969 ms; proxy 11720/412422.7341308594 ms. Initial batch uses approximate request/raw timestamp deltas; follow-up uses measured client timings. Treat latency comparisons as indicative only. TTFT p50/p95 direct 611/705 ms; proxy 630/808 ms.
- Post-failure health checks: proxy /health and both /v1/models returned HTTP 200.

## Paired scenario outcomes

Scenario | pairs attempted / target | direct valid | proxy valid | both | direct only | proxy only | neither | transport errors | output ceilings
---|---:|---:|---:|---:|---:|---:|---:|---:|---:
1 | 5/5 | 5 | 5 | 5 | 0 | 0 | 0 | 0 | 0
2 | 5/5 | 5 | 5 | 5 | 0 | 0 | 0 | 0 | 0
3 | 5/5 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 0
4 | 5/5 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 10
5 | 5/5 | 5 | 4 | 4 | 1 | 0 | 0 | 1 | 0
6 | 3/5 | 0 | 0 | 0 | 0 | 0 | 3 | 6 | 0
7 | 5/5 | 5 | 5 | 5 | 0 | 0 | 0 | 0 | 0
8 | 5/5 | 5 | 5 | 5 | 0 | 0 | 0 | 0 | 0
9 | 5/5 | 5 | 5 | 5 | 0 | 0 | 0 | 0 | 0
10 | 5/5 | 5 | 5 | 5 | 0 | 0 | 0 | 0 | 0

Five pairs per scenario were intended. Scenario 6 stopped after three pairs when 16384 token non-streaming calls repeatedly failed; four requests were not issued.

## Earlier 15 second timeout

The earlier report records a 15011 ms p95 and a fetch abort, but its manifest omits the timeout option and the direct endpoint was unreachable. Evidence cannot distinguish an explicit CLI timeout from an outer deadline. The abort message indicates a client-side abort; no HTTP response supports an upstream timeout. Exact source is unknown.

## Usage and latency

- Completion token usage samples: direct 25 (mean 594.4); proxy 25 (mean 595.0). Reasoning token means: direct 125.2 over 15 samples; proxy 125.2 over 15 samples. SSE [DONE] rates: direct 100.0% (20/20); proxy 95.0% (19/20).

## Evidence

Exact request JSON is in requests/, raw response bytes in raw-responses/, parsed deltas and independent validation in parsed-responses/, and SHA-256 mappings in checksums.txt. paired-comparison.csv/jsonl retain matched attempts and failures. One interrupted attempt has a request but no raw response artifact. Pi parsing and pre-parser XML were not observed; strict:true does not establish constrained decoding. The findings cannot distinguish proxy effects from backend/model behavior.
