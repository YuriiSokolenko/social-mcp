"""Unique term normalisation used by diagnostics smoke checks.

Diagnostic terms arrive from arbitrary sources with inconsistent casing,
padding, and duplicates.  This module normalises a ``list`` of terms and
removes duplicates after normalisation while preserving first-seen order.  The
helper is deterministic, standard library only, and mutates no external state
or its input.
"""

from __future__ import annotations

__all__ = ["unique_terms"]


def unique_terms(values: list[str]) -> list[str]:
    """Return normalised, de-duplicated terms in first-seen order.

    Args:
        values: A ``list`` of raw term strings. Each element must be a ``str``.

    Returns:
        A fresh list of normalised terms. Each term is stripped and lowercased,
        blank terms are dropped, and duplicates are removed after normalisation
        so first-seen order is preserved. The input is never mutated.

    Raises:
        ValueError: If ``values`` is not a ``list``, or any element is not a
            ``str``.
    """
    if not isinstance(values, list):
        raise ValueError(f"values must be a list, got {type(values).__name__}")

    seen: set[str] = set()
    terms: list[str] = []
    for value in values:
        if not isinstance(value, str):
            raise ValueError(f"terms must be strings, got {type(value).__name__}")
        term = value.strip().lower()
        if not term or term in seen:
            continue
        seen.add(term)
        terms.append(term)
    return terms
