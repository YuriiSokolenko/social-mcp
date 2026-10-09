"""Focused coverage for the smoke term normalizer."""

import pytest

from social_mcp.diagnostics.smoke_unique_terms import unique_terms


def test_terms_are_stripped_and_lowercased() -> None:
    assert unique_terms([" Alpha ", "BETA"]) == ["alpha", "beta"]


def test_first_seen_order_is_preserved_without_sorting() -> None:
    assert unique_terms(["z", "a", "m"]) == ["z", "a", "m"]


def test_duplicates_are_removed_after_normalization() -> None:
    assert unique_terms(["Alpha", "alpha", "  ALPHA  ", "beta"]) == ["alpha", "beta"]


def test_empty_list_returns_empty_list() -> None:
    assert unique_terms([]) == []


@pytest.mark.parametrize("blank", ["", "   ", "\t", "\n"])
def test_blank_terms_are_dropped(blank: str) -> None:
    assert unique_terms([blank]) == []


def test_blank_terms_do_not_disturb_order() -> None:
    assert unique_terms(["b", "", "A", "  ", "a", "c"]) == ["b", "a", "c"]


@pytest.mark.parametrize("values", [None, "abc", ("a",), {"a"}, 42, 1.5, True])
def test_non_list_input_raises(values: object) -> None:
    with pytest.raises(ValueError):
        unique_terms(values)  # type: ignore[arg-type]


@pytest.mark.parametrize("values", [[1], [None], [["a"]], [True], [b"x"], ["ok", None]])
def test_non_string_element_raises(values: list[object]) -> None:
    with pytest.raises(ValueError):
        unique_terms(values)  # type: ignore[arg-type]


def test_input_list_is_not_mutated() -> None:
    values = [" Beta ", "alpha", ""]
    expected = [" Beta ", "alpha", ""]

    result = unique_terms(values)

    assert result is not values
    assert result == ["beta", "alpha"]
    assert values == expected


def test_repeated_calls_return_equal_but_distinct_lists() -> None:
    values = ["Alpha", "alpha", "beta"]

    first = unique_terms(values)
    second = unique_terms(values)

    assert first == second
    assert first is not second
