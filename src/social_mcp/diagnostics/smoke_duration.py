"""Compact duration parsing for harness smoke checks."""

from __future__ import annotations

import math
import re

__all__ = ["parse_duration_seconds"]


_UNIT_SECONDS = {
    "ms": 0.001,
    "s": 1.0,
    "m": 60.0,
    "h": 3600.0,
}

_DURATION = re.compile(r"(?P<number>\d+(?:\.\d+)?) ?(?P<unit>ms|s|m|h)\Z")


def parse_duration_seconds(value: str) -> float:
    """Return the seconds represented by a compact duration string.

    Supported suffixes are ``ms``, ``s``, ``m``, and ``h``. The numeric part
    may be an integer or a decimal, for example ``250ms``, ``1.5s``, ``2m``,
    or ``1h``. Surrounding whitespace and an optional space between the number
    and the unit are tolerated.

    Raises:
        ValueError: If ``value`` is not a string, is empty, is malformed,
            misses its unit, uses an unknown unit, or represents a negative
            or non-finite duration.
    """
    if not isinstance(value, str):
        raise ValueError(f"duration must be a string, got {type(value).__name__!r}")

    match = _DURATION.match(value.strip())
    if match is None:
        raise ValueError(f"invalid duration, got {value!r}")

    magnitude = float(match.group("number"))
    factor = _UNIT_SECONDS[match.group("unit")]
    if not math.isfinite(magnitude) or magnitude < 0:
        raise ValueError(f"duration must be a finite non-negative value, got {value!r}")

    seconds = magnitude * factor
    if not math.isfinite(seconds):
        raise ValueError(f"duration must be finite, got {value!r}")

    return seconds
