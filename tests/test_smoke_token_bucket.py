"""Focused tests for :func:`social_mcp.diagnostics.smoke_token_bucket`."""

from __future__ import annotations

import pytest

from social_mcp.diagnostics.smoke_token_bucket import apply_token_bucket


def test_refill_adds_rate_times_elapsed() -> None:
    tokens, allowed = apply_token_bucket(
        current_tokens=1.0,
        capacity=10.0,
        refill_rate=2.0,
        elapsed_seconds=3.0,
        requested_tokens=0.0,
    )

    assert allowed is True
    assert tokens == pytest.approx(7.0)


def test_refill_is_capped_at_capacity() -> None:
    tokens, allowed = apply_token_bucket(
        current_tokens=9.0,
        capacity=10.0,
        refill_rate=5.0,
        elapsed_seconds=10.0,
        requested_tokens=0.0,
    )

    assert allowed is True
    assert tokens == pytest.approx(10.0)


def test_consumption_allowed_when_enough_tokens() -> None:
    tokens, allowed = apply_token_bucket(
        current_tokens=2.0,
        capacity=10.0,
        refill_rate=1.0,
        elapsed_seconds=2.0,
        requested_tokens=4.0,
    )

    assert allowed is True
    assert tokens == pytest.approx(0.0)


def test_consumption_denied_keeps_refilled_tokens() -> None:
    tokens, allowed = apply_token_bucket(
        current_tokens=0.0,
        capacity=10.0,
        refill_rate=1.0,
        elapsed_seconds=2.0,
        requested_tokens=5.0,
    )

    assert allowed is False
    assert tokens == pytest.approx(2.0)


def test_request_equal_to_capacity_is_a_normal_transition() -> None:
    assert apply_token_bucket(10.0, 10.0, 0.0, 0.0, 10.0) == (0.0, True)
    assert apply_token_bucket(9.0, 10.0, 0.0, 0.0, 10.0) == (9.0, False)


def test_request_above_capacity_is_invalid_not_denied() -> None:
    with pytest.raises(
        ValueError,
        match=r"requested_tokens \(10\.5\) must not exceed capacity \(10\.0\)",
    ):
        apply_token_bucket(
            current_tokens=10.0,
            capacity=10.0,
            refill_rate=100.0,
            elapsed_seconds=100.0,
            requested_tokens=10.5,
        )


def test_zero_elapsed_time_neither_refills_allows_beyond_current() -> None:
    assert apply_token_bucket(4.0, 10.0, 3.0, 0.0, 4.0) == (0.0, True)
    assert apply_token_bucket(4.0, 10.0, 3.0, 0.0, 5.0) == (4.0, False)


def test_transition_is_repeatable() -> None:
    first = apply_token_bucket(1.5, 8.0, 0.5, 4.0, 3.0)
    second = apply_token_bucket(1.5, 8.0, 0.5, 4.0, 3.0)

    assert first == second


@pytest.mark.parametrize(
    "kwargs",
    [
        {"current_tokens": -1.0, "capacity": 10.0, "refill_rate": 1.0,
         "elapsed_seconds": 1.0, "requested_tokens": 1.0},
        {"current_tokens": 1.0, "capacity": 0.0, "refill_rate": 1.0,
         "elapsed_seconds": 1.0, "requested_tokens": 1.0},
        {"current_tokens": 1.0, "capacity": -10.0, "refill_rate": 1.0,
         "elapsed_seconds": 1.0, "requested_tokens": 1.0},
        {"current_tokens": 1.0, "capacity": 10.0, "refill_rate": -2.0,
         "elapsed_seconds": 1.0, "requested_tokens": 1.0},
        {"current_tokens": 1.0, "capacity": 10.0, "refill_rate": 1.0,
         "elapsed_seconds": -1.0, "requested_tokens": 1.0},
        {"current_tokens": 1.0, "capacity": 10.0, "refill_rate": 1.0,
         "elapsed_seconds": 1.0, "requested_tokens": -1.0},
        {"current_tokens": 11.0, "capacity": 10.0, "refill_rate": 1.0,
         "elapsed_seconds": 1.0, "requested_tokens": 1.0},
    ],
)
def test_invalid_inputs_raise_value_error(kwargs: dict) -> None:
    with pytest.raises(ValueError):
        apply_token_bucket(**kwargs)
