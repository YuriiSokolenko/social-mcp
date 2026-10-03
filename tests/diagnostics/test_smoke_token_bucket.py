"""Focused coverage for the token-bucket diagnostics helper."""

import pytest

from social_mcp.diagnostics.smoke_token_bucket import token_bucket_transition


def test_refill_grows_balance_without_consumption_being_denied() -> None:
    tokens, allowed = token_bucket_transition(
        tokens=1.0,
        capacity=10.0,
        refill_rate=2.0,
        elapsed_seconds=3.0,
        requested=2.0,
    )

    assert allowed is True
    assert tokens == 5.0


def test_refill_is_capped_at_capacity() -> None:
    tokens, allowed = token_bucket_transition(
        tokens=8.0,
        capacity=10.0,
        refill_rate=5.0,
        elapsed_seconds=10.0,
        requested=1.0,
    )

    assert allowed is True
    assert tokens == 9.0


def test_cap_is_applied_even_when_request_is_denied() -> None:
    tokens, allowed = token_bucket_transition(
        tokens=8.0,
        capacity=10.0,
        refill_rate=5.0,
        elapsed_seconds=10.0,
        requested=11.0,
    )

    assert allowed is False
    assert tokens == 10.0


def test_denied_request_leaves_refilled_balance_untouched() -> None:
    tokens, allowed = token_bucket_transition(
        tokens=1.0,
        capacity=10.0,
        refill_rate=1.0,
        elapsed_seconds=1.0,
        requested=5.0,
    )

    assert allowed is False
    assert tokens == 2.0


def test_zero_elapsed_time_only_consumes_existing_tokens() -> None:
    tokens, allowed = token_bucket_transition(
        tokens=4.0,
        capacity=10.0,
        refill_rate=3.0,
        elapsed_seconds=0.0,
        requested=4.0,
    )

    assert allowed is True
    assert tokens == 0.0


def test_exact_balance_exactly_enough_allows_request() -> None:
    tokens, allowed = token_bucket_transition(
        tokens=0.0,
        capacity=10.0,
        refill_rate=2.0,
        elapsed_seconds=1.5,
        requested=3.0,
    )

    assert allowed is True
    assert tokens == 0.0


def test_does_not_mutate_caller_state() -> None:
    arguments = {
        "tokens": 2.0,
        "capacity": 6.0,
        "refill_rate": 1.0,
        "elapsed_seconds": 2.0,
        "requested": 1.0,
    }

    assert token_bucket_transition(**arguments) == (3.0, True)
    assert arguments == {
        "tokens": 2.0,
        "capacity": 6.0,
        "refill_rate": 1.0,
        "elapsed_seconds": 2.0,
        "requested": 1.0,
    }


@pytest.mark.parametrize(
    "kwargs",
    [
        {"tokens": -1.0, "capacity": 10.0, "refill_rate": 1.0, "elapsed_seconds": 1.0, "requested": 1.0},
        {"tokens": 1.0, "capacity": -10.0, "refill_rate": 1.0, "elapsed_seconds": 1.0, "requested": 1.0},
        {"tokens": 1.0, "capacity": 10.0, "refill_rate": -1.0, "elapsed_seconds": 1.0, "requested": 1.0},
        {"tokens": 1.0, "capacity": 10.0, "refill_rate": 1.0, "elapsed_seconds": -1.0, "requested": 1.0},
        {"tokens": 1.0, "capacity": 10.0, "refill_rate": 1.0, "elapsed_seconds": 1.0, "requested": -1.0},
    ],
)
def test_negative_inputs_raise_value_error(kwargs: dict) -> None:
    with pytest.raises(ValueError):
        token_bucket_transition(**kwargs)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"tokens": 1.0, "capacity": 0.0, "refill_rate": 1.0, "elapsed_seconds": 1.0, "requested": 1.0},
        {"tokens": 1.0, "capacity": 10.0, "refill_rate": 0.0, "elapsed_seconds": 1.0, "requested": 1.0},
        {"tokens": 1.0, "capacity": 10.0, "refill_rate": 1.0, "elapsed_seconds": 1.0, "requested": 0.0},
    ],
)
def test_invalid_non_negative_inputs_raise_value_error(kwargs: dict) -> None:
    with pytest.raises(ValueError):
        token_bucket_transition(**kwargs)
