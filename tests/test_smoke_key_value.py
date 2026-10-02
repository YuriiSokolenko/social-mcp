"""Focused coverage for the standalone key/value text parser."""

import pytest

from social_mcp.diagnostics.smoke_key_value import parse_key_value_lines


def test_parses_simple_pairs():
    assert parse_key_value_lines("a=1\nb=2") == {"a": "1", "b": "2"}


def test_trims_whitespace_around_key_and_value():
    assert parse_key_value_lines("  alpha  =  beta  \n") == {"alpha": "beta"}


def test_blank_lines_are_ignored():
    text = "\n   \na=1\n\n  \nb=2\n   "
    assert parse_key_value_lines(text) == {"a": "1", "b": "2"}


def test_empty_input_yields_empty_dict():
    assert parse_key_value_lines("") == {}
    assert parse_key_value_lines("\n \n\t\n") == {}


def test_additional_separators_stay_in_value():
    assert parse_key_value_lines("url=http://example.com/?a=b=c") == {
        "url": "http://example.com/?a=b=c"
    }


def test_value_may_be_empty():
    assert parse_key_value_lines("a=") == {"a": ""}
    assert parse_key_value_lines("a=   ") == {"a": ""}


def test_duplicate_key_replaces_earlier_value():
    assert parse_key_value_lines("a=1\na=2\na=3") == {"a": "3"}


def test_missing_separator_raises_value_error():
    with pytest.raises(ValueError):
        parse_key_value_lines("a=1\nbroken\n")


def test_empty_key_raises_value_error():
    with pytest.raises(ValueError):
        parse_key_value_lines("=value")
    with pytest.raises(ValueError):
        parse_key_value_lines("   =value")
    with pytest.raises(ValueError):
        parse_key_value_lines("=   ")


def test_error_reports_line_number():
    with pytest.raises(ValueError, match="line 3"):
        parse_key_value_lines("a=1\n\nnope\n")
