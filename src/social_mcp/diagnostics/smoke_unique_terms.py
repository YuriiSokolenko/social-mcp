"""Whitespace-normalised unique term collection used by diagnostics smoke checks.

Terms arriving from configuration and captured traffic differ only by case and
surrounding whitespace.  This helper canonicalises them so callers can compare
term lists without accidentally dropping the order the caller supplied, which
keeps smoke assertions readable and deterministic.
"""

from __future__ import annotations

__all__ = ["unique_terms"]


def unique_terms(values: list[str]) -> list[str]:
    """Return the normalized ``values`` with duplicates removed.

    Each term is stripped of surrounding whitespace and lowercased; results
    that become empty are skipped.  Duplicates are removed after
    normalization while keeping the first-seen order.

    Args:
        values: Terms to normalize. The input list is never modified.

    Returns:
        A fresh list of the distinct normalized terms.

    Raises:
        ValueError: If ``values`` is not a list or any element is not a
            ``str``.
    """
    if not isinstance(values, list):
        raise ValueError(f"values must be a list, got {type(values).__name__}")

    seen: set[str] = set()
    terms: list[str] = []
    for item in values:
        if not isinstance(item, str):
            raise ValueError(f"term must be a str, got {type(item).__name__}")
        term = item.strip().lower()
        if not term or term in seen:
            continue
        seen.add(term)
        terms.append(term)
    return terms
