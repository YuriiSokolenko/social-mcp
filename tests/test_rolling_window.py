"""Focused tests for :class:`social_mcp.diagnostics.rolling_window.RollingWindow`.

The tests use an injected fake clock so every scenario is deterministic and
independent of the real system clock.
"""

from __future__ import annotations

import unittest

# The package is importable because pytest is configured with
# ``pythonpath = ["src"]`` (see pyproject.toml). The import below is therefore
# safe to place at the top of the module and satisfies E402.
from social_mcp.diagnostics.rolling_window import RollingWindow


class FakeClock:
    """Deterministic monotonic clock with manual time advancement."""

    def __init__(self, start: float = 0.0) -> None:
        self._t = float(start)

    def __call__(self) -> float:
        return self._t

    def advance(self, seconds: float) -> None:
        self._t += float(seconds)

    @property
    def now(self) -> float:
        return self._t


class RollingWindowTests(unittest.TestCase):
    def test_empty_state(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=10.0, clock=clock)
        self.assertEqual(window.total_count(), 0)
        self.assertEqual(window.count("any"), 0)
        self.assertEqual(window.categories(), {})
        self.assertEqual(len(window), 0)

    def test_multiple_categories(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=10.0, clock=clock)
        window.record("requests", 3)
        window.record("errors", 1)
        window.record("requests", 2)
        self.assertEqual(window.total_count(), 6)
        self.assertEqual(window.count("requests"), 5)
        self.assertEqual(window.count("errors"), 1)
        self.assertEqual(window.count("missing"), 0)
        cats = window.categories()
        self.assertEqual(cats, {"requests": 5, "errors": 1})
        # Mutating the returned snapshot must not affect the window.
        cats["requests"] = 999
        self.assertEqual(window.count("requests"), 5)

    def test_expiration_as_time_advances(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=5.0, clock=clock)
        window.record("a", 2)
        window.record("b", 1)
        self.assertEqual(window.total_count(), 3)
        # Advance to exactly the boundary where "a"/"b" (recorded at t=0) are
        # still in-window at t=5 because the boundary is inclusive.
        clock.advance(5.0)
        self.assertEqual(window.total_count(), 3)
        self.assertEqual(window.categories(), {"a": 2, "b": 1})
        # One tick further: everything recorded at t=0 is now strictly older
        # than the window and is pruned.
        clock.advance(0.001)
        self.assertEqual(window.total_count(), 0)
        self.assertEqual(window.categories(), {})

    def test_exact_boundary_semantics(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=10.0, clock=clock)
        window.record("events", 1)
        # Event recorded at t=0. At t=10 it is still in-window (inclusive).
        clock.advance(10.0)
        self.assertEqual(window.count("events"), 1)
        self.assertEqual(window.total_count(), 1)
        # At t=10 + epsilon it is strictly outside the window and pruned.
        clock.advance(1e-9)
        self.assertEqual(window.count("events"), 0)
        self.assertEqual(window.total_count(), 0)

    def test_large_batch_then_pruning(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=3.0, clock=clock)
        window.record("bulk", 5000)
        self.assertEqual(window.total_count(), 5000)
        # Advance past the window; all events expire and are pruned in bulk.
        clock.advance(3.0 + 1e-9)
        self.assertEqual(window.prune(), 5000)
        self.assertEqual(window.total_count(), 0)
        # Adding more after expiry does not leave stale entries behind.
        window.record("fresh", 4)
        self.assertEqual(window.total_count(), 4)
        self.assertEqual(window.count("fresh"), 4)
        self.assertEqual(window.count("bulk"), 0)

    def test_prune_does_not_grow_when_time_advances_without_events(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=2.0, clock=clock)
        window.record("x", 10)
        # First advance expiring all events returns the count removed.
        clock.advance(100.0)
        self.assertEqual(window.prune(), 10)
        self.assertEqual(window.total_count(), 0)
        # Repeatedly advancing time far into the future must not accumulate state
        # or grow the internal structures unboundedly; every subsequent prune
        # finds nothing to remove.
        for _ in range(1000):
            clock.advance(100.0)
            self.assertEqual(window.prune(), 0)
        self.assertEqual(window.total_count(), 0)
        self.assertEqual(window.count("x"), 0)
        self.assertEqual(window.categories(), {})

    def test_explicit_timestamp(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=10.0, clock=clock)
        # Record using an explicit timestamp while the clock stays put.
        window.record("manual", 1, timestamp=5.0)
        clock.advance(5.0)  # now t=5 -> event at t=5 is on the boundary -> kept
        self.assertEqual(window.count("manual"), 1)
        clock.advance(5.0)  # now t=10 -> still within window of t=5 (<=10)
        self.assertEqual(window.count("manual"), 1)
        clock.advance(5.0 + 1e-9)  # now t=15+eps -> strictly outside window of t=5
        self.assertEqual(window.count("manual"), 0)

    def test_count_unknown_category_does_not_create_it(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=10.0, clock=clock)
        window.record("known", 1)
        self.assertEqual(window.count("unknown"), 0)
        self.assertNotIn("unknown", window.categories())

    def test_total_count_query_does_not_leak_state(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=5.0, clock=clock)
        window.record("a", 1)
        # Repeated queries without new events must not change counts.
        for _ in range(50):
            self.assertEqual(window.total_count(), 1)
            self.assertEqual(window.count("a"), 1)

    def test_window_seconds_property(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=7.5, clock=clock)
        self.assertEqual(window.window_seconds, 7.5)
        self.assertIs(window.now, clock)  # now returns the clock result type

    def test_rejects_invalid_window_sizes(self):
        clock = FakeClock()
        with self.assertRaises(ValueError):
            RollingWindow(window_seconds=0, clock=clock)
        with self.assertRaises(ValueError):
            RollingWindow(window_seconds=-1, clock=clock)
        with self.assertRaises(ValueError):
            RollingWindow(window_seconds=float("nan"), clock=clock)
        with self.assertRaises(ValueError):
            RollingWindow(window_seconds=float("inf"), clock=clock)
        with self.assertRaises(ValueError):
            RollingWindow(window_seconds=float("-inf"), clock=clock)

    def test_rejects_non_numeric_window_sizes(self):
        clock = FakeClock()
        with self.assertRaises(TypeError):
            RollingWindow(window_seconds="10", clock=clock)
        with self.assertRaises(TypeError):
            RollingWindow(window_seconds=None, clock=clock)
        with self.assertRaises(TypeError):
            RollingWindow(window_seconds=True, clock=clock)  # bool rejected

    def test_record_rejects_invalid_inputs(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=10.0, clock=clock)
        with self.assertRaises(ValueError):
            window.record("", 1)
        with self.assertRaises(TypeError):
            window.record(123, 1)  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            window.record("ok", count=1.5)  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            window.record("ok", count=True)  # bool rejected
        with self.assertRaises(ValueError):
            window.record("ok", count=-1)

    def test_count_rejects_non_string_category(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=10.0, clock=clock)
        with self.assertRaises(TypeError):
            window.count(42)  # type: ignore[arg-type]

    def test_records_use_default_clock_when_clock_omitted(self):
        # Smoke test that omitting the clock works (uses real monotonic time).
        window = RollingWindow(window_seconds=1.0)
        window.record("default-clock", 1)
        self.assertEqual(window.total_count(), 1)

    def test_repr_contains_window_and_total(self):
        clock = FakeClock()
        window = RollingWindow(window_seconds=10.0, clock=clock)
        window.record("x", 2)
        text = repr(window)
        self.assertIn("window_seconds=10.0", text)
        self.assertIn("total=2", text)


class FakeClockDeterminismTests(unittest.TestCase):
    """Verify the same sequence of fake-clock operations is fully deterministic."""

    def test_deterministic_results_on_replay(self):
        def run() -> dict:
            clock = FakeClock()
            window = RollingWindow(window_seconds=5.0, clock=clock)
            window.record("a", 2)
            clock.advance(2.0)
            window.record("b", 3)
            clock.advance(4.0)
            return window.categories()

        self.assertEqual(run(), run())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
