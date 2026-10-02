"""Whitespace helpers used by harness smoke checks."""

from __future__ import annotations

__all__ = ["normalize_spaces"]


def normalize_spaces(text: str) -> str:
    """Collapse each run of whitespace to a single ASCII space.

    Leading and trailing whitespace is stripped, non-whitespace characters are
    preserved exactly, and empty or all-whitespace input returns ``""``.
    """
    return " ".join(text.split())
