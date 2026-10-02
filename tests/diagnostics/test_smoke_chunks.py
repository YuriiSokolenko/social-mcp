"""Tests for social_mcp.diagnostics.smoke_chunks."""

import pytest

from social_mcp.diagnostics.smoke_chunks import chunked


def test_preserves_order_and_returns_lists():
    chunks = chunked([1, 2, 3, 4], 2)

    assert chunks == [[1, 2], [3, 4]]
    assert all(isinstance(chunk, list) for chunk in chunks)


def test_tuple_input():
    assert chunked(("a", "b", "c"), 2) == [["a", "b"], ["c"]]


def test_generator_input_consumed_once():
    def items():
        yield from range(5)

    assert chunked(items(), 3) == [[0, 1, 2], [3, 4]]


def test_final_partial_chunk_kept():
    assert chunked([1, 2, 3], 2) == [[1, 2], [3]]


def test_empty_input_returns_empty_list():
    assert chunked([], 3) == []
    assert chunked(iter(()), 3) == []


def test_chunk_size_larger_than_input():
    assert chunked([1, 2], 10) == [[1, 2]]


@pytest.mark.parametrize("size", [0, -1, -100])
def test_rejects_non_positive_size(size):
    with pytest.raises(ValueError):
        chunked([1, 2, 3], size)


@pytest.mark.parametrize("size", [1.5, "2", None])
def test_rejects_non_integer_size(size):
    with pytest.raises(ValueError):
        chunked([1, 2, 3], size)
