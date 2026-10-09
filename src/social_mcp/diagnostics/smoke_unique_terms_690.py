"""Normalisation of repeated search terms used by diagnostics smoke checks.

Smoke checks receive raw search terms from provider payloads, where the same
term regularly appears several times with different surrounding whitespace or
casing.  This module turns such a payload into the plain, lower-case term set
a check actually needs: every entry is trimmed and lower-cased, entries left
empty by trimming are dropped, and repeats are removed while the first seen
occurrence of each term keeps its position.

The function never reads or writes the caller's list; the returned list is
always a new object, so callers remain free to mutate whatever they hold.
"""

from __future__ import annotations

__all__ = ["unique_terms"]


def unique_terms(terms: list[str]) -> list[str]:
    """Return normalised, de-duplicated terms in first-seen order.

    Args:
        terms: A list of raw search term strings. Entries are trimmed of
            surrounding whitespace and lower-cased before comparison; an entry
            that is empty after trimming is skipped.

    Returns:
        A new list holding the normalised terms, each appearing exactly once,
        ordered by first appearance. The supplied list is never mutated.

    Raises:
        ValueError: If ``terms`` is not a list, or is a list containing a
            non-string entry. Strings, bytes and bytearrays are rejected as
            list input even though they are iterable, because iterating them
            would silently yield single characters.
    """
    if isinstance(terms, (str, bytes, bytearray)) or not isinstance(terms, list):
        raise ValueError(
            f"terms must be a list of strings, got {type(terms).__name__}"
        )

    normalized: list[str] = []
    seen: set[str] = set()
    for term in terms:
        if not isinstance(term, str):
            raise ValueError(
                f"terms must contain only strings, got {type(term).__name__}"
            )
        entry = term.strip().lower()
        if not entry or entry in seen:
            continue
        seen.add(entry)
        normalized.append(entry)
    return normalized
