"""Deterministic term normalization used by diagnostics smoke checks.

Smoke checks compare collections of diagnostic terms (event names, header
names, error categories) that arrive with inconsistent casing and padding.
This module deliberately performs no I/O and never reads the clock: the same
input always normalizes to the same ordered list, which keeps smoke checks
reproducible.
"""

from __future__ import annotations

__all__ = ["unique_terms"]


def unique_terms(values: list[str]) -> list[str]:
    """Return the normalized, de-duplicated terms in first-seen order.

    Every element is stripped of surrounding whitespace and lowercased, terms
    that become empty are dropped, and duplicates are removed after
    normalization, so ``["Alpha", " alpha "]`` yields a single ``"alpha"``.

    Args:
        values: The raw terms to normalize.

    Returns:
        A fresh list of normalized terms with duplicates removed, preserving
        the order in which each normalized term was first seen. The caller's
        list is never mutated.

    Raises:
        ValueError: If ``values`` is not a list, or any element is not a
            string. The whole input is validated before normalization so a
            partially invalid list never produces a partial result.
    """
    if not isinstance(values, list):
        raise ValueError(f"values must be a list, got {type(values).__name__}")

    for index, value in enumerate(values):
        if not isinstance(value, str):
            raise ValueError(
                f"values[{index}] must be a str, got {type(value).__name__}"
            )

    seen: set[str] = set()
    terms: list[str] = []
    for value in values:
        term = value.strip().lower()
        if not term or term in seen:
            continue
        seen.add(term)
        terms.append(term)

    return terms
