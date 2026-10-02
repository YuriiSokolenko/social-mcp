"""Human-friendly duration parsing helper used by diagnostics smoke checks."""

from __future__ import annotations

import math
import re

__all__ = ["parse_duration_seconds"]

_DURATION_PATTERN = re.compile(
    r"^(?P<number>\d+(?:\.\d+)?|\.\d+)\s*(?P<unit>ms|s|m|h)$"
)
_UNIT_SECONDS: dict[str, float] = {
    "ms": 0.001,
    "s": 1.0,
    "m": 60.0,
    "h": 3600.0,
}


def parse_duration_seconds(value: str) -> float:
    """Return the duration ``value`` expressed in seconds.

    Args:
        value: A compact duration string such as ``"250ms"``, ``"1.5s"``,
            ``"2m"`` or ``"1h"``. Surrounding whitespace and whitespace
            between the number and the unit are ignored. The number may be an
            integer or a decimal, and the unit must be one of ``ms``, ``s``,
            ``m`` or ``h``.

    Returns:
        The equivalent number of seconds as a ``float``.

    Raises:
        ValueError: If ``value`` is not a string, is empty, is missing a
            supported unit, uses an unknown unit, has a negative or
            non-finite magnitude, or is otherwise malformed.
    """
    if not isinstance(value, str):
        raise ValueError(
            f"duration must be a string, got {type(value).__name__}"
        )

    text = value.strip()
    if not text:
        raise ValueError("duration must not be empty")

    match = _DURATION_PATTERN.match(text)
    if match is None:
        raise ValueError(f"invalid duration: {value!r}")

    number = float(match.group("number"))
    if not math.isfinite(number):
        raise ValueError(f"duration must be finite: {value!r}")

    unit = match.group("unit")
    seconds = number * _UNIT_SECONDS[unit]
    if not math.isfinite(seconds):
        raise ValueError(f"duration must be finite: {value!r}")
    if seconds < 0:
        raise ValueError(f"duration must not be negative: {value!r}")

    return seconds
