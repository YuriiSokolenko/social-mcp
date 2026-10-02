"""Focused tests for :func:`social_mcp.diagnostics.smoke_clamp.clamp`."""

import pytest

from social_mcp.diagnostics.smoke_clamp import clamp


def test_clamp_returns_minimum_when_below_range() -> None:
    assert clamp(-5, 0, 10) == 0


def test_clamp_returns_maximum_when_above_range() -> None:
    assert clamp(42, 0, 10) == 10


def test_clamp_returns_value_within_range() -> None:
    assert clamp(7, 0, 10) == 7


def test_clamp_preserves_boundaries() -> None:
    assert clamp(0, 0, 10) == 0
    assert clamp(10, 0, 10) == 10


def test_clamp_supports_negative_ranges() -> None:
    assert clamp(-100, -10, -1) == -10
    assert clamp(0, -10, -1) == -1
    assert clamp(-5, -10, -1) == -5


def test_clamp_rejects_inverted_bounds() -> None:
    with pytest.raises(ValueError):
        clamp(1, 10, 0)
