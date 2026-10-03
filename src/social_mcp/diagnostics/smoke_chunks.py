"""Deterministic fixed-size chunking helper used by diagnostics smoke checks."""

from __future__ import annotations

from itertools import islice
from typing import Iterable, TypeVar

__all__ = ["chunked"]

_T = TypeVar("_T")


def chunked(iterable: Iterable[_T], size: int) -> list[list[_T]]:
    """Split ``iterable`` into consecutive chunks of at most ``size`` items.

    Chunks are built in input order, every item is consumed exactly once, and
    the final chunk is allowed to be partial. The helper is side-effect free:
    it never modifies its input and returns fresh lists.

    Args:
        iterable: Any iterable, including lists, tuples, and one-shot
            iterators.
        size: Maximum number of items per chunk. Must be a positive integer.

    Returns:
        A list of lists holding the input items in their original order, or an
        empty list when ``iterable`` yields no items.

    Raises:
        ValueError: If ``size`` is not an integer or is not positive.
    """
    if isinstance(size, bool) or not isinstance(size, int):
        raise ValueError(f"size must be an integer, got {type(size).__name__}")
    if size < 1:
        raise ValueError(f"size must be positive, got {size}")

    iterator = iter(iterable)
    chunks: list[list[_T]] = []
    while True:
        chunk = list(islice(iterator, size))
        if not chunk:
            break
        chunks.append(chunk)
    return chunks
