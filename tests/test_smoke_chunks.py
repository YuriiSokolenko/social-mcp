"""Tests for the harness smoke line chunking helper."""

import pytest

from social_mcp.diagnostics.smoke_chunks import chunk_lines


def test_empty_input_returns_no_chunks() -> None:
    assert chunk_lines([], 3) == []


@pytest.mark.parametrize("invalid_size", [0, -1, -7])
def test_non_positive_size_raises(invalid_size: int) -> None:
    with pytest.raises(ValueError):
        chunk_lines(["a", "b"], invalid_size)


def test_even_split_preserves_order() -> None:
    assert chunk_lines(["a", "b", "c", "d"], 2) == [["a", "b"], ["c", "d"]]


def test_final_chunk_may_be_shorter() -> None:
    assert chunk_lines(["a", "b", "c", "d", "e"], 2) == [
        ["a", "b"],
        ["c", "d"],
        ["e"],
    ]


def test_size_larger_than_input_yields_single_chunk() -> None:
    assert chunk_lines(["a", "b"], 10) == [["a", "b"]]


def test_size_one_yields_one_chunk_per_line() -> None:
    assert chunk_lines(["a", "b", "c"], 1) == [["a"], ["b"], ["c"]]


def test_chunks_are_new_lists_not_aliases() -> None:
    lines = ["a", "b", "c"]
    chunks = chunk_lines(lines, 2)

    assert chunks[0] is not lines
    assert chunks[1] is not lines
    assert all(chunk is not lines for chunk in chunks)

    chunks[0].append("mutated")
    chunks[1].clear()

    assert lines == ["a", "b", "c"]
