# Tool-call boundary probe

- Run: 2026-10-09T10:27:14.987Z
- Suite: quick; requests: 8
- Constraint activation: **unverified** (successful strict calls do not establish constrained decoding).
- Model IDs: direct []; proxy ["Qwen3.8-Flash-Next-NVFP4"]; common []. Comparable IDs: none; do not compare direct and proxy as the same model.
- vLLM parser, reasoning parser, chat template overrides, automatic tool choice and guided decoding: direct: Read-only endpoints only; parser/template/guided-decoding configuration is unverified unless exposed by server. proxy: Read-only endpoints only; parser/template/guided-decoding configuration is unverified unless exposed by server.

## Summary

- Valid tool calls: 1/8 (12.5%)
- Missing path/content/resultText: 0/0/0
- Malformed JSON without transport interruption: 0; incomplete arguments on transport errors: 1; reasoning-only: 1; ordinary-text-only: 0; required violations: 0; strict errors: 0; transport errors: 7
- tool_calls with invalid args: 0; stop with a tool call: 0; missing [DONE]: 2
- Categories: {"MODEL_OR_BACKEND":0,"PROXY":3,"PI_PARSING":0,"OUTPUT_TRUNCATION":0,"SCHEMA_ERROR":0,"SERVER_ERROR":0,"UNKNOWN":5}
- Latency mean/p95: 6131.4 / 15011 ms

## Direct/proxy, streaming and budget comparisons

Endpoint | requests | valid calls | valid % | malformed JSON | required violations
---|---:|---:|---:|---:|---:
direct | 4 | 0 | 0.0% | 0 | 0
proxy | 4 | 1 | 25.0% | 1 | 0

Streaming | requests | valid calls | valid % | malformed JSON | required violations
---|---:|---:|---:|---:|---:
stream | 4 | 0 | 0.0% | 1 | 0
non-stream | 4 | 1 | 25.0% | 0 | 0

Budget | requests | valid calls | valid % | malformed JSON | required violations
---|---:|---:|---:|---:|---:
2048 | 6 | 1 | 16.7% | 0 | 0
16384 | 2 | 0 | 0.0% | 1 | 0

The table uses only this run's observed cases. Payload and strict differences are represented in the request table below. Thinking-off cases are labeled in each combination; unsupported template kwargs may be ignored by an endpoint.

## Requests

ID | endpoint | combination | classification | validation | raw
---|---|---|---|---|---
direct-case1-r1 | direct | write/required/strict/stream/small/2048/default | UNKNOWN | no tool call | [raw](raw-responses/direct-case1-r1.bin)
direct-case2-r1 | direct | write/required/strict/non-stream/large/2048/default | UNKNOWN | no tool call | [raw](raw-responses/direct-case2-r1.bin)
direct-case3-r1 | direct | write/required/strict/stream/large/16384/default | UNKNOWN | no tool call | [raw](raw-responses/direct-case3-r1.bin)
direct-case4-r1 | direct | submit_result/required/strict/non-stream/result/2048/default | UNKNOWN | no tool call | [raw](raw-responses/direct-case4-r1.bin)
proxy-case1-r1 | proxy | write/required/strict/stream/small/2048/default | PROXY | no tool call | [raw](raw-responses/proxy-case1-r1.bin)
proxy-case2-r1 | proxy | write/required/strict/non-stream/large/2048/default | PROXY | no tool call | [raw](raw-responses/proxy-case2-r1.bin)
proxy-case3-r1 | proxy | write/required/strict/stream/large/16384/default | PROXY | malformed_json | [raw](raw-responses/proxy-case3-r1.bin)
proxy-case4-r1 | proxy | submit_result/required/strict/non-stream/result/2048/default | UNKNOWN | valid | [raw](raw-responses/proxy-case4-r1.bin)

## Boundary interpretation

A direct/proxy difference with the same model ID localizes a change to the proxy path only when request bodies and server identities are comparable. This probe cannot distinguish model sampling from vLLM parser behavior without raw vLLM-side evidence; it records raw HTTP responses at each exposed boundary. The PI_PARSING category is reserved for actual optional replay evidence and is not inferred by this run. RAW_PROVIDER_ARGUMENTS is preserved; PI_PARSED_ARGUMENTS is explicitly unavailable without the real parser, and VALIDATION_RESULT is the independent syntax/schema check. Review each raw response and parsed artifact. Incomplete arguments below the token ceiling are not automatically labeled truncation.
