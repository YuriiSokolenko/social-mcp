"""Focused tests for :func:`social_mcp.platforms.handles.normalize_handle`."""

from __future__ import annotations

import pytest

from social_mcp.platforms.handles import normalize_handle


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("alice", "alice"),
        ("@alice", "alice"),
        ("  @alice  ", "alice"),
        ("  alice  ", "alice"),
        ("@bob", "bob"),
        ("bob", "bob"),
    ],
)
def test_normalize_handle_accepts_valid_input(value: str, expected: str) -> None:
    assert normalize_handle(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "   ",
        "\t\n",
        "@",
    ],
)
def test_normalize_handle_rejects_empty_input(value: str) -> None:
    with pytest.raises(ValueError):
        normalize_handle(value)


@pytest.mark.parametrize(
    "value",
    [
        "@alice smith",
        "alice smith",
        "  alice smith  ",
    ],
)
def test_normalize_handle_rejects_internal_whitespace(value: str) -> None:
    with pytest.raises(ValueError):
        normalize_handle(value)


@pytest.mark.parametrize(
    "value",
    [
        "alice@example",
        "@alice@example",
        "@@alice",
    ],
)
def test_normalize_handle_rejects_additional_at(value: str) -> None:
    with pytest.raises(ValueError):
        normalize_handle(value)


@pytest.mark.parametrize(
    "value",
    [
        "https://example.com/user",
        "http://example.com/user",
        "ftp://example.com/user",
    ],
)
def test_normalize_handle_rejects_urls(value: str) -> None:
    with pytest.raises(ValueError):
        normalize_handle(value)


def test_normalize_handle_error_messages_are_clear() -> None:
    with pytest.raises(ValueError, match=r"empty"):
        normalize_handle("   ")
