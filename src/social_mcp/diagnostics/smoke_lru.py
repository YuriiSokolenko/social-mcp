"""Deterministic bounded LRU cache used to exercise stateful smoke checks.

This module is intentionally self-contained: it holds only local state on the
instance and never touches application state, so it is safe for workflow
smoke tests to construct and discard freely.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any, Iterator

__all__ = ["LRUCache"]


class LRUCache:
    """A bounded least-recently-used cache.

    Ordering is deterministic: the oldest inserted or accessed entry is the
    least-recently-used one. ``get`` promotes an existing key to
    most-recently-used, while membership checks do not affect recency; ``put``
    inserts or updates and evicts exactly one least-recently-used entry when
    the cache would exceed capacity.
    """

    def __init__(self, capacity: int) -> None:
        if isinstance(capacity, bool) or not isinstance(capacity, int):
            raise ValueError("capacity must be an integer")
        if capacity <= 0:
            raise ValueError("capacity must be a positive integer")
        self._capacity = capacity
        self._data: "OrderedDict[Any, Any]" = OrderedDict()

    @property
    def capacity(self) -> int:
        """Maximum number of entries held before eviction."""
        return self._capacity

    def get(self, key: Any, default: Any = None) -> Any:
        """Return the value for ``key``, promoting it, or ``default`` on a miss."""
        if key not in self._data:
            return default
        value = self._data.pop(key)
        self._data[key] = value
        return value

    def put(self, key: Any, value: Any) -> None:
        """Insert or update ``key``, promoting it and evicting overflow."""
        if key in self._data:
            self._data.pop(key)
        self._data[key] = value
        while len(self._data) > self._capacity:
            self._data.popitem(last=False)

    def __contains__(self, key: Any) -> bool:
        """Report whether ``key`` is present without promoting it."""
        return key in self._data

    def __len__(self) -> int:
        """Return the number of cached entries."""
        return len(self._data)

    def __iter__(self) -> Iterator[Any]:
        """Iterate keys from least-recently-used to most-recently-used."""
        return iter(self._data)

    def __repr__(self) -> str:
        return f"{type(self).__name__}(capacity={self._capacity}, size={len(self)})"
