"""Tests for the deterministic ``chunked`` smoke helper."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from social_mcp.diagnostics.smoke_chunks import chunked


def test_chunked_preserves_input_order_for_lists() -> None:
    assert chunked([1, 2, 3, 4, 5, 6], 2) == [[1, 2], [3, 4], [5, 6]]


def test_chunked_returns_lists_inside_a_list() -> None:
    chunks = chunked(["a", "b", "c"], 2)

    assert isinstance(chunks, list)
    assert all(isinstance(chunk, list) for chunk in chunks)
    assert chunks == [["a", "b"], ["c"]]


def test_chunked_includes_final_partial_chunk() -> None:
    assert chunked([1, 2, 3, 4], 3) == [[1, 2, 3], [4]]


def test_chunked_accepts_tuples() -> None:
    assert chunked((1, 2, 3), 2) == [[1, 2], [3]]


def test_chunked_consumes_iterator_exactly_once() -> None:
    def items() -> Iterator[int]:
        yield from range(5)

    iterator = items()

    assert chunked(iterator, 2) == [[0, 1], [2, 3], [4]]
    assert chunked(iterator, 2) == []


def test_chunked_empty_input_returns_empty_list() -> None:
    assert chunked([], 3) == []
    assert chunked(iter(())   , 1) == []
    assert chunked(()         , 1) == []


def test_chunked_size_larger_than_input_yields_single_chunk() -> None:
    assert chunked([1, 2], 10) == [[1, 2]]


def test_chunked_does_not_modify_its_input() -> None:
    source = [1, 2, 3]

    assert chunked(source, 2) == [[1, 2], [3]]
    assert source == [1, 2, 3]


@pytest.mark.parametrize("size", [0, -1, -7])
def test_chunked_rejects_non_positive_size(size: int) -> None:
    with pytest.raises(ValueError):
        chunked([1, 2, 3], size)


@pytest.mark.parametrize("size", [1.5, "2", None, True])
def test_chunked_rejects_non_integer_size(size: object) -> None:
    with pytest.raises(ValueError):
        chunked([1, 2, 3], size)


def test_chunked_validates_size_before_consuming_input() -> None:
    consumed: list[int] = []

    def items() -> Iterator[int]:
        for value in (1, 2, 3):
            consumed.append(value)
            yield value

    with pytest.raises(ValueError):
        chunked(items(), 0)

    assert consumed == []
