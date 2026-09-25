"""Tests for normalized MCP error categories and the ``McpError`` type.

Issue #18 requires stable, secret-free error categories so an MCP client can
branch on category rather than parsing platform responses. The ``McpError``
type is raised by tools; the upstream MCP SDK converts it into an
``is_error=True`` result. These tests pin the category set and the helper
constructors.
"""

from __future__ import annotations

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from social_mcp.server.errors import (
    AUTHENTICATION_REQUIRED,
    CAPABILITY_UNAVAILABLE,
    INVALID_REQUEST,
    NOT_FOUND,
    PERMISSION_REQUIRED,
    PLATFORM_ERROR,
    RATE_LIMITED,
    SUPPORTED_CATEGORIES,
    TEMPORARY_FAILURE,
    McpError,
    authentication_required,
    capability_unavailable,
    error_response,
    invalid_request,
    permission_required,
)


def test_all_contract_categories_are_present() -> None:
    expected = {
        AUTHENTICATION_REQUIRED,
        PERMISSION_REQUIRED,
        CAPABILITY_UNAVAILABLE,
        INVALID_REQUEST,
        NOT_FOUND,
        RATE_LIMITED,
        PLATFORM_ERROR,
        TEMPORARY_FAILURE,
    }
    assert set(SUPPORTED_CATEGORIES) == expected
    assert SUPPORTED_CATEGORIES == frozenset(SUPPORTED_CATEGORIES)


@pytest.mark.parametrize("category", sorted(SUPPORTED_CATEGORIES))
def test_mcp_error_str_formats_category_and_message(category) -> None:
    error = McpError(category=category, message="something happened")
    assert str(error) == f"[{category}] something happened"
    assert error.category == category
    assert error.message == "something happened"


def test_mcp_error_is_a_tool_error() -> None:
    # The upstream SDK only converts ToolError instances into is_error results.
    assert isinstance(McpError(category=AUTHENTICATION_REQUIRED, message="x"), ToolError)


def test_mcp_error_is_frozen() -> None:
    error = McpError(category=AUTHENTICATION_REQUIRED, message="x")
    with pytest.raises((AttributeError, TypeError)):
        error.category = PERMISSION_REQUIRED  # type: ignore[misc]


def test_unknown_category_is_rejected() -> None:
    with pytest.raises(ValueError, match="Unknown MCP error category"):
        McpError(category="not_a_real_category", message="x")


def test_empty_message_is_rejected() -> None:
    with pytest.raises(ValueError, match="error message is required"):
        error_response(AUTHENTICATION_REQUIRED, "")


@pytest.mark.parametrize(
    "helper,category",
    [
        (authentication_required, AUTHENTICATION_REQUIRED),
        (permission_required, PERMISSION_REQUIRED),
        (capability_unavailable, CAPABILITY_UNAVAILABLE),
        (invalid_request, INVALID_REQUEST),
    ],
)
def test_helper_constructors_set_category(helper, category) -> None:
    error = helper("do a thing")
    assert isinstance(error, McpError)
    assert error.category == category
    assert error.message == "do a thing"


def test_error_response_is_stable_formatted_string() -> None:
    assert error_response(AUTHENTICATION_REQUIRED, "connect an account") == (
        f"[{AUTHENTICATION_REQUIRED}] connect an account"
    )


def test_error_response_rejects_unknown_category() -> None:
    with pytest.raises(ValueError, match="Unknown MCP error category"):
        error_response("bogus", "msg")


def test_error_message_has_no_token_fields() -> None:
    # McpError carries only category + message (no token-bearing attributes).
    error = McpError(category=AUTHENTICATION_REQUIRED, message="connect an account")
    assert error.category in SUPPORTED_CATEGORIES
    assert not hasattr(error, "access_token")
    assert not hasattr(error, "refresh_token")
    assert error.__dataclass_fields__.keys() == {"category", "message"}  # no token fields
