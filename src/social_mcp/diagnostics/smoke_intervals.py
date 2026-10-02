"""Numeric interval normalization helper for smoke diagnostics."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

__all__ = ["merge_intervals"]


def _as_number(value: Any, interval: Any) -> float:
    """Return ``value`` when it is a real number, otherwise raise ``ValueError``."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"interval must contain numeric values: {interval!r}")
    return value


def _normalize_interval(interval: Any) -> tuple[float, float]:
    """Return a ``(start, end)`` pair, rejecting malformed or reversed intervals."""
    try:
        start, end = interval
    except (TypeError, ValueError):
        raise ValueError(
            f"interval must contain exactly two numeric values: {interval!r}"
        ) from None

    start_value = _as_number(start, interval)
    end_value = _as_number(end, interval)

    if start_value > end_value:
        raise ValueError(
            f"interval start must not exceed its end: ({start_value!r}, {end_value!r})"
        )

    return start_value, end_value


def merge_intervals(intervals: Iterable[Iterable[float]]) -> list[tuple[float, float]]:
    """Return sorted, merged intervals for ``intervals``.

    Overlapping and directly touching intervals are merged; disjoint intervals
    are preserved in ascending order. The caller's input is never mutated.

    Raises:
        ValueError: if an interval is malformed or its start exceeds its end.
    """
    normalized = [_normalize_interval(interval) for interval in intervals]
    if not normalized:
        return []

    normalized.sort()
    merged: list[tuple[float, float]] = [normalized[0]]

    for start, end in normalized[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            if end > last_end:
                merged[-1] = (last_start, end)
            continue
        merged.append((start, end))

    return merged
