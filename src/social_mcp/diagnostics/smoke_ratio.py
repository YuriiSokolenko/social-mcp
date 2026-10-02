"""Safe ratio helper for smoke diagnostics."""

from __future__ import annotations

__all__ = ["safe_ratio"]


def safe_ratio(numerator: float, denominator: float, *, default: float = 0.0) -> float:
    """Return ``numerator / denominator``, or ``default`` for a zero denominator.

    The result is returned unrounded.
    """
    if denominator == 0:
        return default
    return numerator / denominator
