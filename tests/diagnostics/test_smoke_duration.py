"""Focused coverage for the smoke duration parser."""

import pytest

from social_mcp.diagnostics.smoke_duration import parse_duration_seconds


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("0ms", 0.0),
        ("250ms", 0.25),
        ("1000ms", 1.0),
        ("1s", 1.0),
        ("1.5s", 1.5),
        ("90s", 90.0),
        ("2m", 120.0),
        ("2.5m", 150.0),
        ("1h", 3600.0),
        ("0.5h", 1800.0),
    ],
)
def test_parse_duration_seconds_converts_each_unit(text, expected):
    assert parse_duration_seconds(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (" 2m", 120.0),
        ("2m ", 120.0),
        ("\t1.5s\n", 1.5),
        ("2 m", 120.0),
        ("  250 ms  ", 0.25),
    ],
)
def test_parse_duration_seconds_tolerates_whitespace(text, expected):
    assert parse_duration_seconds(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "0",
        "-5s",
        "-1m",
        "1.5",
        "1",
        "s",
        "ms",
        "1x",
        "1d",
        "1sm",
        "nan",
        "inf",
        "-inf",
        "Infinity",
        "1.5sec",
        "1.5 s s",
        "1,5s",
        "1..5s",
        ".5s",
        "1.s",
        25,
        None,
    ],
)
def test_parse_duration_seconds_rejects_invalid_input(text):
    with pytest.raises(ValueError):
        parse_duration_seconds(text)
