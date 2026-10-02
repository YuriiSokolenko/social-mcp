"""Focused coverage for the smoke whitespace normalizer."""

import pytest

from social_mcp.diagnostics.smoke_whitespace import normalize_spaces


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("", ""),
        ("   ", ""),
        ("\t\n  \r\n\x0c\x0b", ""),
        ("a b", "a b"),
        ("  hello   world  ", "hello world"),
        ("hello\tworld\n\tagain", "hello world again"),
        # Unicode whitespace recognised by str.split() collapses as well.
        ("a\u00a0b\u2007c", "a b c"),
        ("a\u3000\u2028b\u2029c", "a b c"),
        ("\u2003\u2000 x \u202f", "x"),
        ("a", "a"),
    ],
)
def test_normalize_spaces_collapses_whitespace_runs(text: str, expected: str) -> None:
    assert normalize_spaces(text) == expected


def test_preserves_non_whitespace_characters_exactly() -> None:
    text = "  keep \t\"this\"   'exactly'  as-is  "
    assert normalize_spaces(text) == "keep \"this\" 'exactly' as-is"


def test_is_idempotent() -> None:
    once = normalize_spaces("  a   b\tc  ")
    assert normalize_spaces(once) == once == "a b c"
