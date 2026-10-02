"""Deterministic ``Retry-After`` parsing used by diagnostics smoke checks.

An HTTP ``Retry-After`` header value is either an integer number of
delta-seconds or an RFC 1123 HTTP-date.  Both forms are converted here into a
non-negative delay so callers can compare a response against a reference time
they control.  This module deliberately never reads the current clock: date
based values must be compared against an explicitly supplied reference
datetime, which keeps smoke checks reproducible.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

__all__ = ["parse_retry_after"]


def parse_retry_after(value: object, reference: datetime) -> int:
    """Return the non-negative ``Retry-After`` delay in whole seconds.

    Args:
        value: A delta-seconds integer or an HTTP-date string as found in a
            ``Retry-After`` header.
        reference: The caller supplied reference datetime that date based
            values are measured against. Naive datetimes are interpreted as
            UTC. Required so this helper never has to read the current clock.

    Returns:
        The delay in seconds, clamped to ``0`` for HTTP-dates already in the
        past. Fractional remaining time is rounded up to the next whole second.

    Raises:
        ValueError: If ``reference`` is not a datetime, ``value`` is not a
            supported form, a delta-seconds value is negative, or an HTTP-date
            is malformed.
    """
    if not isinstance(reference, datetime):
        raise ValueError(
            f"reference must be a datetime, got {type(reference).__name__}"
        )

    # ``bool`` is an ``int`` subclass but is not a valid header value.
    if isinstance(value, bool):
        raise ValueError(f"unsupported Retry-After value: {value!r}")

    if isinstance(value, int):
        if value < 0:
            raise ValueError(f"negative Retry-After delta-seconds: {value}")
        return value

    if not isinstance(value, str):
        raise ValueError(f"unsupported Retry-After value: {value!r}")

    text = value.strip()
    if not text:
        raise ValueError("empty Retry-After value")

    try:
        delta_seconds = int(text, 10)
    except ValueError:
        delta_seconds = None

    if delta_seconds is not None:
        if delta_seconds < 0:
            raise ValueError(f"negative Retry-After delta-seconds: {text}")
        return delta_seconds

    return _seconds_until_http_date(text, reference)


def _seconds_until_http_date(text: str, reference: datetime) -> int:
    """Return whole seconds from ``reference`` until an HTTP-date string."""
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"malformed Retry-After HTTP-date: {text!r}") from exc

    if when is None:
        raise ValueError(f"unsupported Retry-After value: {text!r}")

    if when.tzinfo is None:
        # HTTP-dates are GMT by convention; assume UTC when no offset is given.
        when = when.replace(tzinfo=timezone.utc)

    reference_dt = reference
    if reference_dt.tzinfo is None:
        reference_dt = reference_dt.replace(tzinfo=timezone.utc)

    delay = (when - reference_dt).total_seconds()
    if delay <= 0:
        return 0
    return math.ceil(delay)
