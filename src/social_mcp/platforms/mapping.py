"""Normalized error mapping for platform API failures (issue #94).

Adapter-boundary translation between platform adapters (Threads/TikTok HTTP and
OAuth) and the MCP tool layer / Web Admin. Maps reliability-policy and OAuth
errors to the stable MCP categories in :mod:`social_mcp.server.errors`, keeps
provider details in adapter boundaries, exposes safe secret-free errors, and
redacts tokens/secrets/authorization headers/sensitive payloads.

Builds on the shared HTTP reliability policy instead of duplicating it.
:func:`redact_message` is applied to every returned message.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from social_mcp.platforms.reliability import (
    PlatformHttpError,
    RateLimitError,
    TransientError,
)
from social_mcp.server.errors import (
    McpError,
    authentication_required,
    invalid_request,
    permission_required,
)

__all__ = [
    "AdminError",
    "NormalizedError",
    "normalize_error",
    "normalize_http_status",
    "redact_message",
    "to_admin_error",
    "to_mcp_error",
]

AUTH_REQUIRED_STATUS_CODES: frozenset[int] = frozenset({401})
PERMISSION_STATUS_CODES: frozenset[int] = frozenset({403})
NOT_FOUND_STATUS_CODES: frozenset[int] = frozenset({404})
INVALID_REQUEST_STATUS_CODES: frozenset[int] = frozenset({400, 422})
TEMPORARY_FAILURE_STATUS_CODES: frozenset[int] = frozenset({500, 501})
RETRYABLE_STATUS_CODES: frozenset[int] = frozenset({408, 425, 429, 502, 503, 504})


def normalize_http_status(status_code: int) -> str:
    """Map an HTTP status code to an MCP error category."""

    if status_code in AUTH_REQUIRED_STATUS_CODES:
        return "authentication_required"
    if status_code in PERMISSION_STATUS_CODES:
        return "permission_required"
    if status_code in NOT_FOUND_STATUS_CODES:
        return "not_found"
    if status_code in INVALID_REQUEST_STATUS_CODES:
        return "invalid_request"
    if status_code in TEMPORARY_FAILURE_STATUS_CODES:
        return "temporary_failure"
    if status_code == 429:
        return "rate_limited"
    if status_code in RETRYABLE_STATUS_CODES:
        return "temporary_failure"
    return "platform_error"


_BEARER_RE = re.compile(r"(?i)\b(bearer\s+)([A-Za-z0-9+/=._-]+)")
_BASIC_RE = re.compile(r"(?i)\b(basic\s+)([A-Za-z0-9+/=._-]+)")
_SENSITIVE_KEY_SUFFIXES = (
    "authorization", "secret", "token", "refresh_token", "access_token",
    "client_secret", "app_secret", "password", "code", "authorization_code",
    "api_key", "api-key", "cookie",
)
_KEY_VALUE_RE = re.compile(r"(?i)\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\s,;)\]]+)")
_REDACTED_MARKER = "REDACTED"


def _is_sensitive_key(key: str) -> bool:
    """Return whether ``key`` should be redacted as a sensitive value.

    The key is normalized to lowercase and treated as sensitive when it equals,
    ends with, or contains one of the configured sensitive-key suffixes in
    :data:`_SENSITIVE_KEY_SUFFIXES`.
    """
    lowered = key.lower()
    return any(
        lowered == suffix or lowered.endswith(suffix) or suffix in lowered
        for suffix in _SENSITIVE_KEY_SUFFIXES
    )


def redact_message(text: str) -> str:
    """Redact bearer/basic credentials and secret ``key=value`` pairs."""

    if not text:
        return text
    text = _BEARER_RE.sub(lambda m: f"{m.group(1)}{_REDACTED_MARKER}", text)
    text = _BASIC_RE.sub(lambda m: f"{m.group(1)}{_REDACTED_MARKER}", text)
    text = _KEY_VALUE_RE.sub(_redact_key_value, text)
    return text


def _redact_key_value(match: re.Match) -> str:
    key = match.group(1)
    if _is_sensitive_key(key):
        return f"{key}={_REDACTED_MARKER}"
    return match.group(0)


@dataclass(frozen=True)
class NormalizedError:
    """A platform failure mapped to a stable category and safe messages.

    ``category`` is one of SUPPORTED_CATEGORIES. ``message`` is safe for MCP and
    Admin clients (no tokens/secrets/headers/provider payloads). ``detail`` is
    an adapter-boundary summary safe for the diagnostic log.
    """

    category: str
    message: str
    detail: str


# (category, client message, admin detail prefix) for each standard category.
_AUTH_MSG = ("authentication_required",
             "The connected account is no longer authorized. Reconnect it through the Web Admin.",
             "authorization failure")
_PERMISSION_MSG = ("permission_required",
                   "The connected account lacks a required permission.",
                   "missing required permission")
_NOT_FOUND_MSG = ("not_found",
                  "The requested resource was not found.",
                  "resource not found")
_INVALID_MSG = ("invalid_request",
                "The request was invalid.",
                "invalid request")
_TEMPORARY_MSG = ("temporary_failure",
                  "The platform is temporarily unavailable. Try again later.",
                  "transient failure")
_RATE_LIMIT_MSG = ("rate_limited",
                   "The platform rate limit was reached. Try again later.",
                   "rate limited")
_PLATFORM_MSG = ("platform_error",
                 "The platform returned an unexpected response.",
                 "platform error")


_CATEGORIES: dict[str, tuple[str, str, str]] = {
    "authentication_required": _AUTH_MSG,
    "permission_required": _PERMISSION_MSG,
    "not_found": _NOT_FOUND_MSG,
    "invalid_request": _INVALID_MSG,
    "temporary_failure": _TEMPORARY_MSG,
    "rate_limited": _RATE_LIMIT_MSG,
    "platform_error": _PLATFORM_MSG,
}


def _by_category(category: str) -> tuple[str, str, str]:
    """Return (category, message, detail) for a standard category."""

    return _CATEGORIES.get(category, _PLATFORM_MSG)


def _classify_oauth_message(raw: str) -> str:
    """Classify an OAuth adapter message by keyword into a category.

    OAuth errors carry safe non-secret messages by contract; classification by
    keyword keeps the category stable even if the provider's wording changes,
    without parsing provider payloads.
    """

    lowered = raw.lower()
    if any(word in lowered for word in
           ("invalid_token", "invalid request", "bad code", "missing",
            "was not found", "not found")):
        return "invalid_request"
    if any(word in lowered for word in
           ("expired", "unauthorized", "forbidden", "invalid grant",
            "invalid_client")):
        return "authentication_required"
    if any(word in lowered for word in
           ("rate", "limit", "429", "retry-after")):
        return "rate_limited"
    return "authentication_required"


def normalize_error(exc: BaseException) -> NormalizedError:
    """Map a platform/HTTP/OAuth failure to a :class:`NormalizedError`.

    Provider-specific details stay in adapter boundaries: only the exception
    type, its HTTP status code (when available), and its safe message are used.
    Unknown exception types fall back to ``platform_error`` so callers always
    get a stable, secret-free category.
    """

    if isinstance(exc, RateLimitError):
        status = exc.status_code
        return NormalizedError(
            category="rate_limited",
            message="The platform rate limit was reached. Try again later.",
            detail="rate limited" + (f" (HTTP {status})" if status else ""),
        )
    if isinstance(exc, TransientError):
        status = exc.status_code
        return NormalizedError(
            category="temporary_failure",
            message="The platform is temporarily unavailable. Try again later.",
            detail="transient failure" + (f" (HTTP {status})" if status else ""),
        )
    if isinstance(exc, PlatformHttpError):
        status = exc.status_code
        if status is not None:
            category = normalize_http_status(status)
        else:
            category = "temporary_failure"
        return _from_category(category, exc)
    if isinstance(exc, ValueError):
        # OAuth adapter errors (ThreadsOAuthError/TikTokOAuthError) are ValueError
        # subclasses; classify by their safe message keyword.
        return _from_category(_classify_oauth_message(str(exc)), exc)
    # Unknown exception types fall back to the catch-all so callers always get a
    # stable, secret-free category rather than an unmapped error.
    return _from_category("platform_error", exc)


def _from_category(category: str, exc: BaseException) -> NormalizedError:
    """Build a :class:`NormalizedError` for ``category`` from ``exc``'s message."""

    _, message, detail = _by_category(category)
    safe = redact_message(str(exc) or detail)
    return NormalizedError(category=category, message=message, detail=f"{detail}: {safe}")


@dataclass(frozen=True)
class AdminError:
    """A safe, secret-free error for the Web Admin layer.

    ``message`` is shown to the admin (escaped by the caller). ``detail`` is
    recorded in the bounded diagnostic log and never contains tokens, secrets,
    authorization headers or raw provider payloads.
    """

    message: str
    detail: str
    category: str


def to_mcp_error(exc: BaseException) -> McpError:
    """Map a platform/HTTP/OAuth failure to an :class:`McpError`.

    Uses the normalized category and its client-facing message; provider details
    are discarded at the MCP boundary so only a stable, secret-free category and
    message reach the MCP client.
    """

    normalized = normalize_error(exc)
    return _mcp_for_category(normalized.category, normalized.message)


def _mcp_for_category(category: str, message: str) -> McpError:
    """Build the :class:`McpError` helper for a normalized category."""

    helpers = {
        "authentication_required": authentication_required,
        "permission_required": permission_required,
        "invalid_request": invalid_request,
    }
    helper = helpers.get(category)
    if helper is not None:
        return helper(message)
    # category_unavailable, not_found, rate_limited, platform_error and
    # temporary_failure have no dedicated helper; construct directly.
    return McpError(category=category, message=message)


def to_admin_error(exc: BaseException) -> AdminError:
    """Map a platform/HTTP/OAuth failure to an :class:`AdminError`.

    The admin-facing ``message`` is the normalized category message; the
    ``detail`` (an adapter-boundary summary) is safe to record in the bounded
    diagnostic log. Sensitive material is redacted from both.
    """

    normalized = normalize_error(exc)
    return AdminError(
        message=redact_message(normalized.message),
        detail=redact_message(normalized.detail),
        category=normalized.category,
    )
