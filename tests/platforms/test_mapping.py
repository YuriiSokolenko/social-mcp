"""Tests for normalized platform error mapping (issue #94).

Covers the adapter-boundary translation between platform HTTP/OAuth errors and
the stable MCP error categories, plus secret redaction. No real network or
social API access is involved.
"""

from __future__ import annotations

import pytest

from social_mcp.platforms.mapping import (
    AdminError,
    normalize_error,
    normalize_http_status,
    redact_message,
    to_admin_error,
    to_mcp_error,
)
from social_mcp.platforms.reliability import (
    PlatformHttpError,
    RateLimitError,
    TransientError,
)
from social_mcp.server.errors import (
    AUTHENTICATION_REQUIRED,
    INVALID_REQUEST,
    NOT_FOUND,
    PERMISSION_REQUIRED,
    PLATFORM_ERROR,
    RATE_LIMITED,
    SUPPORTED_CATEGORIES,
    TEMPORARY_FAILURE,
    McpError,
)


@pytest.mark.parametrize(
    "status,expected",
    [
        (401, AUTHENTICATION_REQUIRED),
        (403, PERMISSION_REQUIRED),
        (404, NOT_FOUND),
        (400, INVALID_REQUEST),
        (422, INVALID_REQUEST),
        (500, TEMPORARY_FAILURE),
        (501, TEMPORARY_FAILURE),
        (429, RATE_LIMITED),
        (408, TEMPORARY_FAILURE),
        (425, TEMPORARY_FAILURE),
        (502, TEMPORARY_FAILURE),
        (503, TEMPORARY_FAILURE),
        (504, TEMPORARY_FAILURE),
        (999, PLATFORM_ERROR),
        (200, PLATFORM_ERROR),
    ],
)
def test_normalize_http_status_maps_to_category(status, expected) -> None:
    assert normalize_http_status(status) == expected


def test_normalize_http_status_only_returns_supported_categories() -> None:
    for status in range(100, 600):
        assert normalize_http_status(status) in SUPPORTED_CATEGORIES


def test_rate_limit_error_maps_to_rate_limited() -> None:
    normalized = normalize_error(RateLimitError("rate limited", status_code=429))
    assert normalized.category == RATE_LIMITED
    assert "rate limited" in normalized.detail


def test_transient_error_maps_to_temporary_failure() -> None:
    normalized = normalize_error(TransientError("service unavailable", status_code=503))
    assert normalized.category == TEMPORARY_FAILURE
    assert "503" in normalized.detail


def test_transient_error_without_status_omits_code_in_detail() -> None:
    normalized = normalize_error(TransientError("network error"))
    assert normalized.category == TEMPORARY_FAILURE
    assert normalized.detail == "transient failure"


def test_platform_http_error_404_maps_to_not_found() -> None:
    normalized = normalize_error(PlatformHttpError("profile not found", status_code=404))
    assert normalized.category == NOT_FOUND


def test_platform_http_error_401_is_authentication_required() -> None:
    normalized = normalize_error(PlatformHttpError("invalid token", status_code=401))
    assert normalized.category == AUTHENTICATION_REQUIRED


def test_platform_http_error_403_is_permission_required() -> None:
    normalized = normalize_error(PlatformHttpError("missing scope", status_code=403))
    assert normalized.category == PERMISSION_REQUIRED


def test_platform_http_error_without_status_is_temporary_failure() -> None:
    normalized = normalize_error(PlatformHttpError("no response", status_code=None))
    assert normalized.category == TEMPORARY_FAILURE


def test_platform_http_error_500_is_temporary_failure() -> None:
    normalized = normalize_error(PlatformHttpError("internal error", status_code=500))
    assert normalized.category == TEMPORARY_FAILURE


def test_oauth_error_bad_code_maps_to_invalid_request() -> None:
    normalized = normalize_error(ValueError("Matching code was not found"))
    assert normalized.category == INVALID_REQUEST


def test_oauth_error_expired_token_maps_to_authentication_required() -> None:
    normalized = normalize_error(ValueError("The access token expired"))
    assert normalized.category == AUTHENTICATION_REQUIRED


def test_oauth_error_missing_maps_to_invalid_request() -> None:
    normalized = normalize_error(ValueError("Missing access token"))
    assert normalized.category == INVALID_REQUEST


def test_unknown_exception_falls_back_to_platform_error() -> None:
    normalized = normalize_error(RuntimeError("unexpected"))
    assert normalized.category == PLATFORM_ERROR


def test_normalized_error_has_no_token_attributes() -> None:
    normalized = normalize_error(PlatformHttpError("x", status_code=404))
    assert normalized.__dataclass_fields__.keys() == {"category", "message", "detail"}


# --- redaction ---------------------------------------------------------------


def test_redact_message_strips_bearer_credentials() -> None:
    assert redact_message("Bearer abc123.def.ghi") == "Bearer REDACTED"


def test_redact_message_strips_basic_credentials() -> None:
    assert redact_message("Basic dXNlcjpwYXNz") == "Basic REDACTED"


def test_redact_message_strips_bearer_in_sentence() -> None:
    msg = "Token Bearer abc.def.ghi is invalid for client"
    assert redact_message(msg) == "Token Bearer REDACTED is invalid for client"


def test_redact_message_strips_sensitive_key_value_pairs() -> None:
    msg = "access_token=abc123 refresh_token=def456 code=xyz"
    redacted = redact_message(msg)
    assert "abc123" not in redacted
    assert "def456" not in redacted
    assert "xyz" not in redacted
    assert redacted == "access_token=REDACTED refresh_token=REDACTED code=REDACTED"


def test_redact_message_preserves_non_sensitive_key_value_pairs() -> None:
    msg = "platform=threads status=ok"
    assert redact_message(msg) == "platform=threads status=ok"


def test_redact_message_preserves_plain_text_without_tokens() -> None:
    assert redact_message("The requested resource was not found.") == (
        "The requested resource was not found."
    )


def test_redact_message_empty_string_returns_empty() -> None:
    assert redact_message("") == ""


def test_normalized_error_detail_is_redacted() -> None:
    exc = PlatformHttpError("access_token=secret123 bad", status_code=401)
    normalized = normalize_error(exc)
    assert "secret123" not in normalized.detail


# --- to_mcp_error ------------------------------------------------------------


def test_to_mcp_error_returns_mcp_error() -> None:
    mcp_error = to_mcp_error(PlatformHttpError("not found", status_code=404))
    assert isinstance(mcp_error, McpError)
    assert mcp_error.category == NOT_FOUND


def test_to_mcp_error_authentication() -> None:
    assert to_mcp_error(PlatformHttpError("invalid token", status_code=401)).category == (
        AUTHENTICATION_REQUIRED
    )


def test_to_mcp_error_rate_limited() -> None:
    assert to_mcp_error(RateLimitError("rate limited", status_code=429)).category == (
        RATE_LIMITED
    )


def test_to_mcp_error_temporary_failure() -> None:
    assert to_mcp_error(TransientError("unavailable", status_code=503)).category == (
        TEMPORARY_FAILURE
    )


def test_to_mcp_error_oauth_bad_code() -> None:
    assert to_mcp_error(ValueError("bad code")).category == INVALID_REQUEST


def test_to_mcp_error_unknown_falls_back_to_platform_error() -> None:
    assert to_mcp_error(RuntimeError("unexpected")).category == PLATFORM_ERROR


# --- to_admin_error ----------------------------------------------------------


def test_to_admin_error_returns_admin_error() -> None:
    admin_error = to_admin_error(PlatformHttpError("not found", status_code=404))
    assert isinstance(admin_error, AdminError)
    assert admin_error.category == NOT_FOUND
    assert admin_error.message == "The requested resource was not found."
    assert "not found" in admin_error.detail


def test_to_admin_error_message_is_safe() -> None:
    exc = PlatformHttpError("access_token=secret123", status_code=401)
    admin_error = to_admin_error(exc)
    assert "secret123" not in admin_error.message
    assert "secret123" not in admin_error.detail


def test_to_admin_error_category_matches_normalized() -> None:
    exc = TransientError("down", status_code=503)
    admin_error = to_admin_error(exc)
    assert admin_error.category == TEMPORARY_FAILURE


def test_admin_error_is_frozen() -> None:
    admin_error = to_admin_error(PlatformHttpError("x", status_code=404))
    with pytest.raises((AttributeError, TypeError)):
        admin_error.message = "other"  # type: ignore[misc]


def test_mcp_error_message_never_contains_token_values() -> None:
    """Even if a provider message echoes a token, the MCP error message is the
    redacted category message, never the raw provider text."""

    exc = PlatformHttpError("access_token=super-secret-token", status_code=401)
    mcp_error = to_mcp_error(exc)
    assert "super-secret-token" not in mcp_error.message
    assert mcp_error.category == AUTHENTICATION_REQUIRED
