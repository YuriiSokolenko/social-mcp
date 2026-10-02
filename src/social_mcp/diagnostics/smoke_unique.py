"""Stable de-duplication helper used by harness smoke checks."""


def stable_unique(items: list[str]) -> list[str]:
    """Return a new list with the first case-sensitive occurrence of each item.

    Original order is preserved; an empty input yields an empty list.
    """
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result
