"""Focused coverage for the deterministic backoff hint parser."""

from datetime import datetime, timedelta, timezone

import pytest

from social_mcp.diagnostics.smoke_backoff_hint import parse_backoff_hint

REFERENCE = datetime(2024, 5, 1, 12, 0, 0, tzinfo=timezone.utc)


def test_integer_delta_seconds() -> None:
    assert parse_backoff_hint(30, REFERENCE) == 30


def test_integer_zero_boundary() -> None:
    assert parse_backoff_hint(0, REFERENCE) == 0


def test_string_delta_seconds() -> None:
    assert parse_backoff_hint("45", REFERENCE) == 45


def test_string_delta_seconds_ignores_whitespace() -> None:
    assert parse_backoff_hint("  7\t", REFERENCE) == 7


def test_string_zero_boundary() -> None:
    assert parse_backoff_hint("0", REFERENCE) == 0


def test_future_date_returns_remaining_seconds() -> None:
    assert parse_backoff_hint("Wed, 01 May 2024 12:00:30 GMT", REFERENCE) == 30


def test_future_date_whole_day() -> None:
    assert parse_backoff_hint("Thu, 02 May 2024 12:00:00 GMT", REFERENCE) == 86400


def test_future_date_rounds_fraction_up() -> None:
    reference = REFERENCE.replace(microsecond=500000)
    assert parse_backoff_hint("Wed, 01 May 2024 12:00:01 GMT", reference) == 1


def test_past_date_clamps_to_zero() -> None:
    assert parse_backoff_hint("Wed, 01 May 2024 11:59:00 GMT", REFERENCE) == 0


def test_distant_past_date_clamps_to_zero() -> None:
    assert parse_backoff_hint("Mon, 01 Jan 2024 00:00:00 GMT", REFERENCE) == 0


def test_equal_date_is_zero() -> None:
    assert parse_backoff_hint("Wed, 01 May 2024 12:00:00 GMT", REFERENCE) == 0


def test_naive_date_is_interpreted_as_utc() -> None:
    assert parse_backoff_hint("Wed, 01 May 2024 12:00:15", REFERENCE) == 15


def test_offset_date_is_converted_to_utc() -> None:
    # 14:00 +0200 is the same instant as 12:00 UTC.
    assert parse_backoff_hint("Wed, 01 May 2024 14:00:00 +0200", REFERENCE) == 0


def test_offset_date_still_counts_as_future() -> None:
    assert parse_backoff_hint("Wed, 01 May 2024 12:02:00 +0000", REFERENCE) == 120


def test_naive_reference_is_interpreted_as_utc() -> None:
    naive = REFERENCE.replace(tzinfo=None)
    assert parse_backoff_hint("Wed, 01 May 2024 12:00:30 GMT", naive) == 30


def test_reference_with_non_utc_offset_is_respected() -> None:
    reference = datetime(2024, 5, 1, 20, 0, 0, tzinfo=timezone(timedelta(hours=8)))
    assert parse_backoff_hint("Wed, 01 May 2024 12:00:30 GMT", reference) == 30


@pytest.mark.parametrize("value", [-1, -30, "-1", "-45", " -5 "])
def test_rejects_negative_delta_seconds(value: object) -> None:
    with pytest.raises(ValueError):
        parse_backoff_hint(value, REFERENCE)


@pytest.mark.parametrize(
    "value",
    [
        "not-a-date",
        "Wed, 32 May 2024 12:00:00 GMT",
        "2024-05-01T12:00:00Z",
        "Wed, 01 May 2024",
        "1.5",
        "1e3",
        "30 seconds",
        "12:00:00",
        "",
        "   ",
        "\n",
    ],
)
def test_rejects_malformed_values(value: object) -> None:
    with pytest.raises(ValueError):
        parse_backoff_hint(value, REFERENCE)


@pytest.mark.parametrize("value", [None, True, False, 1.5, b"30", ["30"], {}])
def test_rejects_unsupported_types(value: object) -> None:
    with pytest.raises(ValueError):
        parse_backoff_hint(value, REFERENCE)


@pytest.mark.parametrize("reference", [None, "2024-05-01", 0, 1.5])
def test_rejects_non_datetime_reference(reference: object) -> None:
    with pytest.raises(ValueError):
        parse_backoff_hint(30, reference)  # type: ignore[arg-type]


def test_reference_is_required() -> None:
    with pytest.raises(TypeError):
        parse_backoff_hint("Wed, 01 May 2024 12:00:30 GMT")  # type: ignore[call-arg]
