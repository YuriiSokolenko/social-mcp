"""Pure tag-normalisation helper for diagnostics smoke checks.

The helper is deterministic: it never reads the clock, performs I/O, or mutates
any external state. All behaviour is a function of its single argument.
"""

from __future__ import annotations

__all__ = ["normalize_tags"]


def normalize_tags(tags: list[str]) -> list[str]:
    """Normalise a list of tags, preserving first-seen order.

    Each tag is stripped of surrounding whitespace and lowercased. Blank
    results are dropped and duplicates are removed after normalisation, so the
    earliest surviving occurrence fixes the position of each distinct tag.

    Args:
        tags: Tags to normalise. Must be a list of strings.

    Returns:
        A new list of normalised, de-duplicated tags. The input list is never
        modified.

    Raises:
        ValueError: If ``tags`` is not a list, or if any element is not a
            string.
    """
    if not isinstance(tags, list):
        raise ValueError(f"tags must be a list, got {type(tags).__name__}")

    normalized: list[str] = []
    seen: set[str] = set()

    for element in tags:
        if not isinstance(element, str):
            raise ValueError(
                f"tags must contain only strings, got {type(element).__name__}"
            )

        tag = element.strip().lower()
        if not tag:
            continue
        if tag in seen:
            continue

        seen.add(tag)
        normalized.append(tag)

    return normalized
