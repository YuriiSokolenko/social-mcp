"""Deterministic rolling-window event counter for lightweight in-process diagnostics.

Provides :class:`RollingWindow`, a bounded time-window counter that groups
timestamped events by string category and discards events older than a
configurable window measured against a monotonic clock. The clock is injected
so tests can use a deterministic fake clock.

Window boundary semantics follow the half-open interval ``[t - window, t]``:
an event recorded at time ``t`` is still within the window at time ``t'`` when
``t' - t <= window``. An event recorded exactly on the boundary
(``t' - t == window``) is therefore still counted; only events strictly older
than the window are pruned.

Only the Python standard library is used.
"""

from __future__ import annotations

import bisect
import math
import threading
import time
from collections import defaultdict
from typing import Callable, Dict, List, Optional


class RollingWindow:
    """Bounded time-window event counter with an injectable monotonic clock.

    Records timestamped events grouped by string category and maintains only
    the events that fall within a fixed-duration sliding window measured
    against a monotonic clock. Events older than the configured window are
    discarded automatically.

    The clock is injected (a zero-argument callable returning a float) so that
    tests can supply a deterministic fake clock and avoid dependence on the real
    system clock.

    Thread safety: read and write operations are guarded by an internal lock so
    that a :class:`RollingWindow` instance may be shared across threads.
    """

    def __init__(
        self,
        window_seconds: float,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        """Initialize the rolling window.

        Args:
            window_seconds: Duration of the sliding window in seconds. Must be a
                finite, positive, non-NaN real number. Zero, negative, NaN and
                infinite values raise ``ValueError``; non-real types raise
                ``TypeError``. Booleans are rejected even though they are a
                subclass of ``int``.
            clock: Optional zero-argument callable returning the current
                monotonic time as a float. When omitted,
                :func:`time.monotonic` is used.

        Raises:
            TypeError: If ``window_seconds`` is not a real number.
            ValueError: If ``window_seconds`` is not a finite positive number.
        """
        # Reject non-real types (including bool) early. bool is a subclass of
        # int but is not a meaningful window size.
        if isinstance(window_seconds, bool) or not isinstance(
            window_seconds, (int, float)
        ):
            raise TypeError(
                "window_seconds must be a real number, not "
                f"{type(window_seconds).__name__}",
            )
        if isinstance(window_seconds, float):
            if math.isnan(window_seconds) or math.isinf(window_seconds):
                raise ValueError(
                    f"window_seconds must be finite; got {window_seconds}",
                )
        if window_seconds <= 0:
            raise ValueError(f"window_seconds must be positive; got {window_seconds}")

        self._window_seconds: float = float(window_seconds)
        self._clock: Callable[[], float] = clock if clock is not None else time.monotonic
        # Timestamps are kept sorted because the clock is monotonic and we only
        # ever append during record(). Sorting invariant lets us prune with
        # bisect in O(log n) without a full scan.
        self._events: List[float] = []
        self._counts: Dict[str, List[float]] = defaultdict(list)
        self._lock = threading.RLock()

    @property
    def window_seconds(self) -> float:
        """Return the configured window duration in seconds."""
        return self._window_seconds

    @property
    def now(self) -> float:
        """Return the current reading from the configured clock.

        Exposed as a property so callers and tests can observe the clock value
        the window would use without sampling it twice or reaching into private
        internals.
        """
        return self._clock()

    def _prune(self, current_time: float) -> None:
        """Discard events strictly older than the window boundary.

        Pruning is relative to ``current_time`` using the half-open boundary
        ``cutoff = current_time - window``. An event at exactly ``cutoff`` is
        retained because ``current_time - cutoff == window`` is still within
        the window; only events strictly older (``t < cutoff``) are removed.
        """
        cutoff = current_time - self._window_seconds
        events = self._events
        if events:
            # bisect_left keeps the boundary event (it is retained); anything
            # strictly to its left is discarded.
            idx = bisect.bisect_left(events, cutoff)
            if idx > 0:
                del events[:idx]
        for timestamps in self._counts.values():
            if not timestamps:
                continue
            idx = bisect.bisect_left(timestamps, cutoff)
            if idx > 0:
                del timestamps[:idx]

    def record(
        self,
        category: str,
        count: int = 1,
        timestamp: Optional[float] = None,
    ) -> None:
        """Record one or more events for a category.

        Args:
            category: Non-empty string identifying the event category.
            count: Number of events to record; must be a non-negative integer.
            timestamp: Optional explicit timestamp for the event(s). When
                ``None`` (the default) the current clock reading is sampled at
                the moment of recording.

        Raises:
            TypeError: If ``category`` is not a string or ``count`` is not an
                integer.
            ValueError: If ``count`` is negative or ``category`` is empty.
        """
        if not isinstance(category, str):
            raise TypeError(
                f"category must be a string, not {type(category).__name__}",
            )
        if category == "":
            raise ValueError("category must be a non-empty string")
        # bool is a subclass of int but is not a valid count.
        if isinstance(count, bool) or not isinstance(count, int):
            raise TypeError(f"count must be an integer, not {type(count).__name__}")
        if count < 0:
            raise ValueError(f"count must be non-negative, got {count}")
        if count == 0:
            return

        with self._lock:
            event_time = self._clock() if timestamp is None else timestamp
            self._events.extend([event_time] * count)
            self._counts[category].extend([event_time] * count)
            self._prune(event_time)

    def prune(self, current_time: Optional[float] = None) -> int:
        """Remove expired events relative to a reference time.

        Args:
            current_time: Reference time for pruning. When ``None`` the current
                clock reading is used.

        Returns:
            The number of events removed (always >= 0). Querying-only pruning
            does not change externally visible state beyond normal expiration.
        """
        with self._lock:
            before = len(self._events)
            if current_time is None:
                current_time = self._clock()
            self._prune(current_time)
            return before - len(self._events)

    def total_count(self, current_time: Optional[float] = None) -> int:
        """Return the number of events currently held in the window.

        Prunes expired events as part of the read.
        """
        with self._lock:
            if current_time is None:
                current_time = self._clock()
            self._prune(current_time)
            return len(self._events)

    def count(self, category: str, current_time: Optional[float] = None) -> int:
        """Return the number of in-window events for ``category``.

        Raises:
            TypeError: If ``category`` is not a string.
        """
        if not isinstance(category, str):
            raise TypeError(
                f"category must be a string, not {type(category).__name__}",
            )
        with self._lock:
            if current_time is None:
                current_time = self._clock()
            self._prune(current_time)
            return len(self._counts.get(category, ()))

    def categories(self, current_time: Optional[float] = None) -> Dict[str, int]:
        """Return a mapping of category name to in-window count.

        Categories with zero in-window events are omitted. The returned mapping
        is a fresh ``dict`` and may be mutated by the caller without affecting
        the window. Pruning of expired events occurs as part of the read.
        """
        with self._lock:
            if current_time is None:
                current_time = self._clock()
            self._prune(current_time)
            return {
                category: len(timestamps)
                for category, timestamps in self._counts.items()
                if timestamps
            }

    def __len__(self) -> int:
        """Return the total in-window event count (prune on read)."""
        return self.total_count()

    def __repr__(self) -> str:
        with self._lock:
            return (
                f"RollingWindow(window_seconds={self._window_seconds!r}, "
                f"total={len(self._events)})"
            )
