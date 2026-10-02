"""Bounded integer clamp helper used by diagnostics smoke checks."""

from __future__ import annotations

__all__ = ["clamp"]


def clamp(value: int, minimum: int, maximum: int) -> int:
    """Return ``value`` limited to the inclusive range ``[minimum, maximum]``.

    Args:
        value: The integer to bound.
        minimum: Lower bound of the allowed range.
        maximum: Upper bound of the allowed range.

    Returns:
        ``minimum`` when ``value`` is below the range, ``maximum`` when it is
        above the range, otherwise ``value`` unchanged.

    Raises:
        ValueError: If ``minimum`` is greater than ``maximum``.
    """
    if minimum > maximum:
        raise ValueError(
            f"minimum ({minimum}) must not exceed maximum ({maximum})"
        )
    if value < minimum:
        return minimum
    if value > maximum:
        return maximum
    return value
