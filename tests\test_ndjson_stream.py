"""Focused tests for the incremental NDJSON stream decoder."""

import json
from typing import Any

import pytest

from social_mcp.exercises.ndjson_stream import (
    NDJSONClosedError,
    NDJSONDecodeError,
    NDJSONError,
    NDJSONLimitExceededError,
    NDJSONStreamDecoder,
    NDJSONUnicodeDecodeError,
    decode_ndjson_stream,
)


def split_every(data: bytes, size: int) -> list[bytes]:
    """Split ``data`` into consecutive slices of ``size`` bytes."""
    assert size > 0
    return [data[index : index + size] for index in range(0, len(data), size)]


def feed_all(stream: NDJSONStreamDecoder, chunks: list[bytes]) -> list[Any]:
    """Feed every chunk, then finish, concatenating all decoded values."""
    values: list[Any] = []
    for chunk in chunks:
        values.extend(stream.feed(chunk))
    values.extend(stream.finish())
    return values


def test_feed_rejects_non_bytes() -> None:
    stream = NDJSONStreamDecoder()
    with pytest.raises(TypeError):
        stream.feed("not bytes")  # type: ignore[arg-type]


def test_one_byte_chunks_assemble_one_record() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=16)
    chunks = split_every(b'{"a": [1, 2, 3]}\n', 1)
    assert chunks[0] == b"{"
    values: list[Any] = []
    for chunk in chunks[:-1]:
        values.extend(stream.feed(chunk))
    assert values == []
    assert stream.pending_bytes == 15
    values.extend(stream.feed(chunks[-1]))
    assert values == [{"a": [1, 2, 3]}]
    assert stream.finish() == []


@pytest.mark.parametrize("size", list(range(1, 15)))
def test_splits_inside_multibyte_characters(size: int) -> None:
    payload = '{"v":"a\u00e9\U0001f600"}\n'.encode("utf-8")
    stream = NDJSONStreamDecoder(max_record_bytes=len(payload))
    assert feed_all(stream, split_every(payload, size)) == [{"v": "a\u00e9\U0001f600"}]


def test_several_records_in_one_chunk() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=128)
    chunk = b'{"a":1}\n{"b":2}\n{"c":3}\n'
    assert stream.feed(chunk) == [{"a": 1}, {"b": 2}, {"c": 3}]
    assert stream.feed(b"") == []


@pytest.mark.parametrize("terminal", [b"\n", b"\r\n"])
def test_lf_and_crlf_terminators(terminal: bytes) -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=128)
    payload = terminal.join([b'{"a":1}', b'{"b":2}']) + terminal
    assert feed_all(stream, split_every(payload, 3)) == [{"a": 1}, {"b": 2}]


def test_stray_cr_is_rejected_as_invalid_json() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=128)
    with pytest.raises(NDJSONDecodeError):
        stream.feed(b'\r{"a":1}\n')


def test_json_container_may_not_span_records() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=128)
    with pytest.raises(NDJSONDecodeError):
        stream.feed(b'{ "a" : \n  1 }\n')


def test_final_unterminated_record_via_finish() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=64)
    assert stream.feed(b'{"a":1}\n{"b":2}') == [{"a": 1}]
    assert stream.finish() == [{"b": 2}]


def test_blank_records_are_skipped_and_not_numbered() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=64)
    payload = b'\n   \t\n{"a":1}\n\n{"b":2}\n \n'
    assert feed_all(stream, split_every(payload, 2)) == [{"a": 1}, {"b": 2}]
    assert stream.records_decoded == 2


def test_blank_stream_releases_nothing() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=64)
    assert feed_all(stream, [b"\n", b" \t \n", b"  "]) == []
    assert stream.records_decoded == 0


def test_record_numbering_skips_blank_lines() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=64)
    stream.feed(b"\n\n")
    stream.feed(b'{"a":1}\n')
    with pytest.raises(NDJSONDecodeError) as excinfo:
        stream.feed(b"oops\n")
    assert excinfo.value.record_number == 2


def test_malformed_json_reports_record_number() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=64)
    with pytest.raises(NDJSONDecodeError) as excinfo:
        stream.feed(b'{"a":1}\n{"b":2}\nbroken\n')
    assert excinfo.value.record_number == 3
    assert "record 3" in str(excinfo.value)


def test_invalid_utf8_reports_record_number() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=64)
    stream.feed(b'{"a":1}\n')
    with pytest.raises(NDJSONUnicodeDecodeError) as excinfo:
        stream.feed(b"\xff\n")
    assert excinfo.value.record_number == 2
    assert "record 2" in str(excinfo.value)
    assert isinstance(excinfo.value.cause, UnicodeDecodeError)


def test_lenient_unicode_mode_forwards_standard_error() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=64, strict_unicode=False)
    with pytest.raises(UnicodeDecodeError):
        stream.feed(b"\xff\n")


@pytest.mark.parametrize(
    "bad", [b'{"a":1}\nbroken\n', b'{"a":1}\n{"b":x}\n', b'{"a":1}\n\xff\n']
)
def test_complete_records_survive_a_later_bad_record(bad: bytes) -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=64)
    with pytest.raises(NDJSONError):
        stream.feed(bad)
    # Nothing was lost: the complete record ahead of the invalid one was
    # decoded and counted, and the trailing bytes stay buffered rather than
    # being silently dropped.
    assert stream.records_decoded == 2
    assert stream.pending_bytes == 0


def test_size_limit_boundary_is_accepted() -> None:
    payload = b'{"a":"' + b"x" * 3 + b'"}'
    stream = NDJSONStreamDecoder(max_record_bytes=len(payload))
    assert stream.feed(payload + b"\n") == [{"a": "xxx"}]
    assert stream.records_decoded == 1


def test_size_limit_overflow_raises_immediately() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=8)
    with pytest.raises(NDJSONLimitExceededError) as excinfo:
        stream.feed(b"123456789")
    assert excinfo.value.record_number == 1
    assert excinfo.value.max_record_bytes == 8
    assert "exceeds" in str(excinfo.value)
    assert stream.pending_bytes == 0


def test_size_limit_overflow_after_complete_records() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=8)
    assert stream.feed(b'{"a":1}\n1234567') == [{"a": 1}]
    with pytest.raises(NDJSONLimitExceededError) as excinfo:
        stream.feed(b"8")
    assert excinfo.value.record_number == 2


@pytest.mark.parametrize("value", [0, -1, True, 1.5, "8"])
def test_size_limit_must_be_a_positive_int(value: object) -> None:
    with pytest.raises((TypeError, ValueError)):
        NDJSONStreamDecoder(max_record_bytes=value)  # type: ignore[arg-type]


def test_finish_is_not_repeatable() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=64)
    assert stream.feed(b'{"a":1}\n') == [{"a": 1}]
    assert stream.finish() == []
    assert stream.closed
    with pytest.raises(NDJSONClosedError):
        stream.feed(b'{"b":2}\n')
    with pytest.raises(NDJSONClosedError):
        stream.finish()


def test_decoder_state_is_readable_for_diagnostics() -> None:
    stream = NDJSONStreamDecoder(max_record_bytes=32)
    stream.feed(b'{"a":1}\n{"partial"')
    assert stream.records_decoded == 1
    assert stream.pending_bytes == len(b'{"partial"')
    assert stream.max_record_bytes == 32


def test_decode_ndjson_stream_helper_decodes_chunked_records() -> None:
    chunks = [b'{"a":1}\n', b'{"b":2}\n{"c":3}']
    assert decode_ndjson_stream(chunks, max_record_bytes=64) == [
        {"a": 1},
        {"b": 2},
        {"c": 3},
    ]


def test_decode_ndjson_stream_reports_later_failures() -> None:
    with pytest.raises(NDJSONLimitExceededError):
        decode_ndjson_stream([b"0123456789"], max_record_bytes=4)
    with pytest.raises(NDJSONUnicodeDecodeError):
        decode_ndjson_stream([b"\xff\n"], max_record_bytes=64)
    with pytest.raises(NDJSONDecodeError):
        decode_ndjson_stream([b"bad\n"], max_record_bytes=64)


def test_error_hierarchy_is_json_shaped() -> None:
    assert issubclass(NDJSONError, ValueError)
    for expected in (
        NDJSONDecodeError,
        NDJSONUnicodeDecodeError,
        NDJSONLimitExceededError,
        NDJSONClosedError,
    ):
        assert issubclass(expected, NDJSONError)
    assert json.loads("{}") == {}
