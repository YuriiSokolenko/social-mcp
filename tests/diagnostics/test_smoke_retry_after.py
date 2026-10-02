"""Focused coverage for the smoke Retry-After parser."""

from datetime import datetime, timedelta, timezone

import pytest

from social_mcp.diagnostics.smoke_retry_after import parse_retry_after

UTC = timezone.utc
REFERENCE = datetime(1994, 11, 6, 8, 49, 0, tzinfo=UTC)


def test_delta_seconds_integer_is_returned_unchanged() -> None:
    assert parse_retry_after(120, REFERENCE) == 120


def test_zero_delta_seconds_is_valid() -> None:
    assert parse_retry_after("0", REFERENCE) == 0


def test_delta_seconds_string_is_parsed_as_integer() -> None:
    assert parse_retry_after("42", REFERENCE) == 42


def test_delta_seconds_string_ignores_surrounding_whitespace() -> None:
    assert parse_retry_after("  17  ", REFERENCE) == 17


def test_large_delta_seconds_is_not_capped() -> None:
    assert parse_retry_after("86400", REFERENCE) == 86400


def test_negative_delta_seconds_integer_raises() -> None:
    with pytest.raises(ValueError):
        parse_retry_after(-1, REFERENCE)


def test_negative_delta_seconds_string_raises() -> None:
    with pytest.raises(ValueError):
        parse_retry_after("-5", REFERENCE)


def test_future_http_date_uses_supplied_reference() -> None:
    assert parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", REFERENCE) == 37


def test_future_http_date_rounds_up_fractional_seconds() -> None:
    reference = REFERENCE + timedelta(microseconds=500_000)
    assert parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", reference) == 37


def test_past_http_date_is_clamped_to_zero() -> None:
    assert parse_retry_after("Sun, 06 Nov 1994 08:48:00 GMT", REFERENCE) == 0


def test_http_date_equal_to_reference_is_clamped_to_zero() -> None:
    reference = datetime(1994, 11, 6, 8, 49, 37, tzinfo=UTC)
    assert parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", reference) == 0


def test_http_date_offset_is_respected_against_utc_reference() -> None:
    # 08:49:37 -0500 is 13:49:37 UTC: five hours and 37 seconds after reference.
    assert parse_retry_after("Sun, 06 Nov 1994 08:49:37 -0500", REFERENCE) == 18037


def test_naive_reference_datetime_is_treated_as_utc() -> None:
    naive_reference = datetime(1994, 11, 6, 8, 49, 0)
    assert parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", naive_reference) == 37


def test_http_date_without_timezone_is_treated_as_utc() -> None:
    assert parse_retry_after("Sun, 06 Nov 1994 09:49:00", REFERENCE) == 3600


def test_date_parser_does_not_read_the_clock() -> None:
    assert parse_retry_after("Mon, 07 Nov 1994 08:49:00 GMT", REFERENCE) == 86400


@pytest.mark.parametrize("value", ["", "   ", "5 seconds", "5.5", "1h", "0x10"])
def test_malformed_values_raise(value: str) -> None:
    with pytest.raises(ValueError):
        parse_retry_after(value, REFERENCE)


@pytest.mark.parametrize(
    "value", ["Sun, 06 Nov 1994 25:61:61 GMT", "not a date", "1994-11-06T8:49"]
)
def test_malformed_http_dates_raise(value: str) -> None:
    with pytest.raises(ValueError):
        parse_retry_after(value, REFERENCE)


@pytest.mark.parametrize("value", [None, 1.5, True, False, ["30"], object()])
def test_unsupported_value_types_raise(value: object) -> None:
    with pytest.raises(ValueError):
        parse_retry_after(value, REFERENCE)


@pytest.mark.parametrize("reference", [None, "1994-11-06", 0, timedelta(seconds=1)])
def test_reference_must_be_a_datetime(reference: object) -> None:
    with pytest.raises(ValueError):
        parse_retry_after("30", reference)


def test_reference_is_required() -> None:
    with pytest.raises(TypeError):
        parse_retry_after("30")  # type: ignore[call-arg]
