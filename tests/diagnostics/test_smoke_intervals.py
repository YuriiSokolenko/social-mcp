"""Focused coverage for the smoke interval merger."""

import pytest

from social_mcp.diagnostics.smoke_intervals import merge_intervals


def test_merge_intervals_returns_empty_list_for_empty_input() -> None:
    assert merge_intervals([]) == []


def test_merge_intervals_sorts_unsorted_input() -> None:
    assert merge_intervals([(5, 7), (1, 3)]) == [(1, 3), (5, 7)]


def test_merge_intervals_merges_overlapping_intervals() -> None:
    assert merge_intervals([(1, 4), (3, 6)]) == [(1, 6)]


def test_merge_intervals_merges_nested_overlaps() -> None:
    assert merge_intervals([(1, 10), (2, 3), (4, 5)]) == [(1, 10)]


def test_merge_intervals_merges_touching_boundaries() -> None:
    assert merge_intervals([(1, 2), (2, 3)]) == [(1, 3)]


def test_merge_intervals_merges_chain_after_sorting() -> None:
    assert merge_intervals([(4, 5), (2, 3), (3, 4)]) == [(2, 5)]


def test_merge_intervals_preserves_disjoint_intervals_ascending() -> None:
    assert merge_intervals([(6, 8), (0, 1), (3, 4)]) == [(0, 1), (3, 4), (6, 8)]


def test_merge_intervals_collapses_duplicates() -> None:
    assert merge_intervals([(1, 2), (1, 2), (1, 2)]) == [(1, 2)]


def test_merge_intervals_accepts_iterator_input() -> None:
    assert merge_intervals(iter([(1, 2), (2, 4)])) == [(1, 4)]


def test_merge_intervals_supports_negative_and_float_values() -> None:
    assert merge_intervals([(-2.5, -1.5), (-1.5, 0.5), (3.0, 4.0)]) == [
        (-2.5, 0.5),
        (3.0, 4.0),
    ]


def test_merge_intervals_does_not_mutate_caller_input() -> None:
    intervals = [[5, 7], [1, 3], [2, 4]]
    snapshot = [list(item) for item in intervals]

    assert merge_intervals(intervals) == [(1, 4), (5, 7)]
    assert intervals == snapshot


@pytest.mark.parametrize(
    "interval",
    [
        (),
        (1,),
        (1, 2, 3),
        5,
        "ab",
        (None, 1),
        ("a", 1),
        (1, True),
    ],
)
def test_merge_intervals_rejects_malformed_intervals(interval: object) -> None:
    with pytest.raises(ValueError):
        merge_intervals([(0, 1), interval])


def test_merge_intervals_rejects_reversed_interval() -> None:
    with pytest.raises(ValueError):
        merge_intervals([(3, 1)])
