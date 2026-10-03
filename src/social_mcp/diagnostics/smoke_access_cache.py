"""Pure access-ordered cache state helper for diagnostics smoke checks.

The helper is deterministic: it never reads the clock, spawns threads, or
mutates any external state. All behaviour is a function of its arguments and
of the access order recorded in the instance.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any

__all__ = ["AccessCache"]


class AccessCache:
    """Deterministic least-recently-used cache of key/value pairs.

    A cached entry is promoted to most-recently-used whenever an existing key
    is accessed or updated. Inserting a new key beyond capacity evicts exactly
    the least-recently-used key.

    Args:
        capacity: Maximum number of entries retained by the cache.

    Raises:
        ValueError: If ``capacity`` is not an ``int`` or is not strictly
            positive.
    """

    def __init__(self, capacity: int) -> None:
        if isinstance(capacity, bool) or not isinstance(capacity, int):
            raise ValueError("capacity must be an integer")
        if capacity <= 0:
            raise ValueError("capacity must be positive")

        self._capacity = capacity
        self._entries: "OrderedDict[Any, Any]" = OrderedDict()

    @property
    def capacity(self) -> int:
        """Return the fixed number of entries the cache may hold."""
        return self._capacity

    def get(self, key: Any, default: Any = None) -> Any:
        """Return the value for ``key``, promoting it to most-recently-used.

        Args:
            key: Hashable cache key.
                default: Value returned when ``key`` is absent, which does not
                change the cache contents or access order.

        Returns:
            The cached value, or ``default`` when the key is absent.
        """
        try:
            value = self._entries[key]
        except KeyError:
            return default

        self._entries.move_to_end(key)
        return value

    def put(self, key: Any, value: Any) -> None:
        """Store ``value`` under ``key`` as the most-recently-used entry.

        An existing key has its value replaced and is promoted without
        changing the cache size. A new key that exceeds capacity evicts exactly
        the least-recently-used key.

        Args:
            key: Hashable cache key.
            value: Value to store for ``key``.
        """
        if key in self._entries:
            self._entries[key] = value
            self._entries.move_to_end(key)
            return

        self._entries[key] = value
        while len(self._entries) > self._capacity:
            self._entries.popitem(last=False)

    def __contains__(self, key: Any) -> bool:
        """Return whether ``key`` is cached without changing access order."""
        return key in self._entries

    def __len__(self) -> int:
        """Return the number of cached entries."""
        return len(self._entries)

    def __repr__(self) -> str:
        return f"AccessCache(capacity={self._capacity}, size={len(self._entries)})"
