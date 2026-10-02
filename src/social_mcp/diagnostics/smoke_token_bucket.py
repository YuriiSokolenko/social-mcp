"""Deterministic token-bucket transition used by diagnostics smoke checks.

The helper is pure: it never reads a clock, sleeps, or mutates shared state, so
the same arguments always produce the same result. A request larger than the
bucket capacity is invalid input because no refill can ever satisfy it.
"""

from __future__ import annotations

__all__ = ["apply_token_bucket"]


def apply_token_bucket(
    current_tokens: float,
    capacity: float,
    refill_rate: float,
    elapsed_seconds: float,
    requested_tokens: float,
) -> tuple[float, bool]:
    """Refill a token bucket, then try to consume from it.

    The bucket is refilled by ``refill_rate * elapsed_seconds``, capped at
    ``capacity``, and ``requested_tokens`` are consumed only when the refilled
    bucket holds enough tokens to cover them.

    A request is a normal denied transition only when it could fit in the bucket
    (``requested_tokens <= capacity``) but the refilled bucket does not currently
    hold enough tokens. A request larger than ``capacity`` is invalid input and
    raises ``ValueError`` rather than returning ``allowed=False``.

    Args:
        current_tokens: Tokens in the bucket before the refill.
        capacity: Maximum number of tokens the bucket may hold.
        refill_rate: Tokens added per elapsed second.
        elapsed_seconds: Time elapsed since the previous transition.
        requested_tokens: Tokens the caller wants to consume. Values above
            ``capacity`` are invalid because they can never be satisfied.

    Returns:
        A ``(tokens, allowed)`` pair where ``tokens`` is the token count after
        the refill and the consumption attempt, and ``allowed`` reports whether
        the request was granted.

    Raises:
        ValueError: If any argument is negative, if ``capacity`` is not
            positive, if ``current_tokens`` exceeds ``capacity``, or if
            ``requested_tokens`` exceeds ``capacity``.
    """
    if current_tokens < 0:
        raise ValueError(f"current_tokens ({current_tokens}) must not be negative")
    if current_tokens > capacity:
        raise ValueError(
            f"current_tokens ({current_tokens}) must not exceed "
            f"capacity ({capacity})"
        )
    if capacity <= 0:
        raise ValueError(f"capacity ({capacity}) must be positive")
    if refill_rate < 0:
        raise ValueError(f"refill_rate ({refill_rate}) must not be negative")
    if elapsed_seconds < 0:
        raise ValueError(f"elapsed_seconds ({elapsed_seconds}) must not be negative")
    if requested_tokens < 0:
        raise ValueError(
            f"requested_tokens ({requested_tokens}) must not be negative"
        )
    if requested_tokens > capacity:
        raise ValueError(
            f"requested_tokens ({requested_tokens}) must not exceed "
            f"capacity ({capacity})"
        )

    refilled = min(capacity, current_tokens + refill_rate * elapsed_seconds)
    if requested_tokens <= refilled:
        return refilled - requested_tokens, True
    return refilled, False
