"""Tests for the pipeline-elephant fixture used by the CI pipeline smoke test.

The fixture is a deliberately trivial training artifact: a single non-ASCII
word that exercises the full Dispatcher -> Implementer -> PR -> Merge Gate
pipeline without touching any product behavior.
"""

from pathlib import Path

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "pipeline-elephant.txt"
EXPECTED_WORD = "слон"


def test_fixture_exists() -> None:
    """The fixture file must exist on disk."""
    assert FIXTURE_PATH.is_file()


def test_fixture_contains_only_the_word_elephant() -> None:
    """Content must be exactly ``слон`` modulo a trailing newline."""
    text = FIXTURE_PATH.read_text(encoding="utf-8")
    assert text.rstrip("\n") == EXPECTED_WORD


def test_fixture_has_no_extra_non_newline_content() -> None:
    """A trailing newline is allowed, but no other characters beyond the word."""
    text = FIXTURE_PATH.read_text(encoding="utf-8")
    assert text.replace("\n", "") == EXPECTED_WORD
