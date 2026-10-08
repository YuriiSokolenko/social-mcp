"""Term normalisation helpers used by diagnostics smoke checks.

Diagnostic labels and search terms arrive from callers with inconsistent case,
surrounding whitespace and duplicates.  This module reduces such a list to the
ordered set of canonical terms so smoke checks can compare like-for-like
without depending on how a caller formatted its input.  The helper is purely
computational: it reads no clock, performs no I/O and never mutates its input.
"""

from __future__ import annotations

__all__ = ["unique_terms"]


def unique_terms(values: list[str]) -> list[str]:
    """Return canonical terms in first-seen order, without duplicates.

    Each element is stripped of surrounding whitespace and lowercased.  Terms
    that are empty after normalisation are skipped, and repeated normalised
    terms are kept only at their first occurrence.

    Args:
        values: A list of raw term strings.  Every element must be a ``str``.

    Returns:
        A new list of normalised, deduplicated terms in first-seen order.  The
        input list is never modified.

    Raises:
        ValueError: If ``values`` is not a list or any element is not a string.
    """
    if not isinstance(values, list):
        raise ValueError(f"values must be a list, got {type(values).__name__}")

    seen: set[str] = set()
    result: list[str] = []

    for value in values:
        if not isinstance(value, str):
            raise ValueError(f"terms must be strings, got {type(value).__name__}")

        term = value.strip().lower()
        if not term or term in seen:
            continue

        seen.add(term)
        result.append(term)

    return result
