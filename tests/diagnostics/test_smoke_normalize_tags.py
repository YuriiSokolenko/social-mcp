"""Focused coverage for the tag normalisation helper."""

import pytest

from social_mcp.diagnostics.smoke_normalize_tags import normalize_tags


def test_strips_and_lowercases_tags() -> None:
    assert normalize_tags([" Hello ", "WORLD"]) == ["hello", "world"]


def test_deduplicates_while_preserving_first_seen_order() -> None:
    assert normalize_tags(["b", "a", "B", "a"]) == ["b", "a"]


def test_deduplication_happens_after_normalisation() -> None:
    assert normalize_tags(["Foo", " foo ", "FOO"]) == ["foo"]


def test_blank_tags_are_dropped() -> None:
    assert normalize_tags(["", "   ", "ok"]) == ["ok"]


def test_all_blank_tags_produce_empty_list() -> None:
    assert normalize_tags(["", "  ", "\t", "\n"]) == []


def test_empty_input_returns_empty_list() -> None:
    assert normalize_tags([]) == []


def test_does_not_mutate_caller_input() -> None:
    payload = ["b", " a ", "b"]
    original = list(payload)

    result = normalize_tags(payload)

    assert result == ["b", "a"]
    assert result is not payload
    assert payload == original


@pytest.mark.parametrize(
    "payload",
    [None, "abc", ("a",), {"a": 1}, 42, 1.5, True],
)
def test_invalid_container_raises_value_error(payload: object) -> None:
    with pytest.raises(ValueError):
        normalize_tags(payload)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "payload",
    [[None], ["ok", 1], [True], [["x"]], [b"x"], ["ok", object()]],
)
def test_invalid_element_raises_value_error(payload: list) -> None:
    with pytest.raises(ValueError):
        normalize_tags(payload)  # type: ignore[arg-type]
