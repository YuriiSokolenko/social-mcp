"""Deterministic parsing of HTTP ``Retry-After`` header values.

``Retry-After`` accepts two syntaxes (RFC 9110, section 10.2.3):

* ``delay-seconds``: a non-negative integer number of seconds.
* ``HTTP-date``: an absolute timestamp at or after which the request may be
  repeated.

Programmatic numeric values follow the same integer semantics as the wire
format: integer values and finite floats representing whole seconds are
accepted, while fractional or non-finite floats are rejected.

Absolute timestamps cannot be turned into a duration without knowing *when*
the response was produced, so callers must supply the reference datetime
explicitly. This module never reads the wall clock, which keeps smoke checks
reproducible.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

__all__ = ["parse_retry_after"]


def _as_reference(reference: datetime) -> datetime:
    """Return ``reference`` as an aware datetime in UTC.

    Naive datetimes are interpreted as UTC so comparisons with parsed HTTP
    dates (which are always converted to UTC) are well defined.
    """

    if reference.tzinfo is None:
        return reference.replace(tzinfo=timezone.utc)
    return reference.astimezone(timezone.utc)


def _parse_delta_seconds(text: str) -> float:
    """Parse the ``delay-seconds`` syntax."""

    try:
        seconds = int(text)
    except ValueError as exc:  # not an integer at all
        raise ValueError(f"invalid Retry-After delta-seconds: {text!r}") from exc
    if seconds < 0:
        raise ValueError(f"Retry-After delta-seconds must not be negative: {text!r}")
    return float(seconds)


def _parse_http_date(text: str, reference: datetime) -> float:
    """Parse the ``HTTP-date`` syntax into seconds elapsed from ``reference``."""

    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid Retry-After HTTP-date: {text!r}") from exc
    if parsed is None:  # pragma: no cover - email.utils raises instead
        raise ValueError(f"invalid Retry-After HTTP-date: {text!r}")
    if parsed.tzinfo is None:  # pragma: no cover - defensive
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (parsed - reference).total_seconds()


def parse_retry_after(value: "str | int | float", reference: datetime) -> float:
    """Convert an HTTP ``Retry-After`` value into a non-negative delay.

    Args:
        value: The raw header value. Integers and finite floats representing
            whole seconds are treated as ``delay-seconds``. Strings may hold
            either an integer ``delay-seconds`` value or an RFC-compatible
            ``HTTP-date``. Fractional and non-finite floats are rejected.
        reference: The moment the response was received. Required so date
            based values resolve deterministically; the current clock is
            never read.

    Returns:
        The delay in seconds. Past HTTP-date values clamp to ``0.0``.

    Raises:
        ValueError: If ``value`` is a negative, fractional, or non-finite
            numeric delta, a malformed date, or is neither a supported
            delta-seconds nor an HTTP-date value.
    """

    if isinstance(value, bool):
        raise ValueError(f"unsupported Retry-After value: {value!r}")

    if isinstance(value, (int, float)):
        if isinstance(value, float) and (
            not math.isfinite(value) or not value.is_integer()
        ):
            raise ValueError(
                "Retry-After delta-seconds must be a finite integer: "
                f"{value!r}"
            )
        if value < 0:
            raise ValueError(
                f"Retry-After delta-seconds must not be negative: {value!r}"
            )
        return float(value) + 0.0

    if not isinstance(value, str):
        raise ValueError(f"unsupported Retry-After value: {value!r}")

    text = value.strip()
    if not text:
        raise ValueError("invalid Retry-After value: ''")

    if text.lstrip("+-").isdigit():
        return _parse_delta_seconds(text)

    delay = _parse_http_date(text, _as_reference(reference))
    if delay <= 0:
        return 0.0
    return delay
