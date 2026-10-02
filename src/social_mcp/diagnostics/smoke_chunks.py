"""Deterministic helper for splitting an iterable into fixed-size chunks."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

__all__ = ["chunked"]


def chunked(iterable: Iterable[Any], size: int) -> list[list[Any]]:
    """Split ``iterable`` into consecutive lists of at most ``size`` items.

    Input order is preserved and every item is consumed exactly once, so
    one-shot iterators are supported. A short final group is returned as a
    partial chunk; empty input yields an empty list.

    Args:
        iterable: Any iterable of items.
        size: Maximum chunk length. Must be a positive integer.

    Returns:
        A list of lists holding the input items in order.

    Raises:
        ValueError: If ``size`` is not an integer or is not positive.
    """

    if isinstance(size, bool) or not isinstance(size, int):
        raise ValueError("chunk size must be an integer")
    if size < 1:
        raise ValueError("chunk size must be positive")

    iterator = iter(iterable)
    chunks: list[list[Any]] = []
    while True:
        chunk = []
        for item in iterator:
            chunk.append(item)
            if len(chunk) == size:
                break
        if not chunk:
            break
        chunks.append(chunk)

    return chunks
