"""Focused coverage for the smoke unique-terms normaliser."""

import pytest

from social_mcp.diagnostics.smoke_unique_terms_690 import unique_terms


def test_empty_list_returns_empty_list() -> None:
    assert unique_terms([]) == []


def test_single_term_is_returned() -> None:
    assert unique_terms(["alpha"]) == ["alpha"]


def test_duplicates_are_removed_keeping_first_seen_order() -> None:
    assert unique_terms(["beta", "alpha", "beta", "gamma", "alpha"]) == [
        "beta",
        "alpha",
        "gamma",
    ]


def test_terms_are_lowercased() -> None:
    assert unique_terms(["ALPHA", "Beta"]) == ["alpha", "beta"]


def test_terms_are_trimmed() -> None:
    assert unique_terms(["  alpha  ", "\tbeta\n"]) == ["alpha", "beta"]


def test_casing_and_whitespace_differences_are_the_same_term() -> None:
    assert unique_terms([" Alpha ", "ALPHA", "alpha"]) == ["alpha"]


def test_tabs_and_newlines_are_trimmed_away() -> None:
    assert unique_terms(["\t\nalpha\r\n"]) == ["alpha"]


@pytest.mark.parametrize("empty", ["", "   ", "\t", "\n", " \t \n "])
def test_empty_terms_are_skipped(empty: str) -> None:
    assert unique_terms(["alpha", empty, "beta"]) == ["alpha", "beta"]


def test_only_empty_terms_returns_empty_list() -> None:
    assert unique_terms(["", "  ", "\t"]) == []


def test_result_is_a_new_list() -> None:
    terms = ["alpha"]
    result = unique_terms(terms)
    assert result == terms
    assert result is not terms


def test_input_list_is_not_mutated() -> None:
    terms = ["Beta", " alpha ", "beta", "", "ALPHA"]
    original = list(terms)

    result = unique_terms(terms)

    assert terms == original
    assert result == ["beta", "alpha"]

    # The returned list is independent: mutating it leaves the input alone.
    result.append("gamma")
    assert terms == original


def test_all_returned_terms_are_lowercase_and_trimmed() -> None:
    result = unique_terms(["  MiXeD  ", "MiXeD", "mIxEd"])
    assert result == ["mixed"]


@pytest.mark.parametrize(
    "terms",
    [
        None,
        "alpha",
        b"alpha",
        bytearray(b"alpha"),
        ("alpha",),
        {"a": "a"},
        1,
        1.5,
        True,
        object(),
    ],
)
def test_non_list_input_raises(terms: object) -> None:
    with pytest.raises(ValueError):
        unique_terms(terms)  # type: ignore[arg-type]


@pytest.mark.parametrize("term", [None, 1, 1.5, True, b"alpha", ["alpha"], object()])
def test_non_string_entries_raise(term: object) -> None:
    with pytest.raises(ValueError):
        unique_terms(["alpha", term])  # type: ignore[list-item]


def test_non_string_entry_in_otherwise_valid_list_raises() -> None:
    with pytest.raises(ValueError):
        unique_terms(["alpha", "alpha", None])


def test_tuple_of_strings_is_rejected_rather_than_iterated() -> None:
    with pytest.raises(ValueError):
        unique_terms(("alpha", "beta"))  # type: ignore[arg-type]


def test_string_is_rejected_rather_than_iterated_character_wise() -> None:
    assert unique_terms(["a b"]) == ["a b"]
    with pytest.raises(ValueError):
        unique_terms("a b")  # type: ignore[arg-type]
