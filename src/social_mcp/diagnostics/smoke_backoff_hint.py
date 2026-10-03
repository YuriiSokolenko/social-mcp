"""Deterministic backoff-delay parsing used by diagnostics smoke checks.

A backoff hint is either an integer number of delta-seconds or an
RFC 1123/RFC 9110 HTTP-date.  Both forms are converted here into a
non-negative delay measured against a caller supplied reference datetime.
This module deliberately never reads the current clock: date based values are
always compared against the explicitly supplied reference, which keeps smoke
checks reproducible.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

__all__ = ["parse_backoff_hint"]

# RFC 9110 section 10.2.3: delay-seconds = 1*DIGIT (ASCII digits only; no
# sign, underscores or non-ASCII digits, which ``int()`` would accept).
_DELAY_SECONDS = re.compile(r"[0-9]+")


def parse_backoff_hint(value: object, reference: datetime) -> int:
    """Return the non-negative backoff delay in whole seconds.

    Args:
        value: A delta-seconds integer (ASCII digits only) or an HTTP-date
            string.
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

    # ``bool`` is an ``int`` subclass but is not a valid backoff hint.
    if isinstance(value, bool):
        raise ValueError(f"unsupported backoff hint value: {value!r}")

    if isinstance(value, int):
        if value < 0:
            raise ValueError(f"negative backoff delta-seconds: {value}")
        return value

    if not isinstance(value, str):
        raise ValueError(f"unsupported backoff hint value: {value!r}")

    text = value.strip()
    if not text:
        raise ValueError("empty backoff hint value")

    if _DELAY_SECONDS.fullmatch(text):
        return int(text, 10)

    if text[0] == "-":
        raise ValueError(f"negative backoff delta-seconds: {text}")

    return _seconds_until_http_date(text, reference)


def _seconds_until_http_date(text: str, reference: datetime) -> int:
    """Return whole seconds from ``reference`` until an HTTP-date string."""
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"malformed backoff hint HTTP-date: {text!r}") from exc

    if when is None:
        raise ValueError(f"unsupported backoff hint value: {text!r}")

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
