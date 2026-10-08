"""Focused coverage for the smoke unique-term normaliser."""

import pytest

from social_mcp.diagnostics.smoke_unique_terms import unique_terms


def test_strips_whitespace_and_lowercases() -> None:
    assert unique_terms(["  Alpha "]) == ["alpha"]


def test_preserves_first_seen_order() -> None:
    assert unique_terms(["b", "a", "c"]) == ["b", "a", "c"]


def test_normalisation_does_not_reorder() -> None:
    assert unique_terms([" Beta ", "alpha", "GAMMA"]) == ["beta", "alpha", "gamma"]


def test_deduplicates_after_normalisation() -> None:
    assert unique_terms(["Foo", "foo", "FOO", "bar"]) == ["foo", "bar"]


def test_already_unique_list_round_trips() -> None:
    assert unique_terms(["one", "two", "three"]) == ["one", "two", "three"]


def test_blank_terms_are_skipped() -> None:
    assert unique_terms(["", "  ", "x"]) == ["x"]


def test_empty_list_returns_empty_list() -> None:
    assert unique_terms([]) == []


def test_all_blank_terms_return_empty_list() -> None:
    assert unique_terms(["", " ", "\t", "\n"]) == []


@pytest.mark.parametrize("values", [("a",), {"a"}, {"a": 1}, "a", 1.5, None, True])
def test_non_list_input_raises(values: object) -> None:
    with pytest.raises(ValueError):
        unique_terms(values)


@pytest.mark.parametrize("element", [None, 1, 1.5, True, ["a"], object()])
def test_non_string_element_raises(element: object) -> None:
    with pytest.raises(ValueError):
        unique_terms(["ok", element])


def test_input_is_not_mutated() -> None:
    values = ["  Beta ", "alpha", "beta", ""]
    snapshot = list(values)
    result = unique_terms(values)
    assert values == snapshot
    assert result is not values
    assert result == ["beta", "alpha"]
