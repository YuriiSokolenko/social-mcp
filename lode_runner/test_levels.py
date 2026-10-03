"""Smoke tests for the level definitions (full suite: ``tests/test_lode_runner.py``)."""

from lode_runner.levels import load_levels


def test_levels_load():
    assert len(load_levels()) == 10
