# TensorFold model-status sample (N150 upstream, 2026-10-10T01:16:31Z)

Evidence for #717. Captured read-only from `http://192.168.8.210:3009` (the
`MODEL_STATUS_URL` upstream behind the N150 `4001` proxy). The server returned
no credentials, and no headers other than `Server`/`Date`/`Content-*` were sent.
The server was idle at capture time. `/version` returns 404, so the TensorFold
version is not exposed; re-capture this file after a server upgrade.

## Gauges read by `manager.sh`

The `HELP` text is the server's own definition:

```text
# HELP tensorfold:requests_running Requests in prefill or decode.
# TYPE tensorfold:requests_running gauge
tensorfold:requests_running 0
# HELP tensorfold:requests_waiting Requests queued or held until a lane is free.
# TYPE tensorfold:requests_waiting gauge
tensorfold:requests_waiting 0
# HELP tensorfold:num_requests_running Requests in prefill or decode. A mirror of tensorfold:requests_running.
# TYPE tensorfold:num_requests_running gauge
tensorfold:num_requests_running 0
# HELP tensorfold:num_requests_waiting Requests queued or held until a lane is free. A mirror of tensorfold:requests_waiting.
# TYPE tensorfold:num_requests_waiting gauge
tensorfold:num_requests_waiting 0
```

- `tensorfold:num_requests_running`: requests in prefill or decode. The server
  documents it as "a mirror of tensorfold:requests_running".
- `tensorfold:num_requests_waiting`: requests queued or held until a lane is
  free. The server documents it as "a mirror of tensorfold:requests_waiting".
- The manager reads only the `num_requests_*` mirrors (the vLLM-compatible
  names), so the `requests_*` originals are never double counted. Both
  mirrors must be present, otherwise the sample is invalid and admission is
  deferred.

## `/health`

```json
{"ok": true, "backend": "tensorfold", "busy": false, "requests_running": 0, "requests_total": 13, "prompt_tokens_total": 3514, "completion_tokens_total": 711, "prefill_seconds_total": 3.7519, "decode_seconds_total": 21.5914, "cached_tokens_total": 1332, "rounds_total": 197, "drafted_total": 675, "accepted_total": 501, "streams": {"decoding": 0, "prefilling": 0, "max": 3}, "context_length": 262144}
```

`streams.max` (3) is the number of concurrent inference streams on the model
server. It is not a Pi job limit: a Pi job holds a runner reservation across
many short model calls. Job admission stays governed by `MODEL_MAX_CONCURRENCY`
and `MAX_RUNNERS` (8/8 on N150). The manager does not read `/health`.

## `/v1/models`

```json
{"object": "list", "data": [{"id": "swift-1.5-qwen3.8-flash-next", "object": "model", "owned_by": "tensorfold"}]}
```

## All metric families exported (names only)

`tensorfold:e`, `tensorfold:generation_tokens_total`, `tensorfold:kv_cache_usage_perc`, `tensorfold:kv_cache_usage_ratio`, `tensorfold:mtp_accepted_total`, `tensorfold:mtp_drafted_total`, `tensorfold:num_requests_running`, `tensorfold:num_requests_waiting`, `tensorfold:prompt_tokens_total`, `tensorfold:request_decode_seconds_bucket`, `tensorfold:request_decode_seconds_count`, `tensorfold:request_decode_seconds_sum`, `tensorfold:request_latency_seconds_bucket`, `tensorfold:request_latency_seconds_count`, `tensorfold:request_latency_seconds_sum`, `tensorfold:requests_running`, `tensorfold:requests_waiting`, `tensorfold:spec_decode_num_accepted_tokens_total`, `tensorfold:spec_decode_num_draft_tokens_total`, `tensorfold:time_to_first_token_seconds_bucket`, `tensorfold:time_to_first_token_seconds_count`, `tensorfold:time_to_first_token_seconds_sum`
