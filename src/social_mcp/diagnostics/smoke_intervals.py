"""Pure helpers for normalising and merging numeric intervals.

The helpers in this module are intentionally dependency free so diagnostics
can exercise interval logic without touching any external service.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from numbers import Real

__all__ = ["merge_intervals"]


def _require_number(name: str, value: object) -> float:
    """Return ``value`` when it is a real number.

    Booleans are rejected on purpose: they are not meaningful interval bounds
    and accepting them would let ``True`` silently behave like ``1``.
    """

    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(
            f"interval {name} must be a number, got {value!r}"
        )
    return value


def _as_pair(interval: object) -> tuple[float, float]:
    """Validate a single two-item interval without touching the caller's data."""

    try:
        start, end = interval  # type: ignore[misc]
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"interval must hold exactly two numbers, got {interval!r}"
        ) from exc

    start = _require_number("start", start)
    end = _require_number("end", end)

    if start > end:
        raise ValueError(f"interval start {start!r} must not exceed end {end!r}")

    return start, end


def merge_intervals(intervals: Iterable[Sequence[float]]) -> list[tuple[float, float]]:
    """Merge overlapping and touching numeric intervals.

    Args:
        intervals: Any iterable of two-item ``[start, end]`` numeric intervals.
            The input is only read; neither the iterable nor the individual
            intervals are mutated.

    Returns:
        Sorted, non-overlapping ``(start, end)`` tuples in ascending order.
        Overlapping and directly touching intervals are combined; disjoint
        intervals are preserved as separate entries.

    Raises:
        ValueError: If an interval does not hold exactly two numbers, holds a
            non-numeric bound, or starts after it ends.
    """

    normalized = sorted((_as_pair(interval) for interval in intervals))

    merged: list[tuple[float, float]] = []
    for start, end in normalized:
        if merged and start <= merged[-1][1]:
            # Overlapping or touching: extend the current span when needed.
            if end > merged[-1][1]:
                merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))

    return merged
