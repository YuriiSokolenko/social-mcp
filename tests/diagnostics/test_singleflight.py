"""Tests for the keyed async single-flight helper."""

import asyncio

import pytest

from social_mcp.diagnostics.singleflight import (
    SingleFlight,
    SingleFlightKeyError,
)


async def test_many_same_key_callers_share_one_execution() -> None:
    """Concurrent callers using the same key all observe one underlying run."""
    started = [0]
    finished = [0]

    async def factory() -> int:
        started[0] += 1
        await asyncio.sleep(0)
        finished[0] += 1
        return 42

    sf = SingleFlight[int]()
    results = await asyncio.gather(*[sf.run("key", factory) for _ in range(50)])

    assert started[0] == 1
    assert finished[0] == 1
    assert results == [42] * 50
    # The in-flight map is purged once everyone has detached.
    await asyncio.sleep(0)
    assert len(sf) == 0


async def test_different_keys_execute_independently() -> None:
    runs = [0]

    async def factory() -> int:
        runs[0] += 1
        return runs[0]

    sf = SingleFlight[int]()
    results = await asyncio.gather(
        sf.run("a", factory),
        sf.run("b", factory),
        sf.run("c", factory),
    )

    assert sorted(results) == [1, 2, 3]
    assert runs[0] == 3


async def test_exception_propagates_and_allows_retry() -> None:
    attempts = [0]

    async def factory() -> str:
        attempts[0] += 1
        if attempts[0] <= 2:
            raise ValueError(f"boom {attempts[0]}")
        return "ok"

    sf = SingleFlight[str]()

    # First call: several waiters all observe the same failure.
    outcomes = await asyncio.gather(
        *(sf.run("k", factory) for _ in range(10)),
        return_exceptions=True,
    )
    assert all(isinstance(o, ValueError) for o in outcomes)
    assert attempts[0] == 1
    assert len(sf) == 0  # cleaned up after the failed execution

    # A later call may retry and eventually succeed.  Each retry is a fresh
    # single-flight execution for the same key.
    result: str = None  # type: ignore[assignment]
    for _ in range(5):
        try:
            result = await sf.run("k", factory)
            break
        except ValueError:
            continue
    assert result == "ok"
    assert attempts[0] == 3


async def test_cancelling_one_waiter_does_not_cancel_shared_op() -> None:
    cancelled_during_sleep = [False]

    async def factory() -> str:
        try:
            await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            cancelled_during_sleep[0] = True
            raise
        return "done"

    sf = SingleFlight[str]()

    async def caller() -> str:
        return await sf.run("k", factory)

    task_other = asyncio.create_task(caller())
    # Let the shared operation begin and attach as a waiter.
    await asyncio.sleep(0.01)
    task_victim = asyncio.create_task(caller())
    await asyncio.sleep(0.01)

    task_victim.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task_victim

    # The shared operation is unaffected; the other waiter still succeeds.
    result = await task_other
    assert result == "done"
    assert not cancelled_during_sleep[0]
    assert len(sf) == 0


async def test_cleanup_after_success() -> None:
    async def factory() -> int:
        return 7

    sf = SingleFlight[int]()
    assert len(sf) == 0
    result = await sf.run("k", factory)
    assert result == 7
    assert len(sf) == 0


async def test_cleanup_after_failure() -> None:
    async def factory() -> int:
        raise RuntimeError("nope")

    sf = SingleFlight[int]()
    with pytest.raises(RuntimeError, match="nope"):
        await sf.run("k", factory)
    assert len(sf) == 0


async def test_no_background_workers_survive() -> None:
    """After all callers finish, no extra tasks remain for the key."""

    async def factory() -> int:
        return 1

    sf = SingleFlight[int]()
    await sf.run("k", factory)

    # Allow any pending callbacks to settle.
    for _ in range(5):
        await asyncio.sleep(0)
    # No entry lingers.
    assert len(sf) == 0


def test_unhashable_key_raises_sf_error() -> None:
    async def factory() -> int:
        return 1

    sf = SingleFlight[int]()

    async def driver() -> None:
        await sf.run([], factory)

    with pytest.raises(SingleFlightKeyError):
        asyncio.new_event_loop().run_until_complete(driver())


def test_singleflight_error_is_keyerror_subclass() -> None:
    assert issubclass(SingleFlightKeyError, KeyError)
