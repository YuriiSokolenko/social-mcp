"""Pure token-bucket state transition helper for diagnostics smoke checks.

The helper is deterministic: it never reads the clock, sleeps, or mutates any
external state. All behaviour is a function of its arguments.
"""

from __future__ import annotations

import math

__all__ = ["token_bucket_transition"]


def token_bucket_transition(
    tokens: float,
    capacity: float,
    refill_rate: float,
    elapsed_seconds: float,
    requested: float,
) -> tuple[float, bool]:
    """Apply one token-bucket refill and consumption step.

    Args:
        tokens: Tokens currently in the bucket.
        capacity: Maximum tokens the bucket may hold.
        refill_rate: Tokens added per elapsed second.
        elapsed_seconds: Seconds of simulated elapsed time.
        requested: Tokens the caller wants to consume.

    Returns:
        A ``(tokens, allowed)`` pair where ``tokens`` is the bucket balance
        after the refill (and consumption, when allowed) and ``allowed`` says
        whether the request consumed tokens.

    Raises:
        ValueError: If any argument is negative, or if ``capacity``,
            ``refill_rate`` or ``requested`` is not strictly positive.
    """
    for name, value in (
        ("tokens", tokens),
        ("capacity", capacity),
        ("refill_rate", refill_rate),
        ("elapsed_seconds", elapsed_seconds),
        ("requested", requested),
    ):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{name} must be a number")
        if not math.isfinite(value):
            raise ValueError(f"{name} must be finite")
        if value < 0:
            raise ValueError(f"{name} must not be negative")

    if capacity <= 0:
        raise ValueError("capacity must be positive")
    if refill_rate <= 0:
        raise ValueError("refill_rate must be positive")
    if requested <= 0:
        raise ValueError("requested must be positive")

    refilled = min(capacity, tokens + refill_rate * elapsed_seconds)

    if refilled < requested:
        return refilled, False

    return refilled - requested, True
