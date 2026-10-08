"""Focused coverage for the smoke ``unique_terms`` helper."""

import pytest

from social_mcp.diagnostics.smoke_unique_terms import unique_terms


def test_empty_list_returns_empty_list() -> None:
    assert unique_terms([]) == []


def test_whitespace_is_stripped_and_case_lowercased() -> None:
    assert unique_terms([" Foo ", "BAR"]) == ["foo", "bar"]


def test_interior_whitespace_is_preserved() -> None:
    assert unique_terms(["  two  words  "]) == ["two  words"]


def test_case_variants_collapse_to_one_term() -> None:
    assert unique_terms(["Foo", "foo", "FOO"]) == ["foo"]


def test_order_is_preserved_when_duplicates_follow() -> None:
    assert unique_terms(["b", "a", "b"]) == ["b", "a"]


def test_order_is_preserved_for_longer_chains() -> None:
    assert unique_terms(["beta", "Beta ", " alpha", "gamma", "ALPHA"]) == [
        "beta",
        "alpha",
        "gamma",
    ]


def test_duplicates_after_normalisation_keep_first_occurrence() -> None:
    assert unique_terms([" cat ", "cat", "CAT"]) == ["cat"]


def test_single_blank_term_is_skipped() -> None:
    assert unique_terms([""]) == []


def test_whitespace_only_terms_are_skipped() -> None:
    assert unique_terms(["   ", "\t", "\n"]) == []


def test_blank_terms_are_skipped_around_real_terms() -> None:
    assert unique_terms(["a", "", " "]) == ["a"]


@pytest.mark.parametrize("values", [None, "cat", ("a",), {"a"}, 42, 3.5, {"a": 1}])
def test_non_list_input_raises(values: object) -> None:
    with pytest.raises(ValueError):
        unique_terms(values)


@pytest.mark.parametrize(
    "values", [[None], [1], [True], [False], [1.5], [["a"]], [{"a"}], [b"a"]]
)
def test_non_string_element_raises(values: list[object]) -> None:
    with pytest.raises(ValueError):
        unique_terms(values)


def test_invalid_element_is_rejected_after_valid_terms() -> None:
    with pytest.raises(ValueError):
        unique_terms(["fine", 7])


def test_input_list_is_not_mutated() -> None:
    original = [" B ", "a", "a"]
    unique_terms(original)
    assert original == [" B ", "a", "a"]


def test_result_is_a_fresh_list() -> None:
    original: list[str] = []
    assert unique_terms(original) is not original
    assert unique_terms([" B ", "a", "a"]) == ["b", "a"]
    assert unique_terms([" B ", "a", "a"]) is not original
