"""Focused coverage for ``social_mcp.diagnostics.smoke_retry_after``."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

from social_mcp.diagnostics.smoke_retry_after import parse_retry_after

UTC = timezone.utc


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("0", 0.0),
        ("1", 1.0),
        ("30", 30.0),
        ("  120  ", 120.0),
        ("+5", 5.0),
        (0, 0.0),
        (45, 45.0),
        (1.0, 1.0),
    ],
)
def test_delta_seconds(value, expected):
    reference = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)
    assert parse_retry_after(value, reference) == expected


def test_future_http_date():
    reference = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)
    assert parse_retry_after("Mon, 01 Jan 2024 12:01:30 GMT", reference) == 90.0


def test_future_http_date_with_numeric_offset():
    reference = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)
    assert parse_retry_after("Mon, 01 Jan 2024 12:02:00 +0000", reference) == 120.0


def test_past_http_date_clamps_to_zero():
    reference = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)
    assert parse_retry_after("Sun, 31 Dec 2023 23:59:00 GMT", reference) == 0.0


def test_exact_reference_clamps_to_zero():
    reference = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)
    assert parse_retry_after("Mon, 01 Jan 2024 12:00:00 GMT", reference) == 0.0


def test_naive_reference_is_treated_as_utc():
    naive = datetime(2024, 1, 1, 12, 0, 0)
    assert parse_retry_after("Mon, 01 Jan 2024 12:00:45 GMT", naive) == 45.0


def test_offset_reference_is_normalized():
    # 12:00+02:00 is 10:00 UTC, so the same UTC date is two hours away.
    reference = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone(timedelta(hours=2)))
    assert parse_retry_after("Mon, 01 Jan 2024 12:00:00 GMT", reference) == 7200.0


def test_reference_is_not_mutated():
    reference = datetime(2024, 1, 1, 12, 0, 0)
    parse_retry_after("Mon, 01 Jan 2024 12:00:45 GMT", reference)
    assert reference.tzinfo is None


def test_negative_zero_is_normalized():
    reference = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)
    result = parse_retry_after(-0.0, reference)
    assert result == 0.0
    assert math.copysign(1.0, result) == 1.0


@pytest.mark.parametrize(
    "value",
    ["-1", "-30", " -5", "-0.5", -1, -30],
)
def test_negative_values_rejected(value):
    reference = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)
    with pytest.raises(ValueError):
        parse_retry_after(value, reference)


@pytest.mark.parametrize(
    "value",
    [1.5, -0.5, float("nan"), float("inf"), float("-inf")],
)
def test_fractional_or_non_finite_numeric_values_rejected(value):
    reference = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)
    with pytest.raises(ValueError):
        parse_retry_after(value, reference)


@pytest.mark.parametrize(
    "value",
    [
        "",
        "   ",
        "soon",
        "1.5",
        "12.5",
        "1e3",
        "30 seconds",
        "Mon, 99 Xyz 2024 12:00:00 GMT",
        "01 Jan 2024",
        None,
        True,
        [],
        {},
        object(),
    ],
)
def test_unsupported_or_malformed_values_rejected(value):
    reference = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)
    with pytest.raises(ValueError):
        parse_retry_after(value, reference)
