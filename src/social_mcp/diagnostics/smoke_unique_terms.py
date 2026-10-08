"""Normalization helper used by diagnostics smoke checks.

Smoke assertions often compare a caller supplied list of terms against a
collection the code under test produced.  Callers pass the raw terms, which may
repeat entries, carry stray whitespace or differ only in case.  This module
collapses those inputs into a canonical, order-preserving list of distinct
terms so comparisons can be made directly.

The helper is deliberately side-effect free: it never mutates the input and
reads nothing outside its arguments, which keeps smoke checks reproducible.
"""

from __future__ import annotations

__all__ = ["unique_terms"]


def unique_terms(values: list[str]) -> list[str]:
    """Return normalized, distinct terms in first-seen order.

    Each term is stripped of surrounding whitespace and lowercased.  Empty
    results (including terms that are only whitespace) are dropped, and
    duplicates that collapse to the same normalized term are skipped so the
    first occurrence wins.

    Args:
        values: A list of terms to normalize. The list itself is never
            modified.

    Returns:
        A fresh list of the distinct normalized terms, in the order they were
        first seen.

    Raises:
        ValueError: If ``values`` is not a list, or if any element is not a
            string.
    """
    if not isinstance(values, list):
        raise ValueError(f"values must be a list, got {type(values).__name__}")

    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if not isinstance(value, str):
            raise ValueError(
                f"terms must be strings, got {type(value).__name__}: {value!r}"
            )
        term = value.strip().lower()
        if not term or term in seen:
            continue
        seen.add(term)
        result.append(term)
    return result
