"""Focused tests for the stable_unique smoke helper."""

from social_mcp.diagnostics.smoke_unique import stable_unique


def test_empty_input_returns_empty_list() -> None:
    assert stable_unique([]) == []


def test_keeps_first_occurrence_and_preserves_order() -> None:
    items = ["b", "a", "b", "c", "a"]

    assert stable_unique(items) == ["b", "a", "c"]


def test_comparison_is_case_sensitive() -> None:
    assert stable_unique(["a", "A", "a"]) == ["a", "A"]


def test_returns_new_list_and_leaves_input_untouched() -> None:
    items = ["x", "x", "y"]

    result = stable_unique(items)

    assert result == ["x", "y"]
    assert result is not items
    assert items == ["x", "x", "y"]
