"""Focused coverage for the smoke ratio helper."""

import pytest

from social_mcp.diagnostics.smoke_ratio import safe_ratio


def test_safe_ratio_returns_quotient_for_non_zero_denominator() -> None:
    assert safe_ratio(10.0, 4.0) == 2.5


def test_safe_ratio_does_not_round_result() -> None:
    assert safe_ratio(1.0, 3.0) == 1.0 / 3.0


def test_safe_ratio_handles_negative_and_float_values() -> None:
    assert safe_ratio(-7.5, 2.0) == -3.75


def test_safe_ratio_zero_denominator_returns_default_zero() -> None:
    assert safe_ratio(10.0, 0.0) == 0.0


def test_safe_ratio_zero_denominator_returns_custom_default() -> None:
    assert safe_ratio(10.0, 0.0, default=-1.5) == -1.5


def test_safe_ratio_zero_denominator_default_ignores_numerator() -> None:
    assert safe_ratio(0.0, 0.0, default=3.0) == 3.0


@pytest.mark.parametrize("numerator", [0, 0.0])
def test_safe_ratio_zero_numerator_with_non_zero_denominator(numerator: float) -> None:
    assert safe_ratio(numerator, 2.0, default=9.0) == 0.0
