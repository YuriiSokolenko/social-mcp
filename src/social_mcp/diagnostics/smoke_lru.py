"""Bounded least-recently-used cache used by workflow smoke checks.

This module is intentionally self-contained and side-effect free so smoke
checks can exercise stateful behaviour without touching application state.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any, Iterator

__all__ = ["LRUCache"]


class LRUCache:
    """A fixed-capacity cache that evicts its least-recently-used entry."""

    def __init__(self, capacity: int) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool):
            raise ValueError("capacity must be a positive integer")
        if capacity <= 0:
            raise ValueError("capacity must be a positive integer")
        self._capacity = capacity
        self._values: "OrderedDict[Any, Any]" = OrderedDict()

    @property
    def capacity(self) -> int:
        return self._capacity

    def __len__(self) -> int:
        return len(self._values)

    def __contains__(self, key: Any) -> bool:
        return key in self._values

    def __iter__(self) -> Iterator[Any]:
        return iter(self._values)

    def get(self, key: Any, default: Any = None) -> Any:
        """Return the value for ``key`` and mark it most-recently used."""
        try:
            value = self._values[key]
        except KeyError:
            return default
        self._values.move_to_end(key)
        return value

    def put(self, key: Any, value: Any) -> None:
        """Store ``value``, promoting an existing key or evicting the LRU."""
        if key in self._values:
            self._values[key] = value
            self._values.move_to_end(key)
            return
        self._values[key] = value
        while len(self._values) > self._capacity:
            self._values.popitem(last=False)

    def clear(self) -> None:
        self._values.clear()

    def keys(self) -> list[Any]:
        """Return cached keys from least-recently used to most-recently used."""
        return list(self._values)
