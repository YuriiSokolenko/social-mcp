"""Async keyed single-flight primitive.

Multiple concurrent callers that use the same hashable key share a single
in-flight coroutine instead of starting duplicate work.  This is a small,
diagnostic-oriented concurrency primitive: it intentionally holds no
background workers and performs no caching across completed operations.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Hashable
from typing import Generic, TypeVar

__all__ = ["SingleFlight", "SingleFlightKeyError"]

T = TypeVar("T")
AsyncFactory = Callable[[], Awaitable[T]]


class SingleFlightKeyError(KeyError):
    """Raised when a key is not hashable."""


class _Entry(Generic[T]):
    """Bookkeeping for a single in-flight operation.

    One ``_Entry`` is shared by every caller using the same key.  The entry
    owns an :class:`asyncio.Event` that is set once the underlying operation
    has resolved (success or failure) and the resulting value/exception.  It
    also tracks how many waiters are still attached so the entry can be purged
    from the in-flight map once it is complete and no caller needs it.
    """

    __slots__ = ("event", "result", "exception", "waiters", "done_lock")

    def __init__(self) -> None:
        self.event: asyncio.Event = asyncio.Event()
        self.result: object = None
        self.exception: BaseException | None = None
        # ``waiters`` is mutated under ``done_lock`` so that detachment is
        # atomic even when a waiter is cancelled mid-await.
        self.waiters: int = 0
        self.done_lock: asyncio.Lock = asyncio.Lock()

    def done(self) -> bool:
        return self.event.is_set()

    def set_result(self, value: object) -> None:
        self.result = value
        self.event.set()

    def set_exception(self, exc: BaseException) -> None:
        self.exception = exc
        self.event.set()


class SingleFlight(Generic[T]):
    """Coordinate concurrent callers so that one operation serves a whole key.

    ``run`` executes the supplied factory under the given hashable key.  If an
    operation for that key is already in flight, all callers sharing the key
    await the same underlying result.  A completed operation is removed from
    the in-flight map, so callers may freely retry afterwards.

    Cancelling a waiter detaches it from the underlying task without
    cancelling the shared underlying operation while other waiters remain.
    """

    __slots__ = ("_inflight", "_map_lock")

    def __init__(self) -> None:
        # Maps key -> _Entry.  Entries are removed when the operation is
        # complete and no waiters remain.
        self._inflight: dict[Hashable, _Entry[T]] = {}
        # Serialises the check-then-create / attach race so that exactly one
        # caller becomes the owner of the underlying coroutine per key.
        self._map_lock = asyncio.Lock()

    def __len__(self) -> int:
        return len(self._inflight)

    async def run(
        self,
        key: Hashable,
        factory: AsyncFactory[T],
    ) -> T:
        """Run ``factory`` under ``key`` with single-flight coalescing.

        ``factory`` is an async factory callable.  Only the first caller for a
        given key invokes it; shared callers await the same result.  Raises
        ``SingleFlightKeyError`` if ``key`` is not hashable.
        """
        try:
            hash(key)
        except TypeError as exc:
            raise SingleFlightKeyError(str(exc)) from exc

        # Atomically attach to (or create) the entry for this key.  The first
        # caller to create the entry becomes the owner of the shared factory.
        async with self._map_lock:
            entry = self._inflight.get(key)
            if entry is None:
                entry = _Entry()
                entry.waiters = 1
                self._inflight[key] = entry
                owner = True
            else:
                entry.waiters += 1
                owner = False

        if owner:
            # Drive the shared operation to completion.  The task is never
            # cancelled by a waiter's cancellation, so all current (and
            # subsequent, before completion) waiters observe the outcome.
            loop = asyncio.get_event_loop()
            task = loop.create_task(self._run_factory(factory, entry))
            # Suppress "Task exception was never retrieved" warnings for the
            # owner task: exceptions are surfaced through the entry instead.
            task.add_done_callback(_suppress_retrieved)
        else:
            task = None  # waiters do not own the task

        try:
            await entry.event.wait()
        except asyncio.CancelledError:
            # A cancelled waiter detaches without cancelling the shared task.
            await self._detach(entry, key)
            raise

        await self._detach(entry, key)
        if task is not None:
            # The owner ensures the factory task has fully finished before
            # returning, so its outcome is already published on the entry.
            assert task.done()
        return self._collect(entry)

    @staticmethod
    async def _run_factory(
        factory: AsyncFactory[T],
        entry: _Entry[T],
    ) -> None:
        try:
            value = await factory()
            entry.set_result(value)
        except BaseException as exc:  # noqa: BLE001 - propagate to all waiters
            entry.set_exception(exc)

    def _collect(self, entry: _Entry[T]) -> T:
        # Non-destructive: every waiter sharing the entry must observe the same
        # result/exception.  Stale state is cleared when a fresh entry is
        # created in ``run`` instead.
        if entry.exception is not None:
            raise entry.exception
        return entry.result  # type: ignore[return-value]

    async def _detach(self, entry: _Entry[T], key: Hashable) -> None:
        async with entry.done_lock:
            entry.waiters -= 1
            finished = entry.done()
            waiters = entry.waiters
        # Pop only if still present (another path may have already removed or
        # reattached); avoid clobbering a fresh in-flight op for the same key.
        if finished and waiters <= 0:
            self._inflight.pop(key, None)

    async def purge(self) -> int:
        """Remove all completed entries that have no waiters.  Returns count.

        Exposed for diagnostics/testing; the helper also self-cleans as waiters
        detach.
        """
        removed = 0
        for key in list(self._inflight):
            entry = self._inflight[key]
            if entry.event.is_set() and entry.waiters <= 0:
                del self._inflight[key]
                removed += 1
        return removed


def _suppress_retrieved(task: "asyncio.Task[None]") -> None:
    """Avoid "Task exception was never retrieved" for owner tasks.

    Exceptions raised by the factory are published on the entry and re-raised
    by callers, so the owner task's own exception state is not the channel
    callers use; retrieve and discard it here to keep asyncio quiet.
    """
    if not task.done() or task.cancelled():
        return
    exc = task.exception()
    if isinstance(exc, BaseException):
        # Intentionally discarded: outcome is surfaced via the entry.
        pass
