"""Operational diagnostics for the self-hosted Web Admin.

This package provides a bounded, in-memory store of recent application and API
diagnostic entries, with:

* a maximum event count and per-field size cap (bounded retention suitable for
  the N150 single-container deployment);
* request/platform correlation via a per-request correlation id carried on a
  token that is logged but never persisted to long-term storage;
* aggressive redaction of credentials, tokens, authorization codes, app secrets
  and sensitive headers so secrets can never leak into the admin log view;
* no social-content logging by default: only metadata such as platform,
  endpoint and HTTP status is recorded, never response bodies.

The logs view is itself admin-authenticated and never exposes the underlying
token-encryption key, the account database path contents, or any stored token
bytes.
"""

import contextvars
import logging
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from logging import LogRecord
from threading import Lock
from typing import ClassVar

__all__ = [
    "DiagnosticEvent",
    "DiagnosticLevel",
    "DiagnosticLog",
    "DiagnosticLogFilter",
    "Redactor",
    "current_request_id",
    "get_diagnostics",
    "request_id_var",
    "set_request_id",
]


def _utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""

    return datetime.now(UTC)


# A context variable that carries the current request's correlation id. It is
# read by DiagnosticLogFilter so every log line emitted during a request is
# tagged with the request id without handlers having to thread it explicitly.
request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "social_mcp_request_id", default=None
)


def set_request_id(correlation_id: str):
    """Bind a correlation id to the current execution context.

    Returns the contextvar token so callers can restore the previous value with
    :func:`request_id_var.reset`; this keeps the binding scoped to a single
    request even when middleware runs in a shared thread.
    """

    return request_id_var.set(correlation_id)


def current_request_id() -> str | None:
    """Return the correlation id for the current request, if any."""

    return request_id_var.get()


class DiagnosticLevel(StrEnum):
    """Severity for a diagnostic event, ordered from least to most severe."""

    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


# Sensitive keys whose values must never be emitted. Matched case-insensitively
# as a suffix against header names and against dict/JSON field names so the
# redactor covers Authorization, www-authenticate, and variants such as
# X-Meta-Webhook-Secret as well as OAuth token/refresh_token/code fields.
SENSITIVE_KEY_SUFFIXES: tuple[str, ...] = (
    "authorization",
    "www-authenticate",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "secret",
    "token",
    "code",
    "access_token",
    "refresh_token",
    "authorization_code",
    "client_secret",
    "app_secret",
    "client_key",
    "password",
)

# A marker string used in place of any redacted value. It is deliberately a
# constant placeholder, not the original sensitive value.
REDACTED_MARKER = "REDACTED"

# Prefixes used to detect bearer/basic credentials embedded in a value, so
# headers such as "Bearer mg2...abc" are redacted even if the key name is not
# recognized.
_BEARER_PREFIX = "bearer "
_BASIC_PREFIX = "basic "


@dataclass(slots=True)
class DiagnosticEvent:
    """A single bounded diagnostic entry shown in the Web Admin log view."""

    timestamp: datetime
    level: DiagnosticLevel
    source: str
    message: str
    correlation_id: str | None = None
    platform: str | None = None
    endpoint: str | None = None
    status_code: int | None = None
    detail: str | None = None


# Maximum number of events retained. Bounded so the store can never grow without
# limit on the N150 single-container deployment.
DEFAULT_MAX_EVENTS = 1000
# Maximum length of any textual field before truncation, to bound memory per
# entry and to keep the rendered page responsive.
DEFAULT_FIELD_LIMIT = 2000


@dataclass
class DiagnosticLog:
    """A thread-safe, bounded ring buffer of diagnostic events.

    Retention is by count (and indirectly by field truncation): once
    ``max_events`` is reached the oldest entry is discarded. This is suitable
    for the N150 single-container deployment, where a short window of recent
    operational history is all that is required for troubleshooting.
    """

    max_events: int = DEFAULT_MAX_EVENTS
    field_limit: int = DEFAULT_FIELD_LIMIT
    _events: deque = field(default_factory=deque, repr=False)
    _lock: Lock = field(default_factory=Lock, repr=False)

    def __post_init__(self) -> None:
        if self.max_events <= 0:
            raise ValueError("max_events must be positive")
        # The dataclass field default_factory gives an unbounded deque; replace
        # it with a bounded one so appending enforces the cap.
        self._events = deque(maxlen=self.max_events)

    def record(
        self,
        level: DiagnosticLevel,
        source: str,
        message: str,
        *,
        correlation_id: str | None = None,
        platform: str | None = None,
        endpoint: str | None = None,
        status_code: int | None = None,
        detail: str | None = None,
    ) -> DiagnosticEvent:
        """Record an event, truncating textual fields to bound memory.

        Sensitive substrings are not expected in any of these fields; the
        :class:`Redactor` is responsible for scrubbing untrusted content before
        it reaches the log. This method only bounds size.
        """

        event = DiagnosticEvent(
            timestamp=_utcnow(),
            level=level,
            source=self._truncate(source),
            message=self._truncate(message),
            correlation_id=correlation_id,
            platform=platform,
            endpoint=endpoint,
            status_code=status_code,
            detail=self._truncate(detail) if detail is not None else None,
        )
        with self._lock:
            self._events.append(event)
        return event

    def record_http(
        self,
        source: str,
        platform: str | None,
        endpoint: str,
        status_code: int,
        *,
        correlation_id: str | None = None,
        message: str = "platform API request",
    ) -> DiagnosticEvent:
        """Record a platform/API HTTP request outcome without response bodies.

        No response or request body is captured: only the platform, endpoint
        path and status code, so social content is never logged by default.
        """

        level = DiagnosticLevel.ERROR if status_code >= 500 else DiagnosticLevel.INFO
        return self.record(
            level,
            source=source,
            message=message,
            correlation_id=correlation_id,
            platform=platform,
            endpoint=endpoint,
            status_code=status_code,
        )

    def record_error(self, source: str, error: BaseException) -> DiagnosticEvent:
        """Record an exception with its type and message, never its full chain."""

        detail = f"{type(error).__name__}: {error}"
        return self.record(
            DiagnosticLevel.ERROR,
            source=source,
            message="operation failed",
            detail=detail,
        )

    def recent(self, limit: int | None = None) -> list:
        """Return the most recent events, newest last, bounded by ``limit``.

        The returned list is a copy; callers cannot mutate the internal buffer.
        """

        with self._lock:
            events = list(self._events)
        if limit is not None:
            events = events[-limit:]
        return events

    def clear(self) -> int:
        """Drop all events and return how many were removed."""

        with self._lock:
            count = len(self._events)
            self._events.clear()
        return count

    def __len__(self) -> int:
        with self._lock:
            return len(self._events)

    def _truncate(self, value: str | None) -> str | None:
        if value is None:
            return None
        if len(value) <= self.field_limit:
            return value
        return value[: self.field_limit - 1] + "\u2026"


class Redactor:
    """Scrub sensitive material from strings before it is logged or displayed.

    The redactor is conservative: it never returns the original sensitive
    substring. It covers Authorization headers/bearer tokens, basic-auth
    credentials, and dict/JSON field names that match a sensitive suffix.
    """

    @staticmethod
    def _is_sensitive_key(key: str) -> bool:
        lowered = key.lower()
        return any(
            lowered == suffix or lowered.endswith(suffix) for suffix in SENSITIVE_KEY_SUFFIXES
        )

    def redact(self, value: str) -> str:
        """Return ``value`` with bearer/basic credentials replaced."""

        if not value:
            return value
        lowered = value.lower()
        if lowered.startswith(_BEARER_PREFIX):
            return f"Bearer {REDACTED_MARKER}"
        if lowered.startswith(_BASIC_PREFIX):
            return f"Basic {REDACTED_MARKER}"
        return value

    def redact_headers(self, headers: dict[str, str]) -> dict[str, str]:
        """Return a copy of ``headers`` with sensitive headers redacted."""

        redacted: dict[str, str] = {}
        for key, value in headers.items():
            if self._is_sensitive_key(key):
                redacted[key] = REDACTED_MARKER
            else:
                redacted[key] = self.redact(str(value))
        return redacted

    def redact_fields(self, fields: dict[str, object]) -> dict[str, object]:
        """Return a copy of ``fields`` with sensitive field values redacted.

        Nested dicts/lists are walked so a token buried under
        ``{"auth": {"refresh_token": "..."}}`` is still caught.
        """

        return self._redact_value(fields)

    def _redact_value(self, value: object) -> object:
        if isinstance(value, dict):
            return {
                key: (
                    REDACTED_MARKER
                    if self._is_sensitive_key(key)
                    else self._redact_value(val)
                )
                for key, val in value.items()
            }
        if isinstance(value, list):
            return [self._redact_value(item) for item in value]
        if isinstance(value, str):
            return self.redact(value)
        return value


# Module-level shared instances. The diagnostics log is intentionally a single
# bounded global for the lifetime of the process so every worker thread writes
# to the same window of recent history. A separate module-level redactor keeps
# tests from depending on shared mutable state.
_shared_log: DiagnosticLog | None = None
_shared_redactor: Redactor | None = None


def get_diagnostics() -> DiagnosticLog:
    """Return the shared diagnostic log, creating it on first use."""

    global _shared_log
    if _shared_log is None:
        _shared_log = DiagnosticLog()
    return _shared_log


def get_redactor() -> Redactor:
    """Return the shared redactor instance."""

    global _shared_redactor
    if _shared_redactor is None:
        _shared_redactor = Redactor()
    return _shared_redactor


class DiagnosticLogFilter(logging.Filter):
    """Attach a request correlation id to every log record in this process.

    When a request correlation id is bound to the current context
    (:func:`set_request_id`) this filter adds it to each emitted record as
    ``request_id`` and records the event into the bounded diagnostic log at the
    appropriate level. Records emitted outside any request context are still
    captured but carry no correlation id.

    Sensitive data should never reach this filter: application code must redact
    untrusted content before logging. The filter only enriches and stores.
    """

    _level_map: ClassVar[dict[int, DiagnosticLevel]] = {
        logging.DEBUG: DiagnosticLevel.INFO,
        logging.INFO: DiagnosticLevel.INFO,
        logging.WARNING: DiagnosticLevel.WARNING,
        logging.ERROR: DiagnosticLevel.ERROR,
        logging.CRITICAL: DiagnosticLevel.CRITICAL,
    }

    def filter(self, record: LogRecord) -> bool:
        request_id = current_request_id()
        record.request_id = request_id  # type: ignore[attr-defined]
        self._capture(record)
        return True

    def _capture(self, record: LogRecord) -> None:
        diagnostics = get_diagnostics()
        level = self._level_map.get(record.levelno)
        if level is None:
            return
        try:
            message = record.getMessage()
        except (ValueError, TypeError, AttributeError):  # pragma: no cover - defensive
            message = "<unreadable>"
        request_id = getattr(record, "request_id", None)
        diagnostics.record(
            level,
            source=record.name,
            message=message,
            correlation_id=request_id if isinstance(request_id, str) else None,
            detail=None,
        )
