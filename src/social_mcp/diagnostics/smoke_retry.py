"""Deterministic retry delay schedules for harness smoke checks."""

from __future__ import annotations

__all__ = ["retry_delays"]


def retry_delays(attempts: int, base_seconds: float, max_seconds: float) -> list[float]:
    """Return one capped exponential backoff delay per attempt.

    Delay ``n`` (zero-based) is ``base_seconds * 2 ** n`` capped at
    ``max_seconds``. The schedule is deterministic: no jitter is applied.

    Raises:
        ValueError: If ``attempts``, ``base_seconds``, or ``max_seconds``
            is negative.
    """
    for name, value in (
        ("attempts", attempts),
        ("base_seconds", base_seconds),
        ("max_seconds", max_seconds),
    ):
        if value < 0:
            raise ValueError(f"{name} must be non-negative, got {value!r}")

    return [min(base_seconds * (2.0**n), max_seconds) for n in range(attempts)]
