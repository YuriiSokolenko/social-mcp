"""Focused coverage for the smoke unique-terms helper."""

import pytest

from social_mcp.diagnostics.smoke_unique_terms import unique_terms


def test_normalizes_whitespace_and_case() -> None:
    assert unique_terms(["  Alpha ", "beta", " GAMMA"]) == ["alpha", "beta", "gamma"]


def test_empty_input_returns_empty_list() -> None:
    assert unique_terms([]) == []


def test_blanks_are_skipped() -> None:
    assert unique_terms(["", "  ", "\t", "ok", "\n", ""]) == ["ok"]


def test_duplicates_are_removed_preserving_first_seen_order() -> None:
    terms = ["beta", "alpha", "beta", "gamma", "alpha"]
    assert unique_terms(terms) == ["beta", "alpha", "gamma"]


def test_normalized_duplicates_collapse_to_first_occurrence() -> None:
    assert unique_terms([" Alpha ", "ALPHA", "alpha"]) == ["alpha"]


def test_input_list_is_not_mutated() -> None:
    terms = [" Beta ", "", "alpha", "beta"]
    result = unique_terms(terms)

    assert terms == [" Beta ", "", "alpha", "beta"]
    assert result == ["beta", "alpha"]
    assert result is not terms


@pytest.mark.parametrize(
    "values", [None, "alpha", ("alpha", "beta"), {"alpha": 1}, 0, {"alpha"}]
)
def test_non_list_input_raises(values: object) -> None:
    with pytest.raises(ValueError):
        unique_terms(values)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "value", [None, 1, 1.5, True, ["alpha"], ("alpha",), object()]
)
def test_non_string_element_raises(value: object) -> None:
    with pytest.raises(ValueError):
        unique_terms(["ok", value])  # type: ignore[list-item]
