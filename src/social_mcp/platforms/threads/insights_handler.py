"""Handler and normalization for ``threads_get_insights``.

This module connects the metric-validation layer to the existing Threads
adapter, reusing the connected-account lookup and token-decryption boundary.
"""

from __future__ import annotations

import logging
from typing import Any

from social_mcp.platforms.threads.insights import (
    InsightError,
    InsightErrorType,
    InsightScope,
    _resolve_scope,
    validate_requested_metrics,
)

logger = logging.getLogger(__name__)


async def _resolve_decrypted_token(account: Any, adapter: Any) -> str:
    """Look up the connected account and lazily decrypt its token.

    Reuses the adapter's existing token-decryption boundary. The token is
    decrypted **only** when an authorized insights request needs it.
    """
    token = await adapter.decrypt_account_token(account)
    if not token:
        raise InsightError(
            InsightErrorType.AUTHENTICATION_REQUIRED,
            "Connected Threads account has no valid token.",
        )
    return token


def _normalize_account_insights(
    raw: dict[str, Any],
    account_id: str,
    metrics: list[str],
) -> dict[str, Any]:
    """Normalize account-level insights into a stable shape.

    Preserves platform identifiers and metric names for follow-up/debugging.
    """
    data: dict[str, Any] = raw.get("data", {})
    values: dict[str, Any] = raw.get("values", {})

    insight_values = {}
    for m in metrics:
        v = values.get(m, data.get(m))
        insight_values[m] = v

    return {
        "scope": "account",
        "platform": "threads",
        "account_id": account_id,
        "metrics": insight_values,
        "timestamp": raw.get("timestamp"),
    }


def _normalize_post_insights(
    raw: dict[str, Any],
    post_id: str,
    metrics: list[str],
) -> dict[str, Any]:
    """Normalize post-level (content) insights into a stable shape.

    Preserves platform identifiers and metric names for follow-up/debugging.
    """
    data: dict[str, Any] = raw.get("data", raw)
    values: dict[str, Any] = data.get("values", data)

    insight_values = {}
    for m in metrics:
        v = values.get(m)
        insight_values[m] = v

    return {
        "scope": "post",
        "platform": "threads",
        "post_id": post_id,
        "metrics": insight_values,
        "timestamp": data.get("timestamp"),
    }


def _classify_provider_error(exc: BaseException) -> InsightError:
    """Map raw provider exceptions to the normalized MCP error model.

    Handles permission, unavailable-capability, invalid-request, rate-limit,
    transient, and provider failures without leaking credentials.
    """
    name = type(exc).__name__
    msg = str(exc)
    msg_lower = msg.lower()

    # Rate limit — check exception name and message keywords.
    if "rate_limit" in name.lower() or "rate" in msg_lower and "limit" in msg_lower:
        return InsightError(
            InsightErrorType.RATE_LIMITED,
            "Threads API rate limit exceeded. Retry after a short delay.",
            retryable=True,
            metadata={"provider_exception": name},
        )

    # Permission / capability errors.
    # Check both the exception type name and the message for permission
    # and scope keywords. PermissionError or "scope"/"permission" in the
    # message indicates a permission_required error.
    is_permission = (
        "PermissionError" in name
        or "permission" in msg_lower
        or "unauthorized" in msg_lower
        or "scope" in msg_lower
    )
    if is_permission:
        return InsightError(
            InsightErrorType.PERMISSION_REQUIRED,
            "Connected account lacks the required permission for insights.",
            metadata={"provider_exception": name},
        )

    # Not found
    if "not_found" in name.lower() or "404" in msg:
        return InsightError(
            InsightErrorType.NOT_FOUND,
            "Requested content was not found.",
            metadata={"provider_exception": name},
        )

    # Invalid request
    if "invalid" in msg_lower or "bad_request" in name.lower() or "400" in msg:
        return InsightError(
            InsightErrorType.INVALID_REQUEST,
            "Invalid request to the Threads API.",
            metadata={"provider_exception": name},
        )

    # Transient connection or timeout errors
    if "timeout" in msg_lower or "connection" in msg_lower:
        return InsightError(
            InsightErrorType.TEMPORARY_FAILURE,
            "Temporary connection failure to the Threads API.",
            retryable=True,
            metadata={"provider_exception": name},
        )

    # Fallback — provider error
    logger.warning("Unhandled Threads provider error: %s", name)
    return InsightError(
        InsightErrorType.PLATFORM_ERROR,
        "Unexpected error from the Threads API.",
        retryable=False,
        metadata={"provider_exception": name},
    )


async def handle_get_insights(
    post_id: str | None = None,
    metrics: list[str] | None = None,
    *,
    account: Any = None,
    adapter: Any = None,
) -> dict[str, Any]:
    """Return available insights for the connected account or content item.

    Parameters mirror the contract input:
      - ``post_id`` — optional; when provided, content (post) insights are
        returned for that post.
      - ``metrics`` — optional list of requested metric names. When omitted,
        a sensible default set for the scope is used.

    Steps:
      1. Resolve the scope (account vs. post) from ``post_id``.
      2. Validate the requested metrics against supported capabilities
         **before** making any external provider request.
      3. Look up the connected account and decrypt the token lazily.
      4. Delegate to the adapter to fetch insights.
      5. Normalize the response into a stable shape while preserving
         platform identifiers and metric names.
    """
    scope = _resolve_scope(post_id)
    validated_metrics = validate_requested_metrics(metrics, scope)

    if adapter is None:
        raise InsightError(
            InsightErrorType.CAPABILITY_UNAVAILABLE,
            "Threads adapter is not available.",
        )

    if account is None:
        raise InsightError(
            InsightErrorType.AUTHENTICATION_REQUIRED,
            "No connected Threads account was found.",
        )

    # Verify the account has the insights capability before doing anything.
    if not adapter.has_insights_capability(account):
        raise InsightError(
            InsightErrorType.PERMISSION_REQUIRED,
            "Connected Threads account lacks the insights capability "
            "(threads_manage_insights permission).",
        )

    # Lazily decrypt the token only now that we have an authorized request.
    token = await _resolve_decrypted_token(account, adapter)

    try:
        if scope == InsightScope.POST:
            raw = await adapter.fetch_post_insights(
                token=token,
                post_id=post_id,
                metrics=validated_metrics,
            )
            return _normalize_post_insights(raw, post_id, validated_metrics)
        else:
            raw = await adapter.fetch_account_insights(
                token=token,
                metrics=validated_metrics,
            )
            account_id = getattr(account, "platform_user_id", None) or raw.get("id", "")
            return _normalize_account_insights(raw, account_id, validated_metrics)
    except InsightError:
        raise
    except Exception as exc:
        raise _classify_provider_error(exc) from exc
