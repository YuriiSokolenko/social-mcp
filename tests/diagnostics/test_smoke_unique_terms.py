"""Focused coverage for the smoke unique-term helper."""

import pytest

from social_mcp.diagnostics.smoke_unique_terms import unique_terms


def test_terms_are_lowercased_and_trimmed() -> None:
    assert unique_terms(["  Mastodon  ", "Buffer"]) == ["mastodon", "buffer"]


def test_first_seen_order_is_preserved() -> None:
    assert unique_terms(["beta", "alpha", "gamma"]) == ["beta", "alpha", "gamma"]


def test_duplicates_after_normalization_are_removed_once() -> None:
    assert unique_terms(["Mastodon", "mastodon", " mastodon ", "mastodon"]) == [
        "mastodon"
    ]


def test_blank_and_whitespace_only_terms_are_skipped() -> None:
    assert unique_terms(["", "   ", "\t", "ok", "\n"]) == ["ok"]


def test_empty_input_returns_empty_list() -> None:
    assert unique_terms([]) == []


def test_non_list_input_raises() -> None:
    with pytest.raises(ValueError):
        unique_terms("mastodon")


@pytest.mark.parametrize("values", [None, 0, {"mastodon"}, ("mastodon",)])
def test_non_list_inputs_raise(values: object) -> None:
    with pytest.raises(ValueError):
        unique_terms(values)


@pytest.mark.parametrize("bad", [None, 7, 1.5, True, 0])
def test_non_string_elements_raise(bad: object) -> None:
    with pytest.raises(ValueError):
        unique_terms(["mastodon", bad])


def test_input_list_is_not_mutated() -> None:
    values = [" Mastodon ", "mastodon", "buffer", ""]
    result = unique_terms(values)

    assert values == [" Mastodon ", "mastodon", "buffer", ""]
    assert result == ["mastodon", "buffer"]


def test_result_is_a_fresh_list() -> None:
    values = ["mastodon"]
    result = unique_terms(values)

    assert result is not values
    result.append("buffer")
    assert values == ["mastodon"]
