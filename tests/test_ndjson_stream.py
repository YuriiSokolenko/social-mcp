"""Determinism probe 23: exercise the module loaded under its package name."""

import social_mcp.exercises.ndjson_stream as mod


def test_probe_probe_line() -> None:
    stream = mod.NDJSONStreamDecoder(max_record_bytes=64)
    stream.feed(b'{"x"')
    try:
        values = stream.feed(b":1}\n")
    except Exception as exc:  # noqa: BLE001 - diagnostic
        raise AssertionError(f"raised {type(exc).__name__}: {exc}") from None
    raise AssertionError(f"values={values!r}")
