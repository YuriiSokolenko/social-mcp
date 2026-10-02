"""Tests for the deterministic smoke retry delay schedule."""

import pytest

from social_mcp.diagnostics.smoke_retry import retry_delays


def test_returns_one_delay_per_attempt():
    assert retry_delays(attempts=4, base_seconds=1.0, max_seconds=100.0) == [
        1.0,
        2.0,
        4.0,
        8.0,
    ]


def test_no_delays_for_zero_attempts():
    assert retry_delays(attempts=0, base_seconds=1.0, max_seconds=10.0) == []


def test_first_delay_uses_base_seconds_without_scaling():
    (first,) = retry_delays(attempts=1, base_seconds=0.25, max_seconds=100.0)
    assert first == 0.25


def test_delays_are_capped_at_max_seconds():
    assert retry_delays(attempts=5, base_seconds=1.0, max_seconds=3.0) == [
        1.0,
        2.0,
        3.0,
        3.0,
        3.0,
    ]


def test_schedule_is_deterministic():
    first = retry_delays(attempts=6, base_seconds=0.5, max_seconds=8.0)
    second = retry_delays(attempts=6, base_seconds=0.5, max_seconds=8.0)
    assert first == second == [0.5, 1.0, 2.0, 4.0, 8.0, 8.0]


def test_zero_max_seconds_caps_every_delay_at_zero():
    assert retry_delays(attempts=3, base_seconds=2.0, max_seconds=0.0) == [0.0, 0.0, 0.0]


def test_zero_base_seconds_yields_zero_delays():
    assert retry_delays(attempts=3, base_seconds=0.0, max_seconds=10.0) == [0.0, 0.0, 0.0]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"attempts": -1, "base_seconds": 1.0, "max_seconds": 10.0},
        {"attempts": 3, "base_seconds": -1.0, "max_seconds": 10.0},
        {"attempts": 3, "base_seconds": 1.0, "max_seconds": -1.0},
    ],
)
def test_negative_arguments_raise_value_error(kwargs):
    with pytest.raises(ValueError):
        retry_delays(**kwargs)
