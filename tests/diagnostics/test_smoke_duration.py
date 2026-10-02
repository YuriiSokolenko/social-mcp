"""Focused coverage for the smoke duration parser."""

import pytest

from social_mcp.diagnostics.smoke_duration import parse_duration_seconds


def test_parse_duration_milliseconds() -> None:
    assert parse_duration_seconds("250ms") == 0.25


def test_parse_duration_seconds_unit() -> None:
    assert parse_duration_seconds("45s") == 45.0


def test_parse_duration_minutes() -> None:
    assert parse_duration_seconds("2m") == 120.0


def test_parse_duration_hours() -> None:
    assert parse_duration_seconds("3h") == 10800.0


def test_parse_duration_decimal_seconds() -> None:
    assert parse_duration_seconds("1.5s") == 1.5


def test_parse_duration_decimal_smaller_unit() -> None:
    assert parse_duration_seconds("0.5ms") == 0.0005


def test_parse_duration_leading_fraction() -> None:
    assert parse_duration_seconds(".5s") == 0.5


def test_parse_duration_returns_float() -> None:
    assert isinstance(parse_duration_seconds("2s"), float)


def test_parse_duration_ignores_surrounding_whitespace() -> None:
    assert parse_duration_seconds("  2m\t") == 120.0


def test_parse_duration_ignores_whitespace_before_unit() -> None:
    assert parse_duration_seconds("1.5 s") == 1.5


def test_parse_duration_ignores_whitespace_on_both_sides() -> None:
    assert parse_duration_seconds(" 1h ") == 3600.0


def test_parse_duration_zero_boundary_is_zero_seconds() -> None:
    assert parse_duration_seconds("0s") == 0.0


def test_parse_duration_smallest_supported_unit_boundary() -> None:
    assert parse_duration_seconds("1ms") == 0.001


def test_parse_duration_largest_unit_conversion_boundary() -> None:
    assert parse_duration_seconds("1h") == 3600.0


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1000ms", 1.0),
        ("60s", 60.0),
        ("90m", 5400.0),
        ("2.5h", 9000.0),
        ("12s", 12.0),
    ],
)
def test_parse_duration_parametrized_conversions(
    value: str, expected: float
) -> None:
    assert parse_duration_seconds(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "   ",
        "\n",
        "-1s",
        "-250ms",
        "-1m",
        "nan",
        "NaN",
        "inf",
        "-inf",
        "infinity",
        "s",
        "ms",
        "5",
        "5 seconds",
        "5x",
        "5w",
        "1sm",
        "1 5s",
        "1.2.3s",
        "1e3s",
        "s5",
        "1 s s",
        "1ms ms",
    ],
)
def test_parse_duration_rejects_malformed_values(value: str) -> None:
    with pytest.raises(ValueError):
        parse_duration_seconds(value)


@pytest.mark.parametrize("value", [None, 1, 1.5, b"1s", ["1s"]])
def test_parse_duration_rejects_non_strings(value: object) -> None:
    with pytest.raises(ValueError):
        parse_duration_seconds(value)  # type: ignore[arg-type]
