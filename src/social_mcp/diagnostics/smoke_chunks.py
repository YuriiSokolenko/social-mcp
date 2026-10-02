"""Line chunking helper used by the harness smoke diagnostics.

The repository runs harness smoke checks that echo captured log lines back in
bounded batches. This module keeps that batching logic in one standalone,
dependency-free place so both production callers and tests can rely on it.
"""

from __future__ import annotations

__all__ = ["chunk_lines"]


def chunk_lines(lines: list[str], size: int) -> list[list[str]]:
    """Split ``lines`` into consecutive chunks of at most ``size`` items.

    Order is preserved and the final chunk may be shorter than ``size``. An
    empty input yields ``[]``. Each returned chunk is a new list, never an
    alias of ``lines`` or of another chunk, so callers may mutate them safely.

    Args:
        lines: The lines to split.
        size: Maximum number of lines allowed in a single chunk.

    Returns:
        A list of new lists holding the original lines in their original order.

    Raises:
        ValueError: If ``size`` is not a positive integer.
    """
    if size <= 0:
        raise ValueError(f"size must be a positive integer, got {size!r}")

    if not lines:
        return []

    return [list(lines[i : i + size]) for i in range(0, len(lines), size)]
