"""Threads insights read tool.

Implements ``threads_get_insights`` on top of the existing Threads adapter,
connected-account lookup, and token-decryption boundary established in #3.
Only insights actually supported by the connected application's current
scopes/API access are exposed.

Platform-specific metric names and request details stay inside this adapter.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class InsightErrorType(str, Enum):
    """Normalized error categories shared across MCP tools."""

    AUTHENTICATION_REQUIRED = "authentication_required"
    PERMISSION_REQUIRED = "permission_required"
    CAPABILITY_UNAVAILABLE = "capability_unavailable"
    INVALID_REQUEST = "invalid_request"
    NOT_FOUND = "not_found"
    RATE_LIMITED = "rate_limited"
    PLATFORM_ERROR = "platform_error"
    TEMPORARY_FAILURE = "temporary_failure"


@dataclass
class InsightError(Exception):
    """Normalized error for the shared MCP error model.

    Carries a safe human-readable message and whether retrying may succeed.
    Secrets/tokens are never returned.
    """

    error_type: InsightErrorType
    message: str
    retryable: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:
        return f"[{self.error_type}] {self.message}"


# Metrics supported by the Threads Management API.
ACCOUNT_METRICS: frozenset[str] = frozenset({
    "impressions",
    "accounts_engaged_unique",
    "content_views",
    "followers_count",
})

POST_METRICS: frozenset[str] = frozenset({
    "impressions",
    "shares",
    "likes",
    "replies",
    "saved",
    "video_views",
    "engagement",
    "reach",
    "accounts_engaged_unique",
})

POST_ONLY_METRICS: frozenset[str] = frozenset({
    "shares", "likes", "replies", "saved", "video_views",
})

ACCOUNT_ONLY_METRICS: frozenset[str] = frozenset({
    "followers_count",
})


class InsightScope(Enum):
    """Whether an insight request targets the account or a content item."""

    ACCOUNT = "account"
    POST = "post"


def _resolve_scope(post_id: str | None) -> InsightScope:
    """Determine whether the request targets account or content insights."""
    return InsightScope.POST if post_id is not None else InsightScope.ACCOUNT


def validate_requested_metrics(
    requested: list[str] | None,
    scope: InsightScope,
) -> list[str]:
    """Validate the requested metric list against supported capabilities.

    Rejects unsupported metric names, scope-inappropriate metrics, and
    unsupported combinations *before* any external provider request.

    Returns the validated, deduplicated metric list. Raises
    :class:`InsightError` with ``invalid_request`` when the combination is
    not supported.
    """
    if requested is None:
        if scope == InsightScope.POST:
            return sorted(POST_METRICS)
        return sorted(ACCOUNT_METRICS)

    if not requested:
        raise InsightError(
            InsightErrorType.INVALID_REQUEST,
            "Requested metrics list must not be empty.",
        )

    seen: set[str] = set()
    normalized: list[str] = []
    for m in requested:
        m = m.strip()
        if not m:
            raise InsightError(
                InsightErrorType.INVALID_REQUEST,
                "Requested metric names must not be empty strings.",
            )
        if m in seen:
            continue
        seen.add(m)
        normalized.append(m)

    allowed = POST_METRICS if scope == InsightScope.POST else ACCOUNT_METRICS
    unknown = sorted(m for m in normalized if m not in allowed)
    if unknown:
        raise InsightError(
            InsightErrorType.INVALID_REQUEST,
            f"Unsupported metric(s): {', '.join(unknown)}.",
            metadata={"unsupported_metrics": unknown},
        )

    if scope == InsightScope.POST:
        bad = sorted(m for m in normalized if m in ACCOUNT_ONLY_METRICS)
        if bad:
            raise InsightError(
                InsightErrorType.INVALID_REQUEST,
                f"Metric(s) {', '.join(bad)} are account-level only and "
                "cannot be requested with post_id.",
                metadata={"account_only_metrics": bad},
            )
    else:
        bad = sorted(m for m in normalized if m in POST_ONLY_METRICS)
        if bad:
            raise InsightError(
                InsightErrorType.INVALID_REQUEST,
                f"Metric(s) {', '.join(bad)} are content-level only; provide "
                "post_id to request them.",
                metadata={"post_only_metrics": bad},
            )

    return normalized
