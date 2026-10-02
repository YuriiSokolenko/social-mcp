"""Focused tests for :mod:`social_mcp.diagnostics.smoke_intervals`."""

import pytest

from social_mcp.diagnostics.smoke_intervals import merge_intervals


def test_empty_input_returns_empty_list():
    assert merge_intervals([]) == []


def test_unsorted_input_is_returned_in_ascending_order():
    assert merge_intervals([(5, 7), (1, 2), (3, 4)]) == [(1, 2), (3, 4), (5, 7)]


def test_overlapping_intervals_are_merged():
    assert merge_intervals([(1, 5), (2, 6), (4, 8)]) == [(1, 8)]


def test_nested_intervals_are_merged():
    assert merge_intervals([(1, 10), (2, 3), (7, 9)]) == [(1, 10)]


def test_touching_boundaries_are_merged():
    assert merge_intervals([(1, 2), (2, 3), (3, 4)]) == [(1, 4)]


def test_disjoint_intervals_are_preserved():
    assert merge_intervals([(1, 2), (9, 10), (5, 6)]) == [(1, 2), (5, 6), (9, 10)]


def test_duplicates_collapse_to_a_single_interval():
    assert merge_intervals([(1, 2), (1, 2), (1, 2)]) == [(1, 2)]


def test_float_bounds_are_supported():
    assert merge_intervals([(0.5, 1.5), (1.5, 2.5), (4.0, 4.5)]) == [
        (0.5, 2.5),
        (4.0, 4.5),
    ]


def test_lists_are_accepted_and_returned_as_tuples():
    assert merge_intervals([[3, 4], [1, 2]]) == [(1, 2), (3, 4)]


def test_generator_input_is_supported():
    assert merge_intervals(iter([(2, 3), (1, 2)])) == [(1, 3)]


def test_input_is_not_mutated():
    intervals = [[5, 9], [1, 3], [2, 4]]

    result = merge_intervals(intervals)

    assert result == [(1, 4), (5, 9)]
    assert intervals == [[5, 9], [1, 3], [2, 4]]
    assert all(isinstance(item, list) for item in intervals)


@pytest.mark.parametrize(
    "interval",
    [
        (),
        (1,),
        (1, 2, 3),
        "12",
        (1, "2"),
        ("a", 2),
        (None, 1),
        (1, None),
        (True, 2),
        (1, True),
        (5, 1),
        ([1, 2],),
    ],
)
def test_invalid_intervals_raise_value_error(interval):
    with pytest.raises(ValueError):
        merge_intervals([interval])


def test_invalid_interval_does_not_consume_valid_ones_before_raising():
    with pytest.raises(ValueError):
        merge_intervals([(1, 2), (3, 4), (7, 5)])
