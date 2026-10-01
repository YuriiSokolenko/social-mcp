__probe__

This package provides a lightweight in-memory diagnostic log
(:class:`DiagnosticLog`) and a :class:`logging.Filter`
(:class:`DiagnosticLogFilter`) that attaches a correlation id to every log
record so that diagnostics can be traced back to the request that produced
them.

Public objects are re-exported here so that callers can import them directly
from :mod:`social_mcp.diagnostics`.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Iterator, List, Optional

__all__ = [
    "DEFAULT_MAX_EVENTS",
    "DiagnosticLog",
    "DiagnosticLogFilter",
    "set_request_id",
    "request_id_var",
]

#: Default maximum number of diagnostic events retained by a
#: :class:`DiagnosticLog` instance.
DEFAULT_MAX_EVENTS: int = 100

# Context-local storage for the current request id.  Using a dedicated
# object (rather than a bare ``threading.local``) keeps the public API
# stable while still being request/thread aware.
class _RequestIdLocal(threading.local):  # type: ignore[misc]
    """Thread-local container for the active request id."""

    def __init__(self) -> None:
        super().__init__()
        self.value: Optional[str] = None


request_id_var: _RequestIdLocal = _RequestIdLocal()


def set_request_id(request_id: Optional[str]) -> None:
    """Set the request id for the current thread/context."""
    request_id_var.value = request_id


@dataclass
class _DiagnosticEvent:
    """A single captured diagnostic event."""

    level: str
    message: str
    data: dict = field(default_factory=dict)

    def truncate(self, field_limit: Optional[int]) -> "_DiagnosticEvent":
        """Return a copy of this event with ``data`` values truncated."""
        if field_limit is None:
            return self
        truncated_data: dict = {}
        for key, value in self.data.items():
            text = str(value)
            if len(text) > field_limit:
                truncated_data[key] = text[:field_limit] + "..."
            else:
                truncated_data[key] = value
        return _DiagnosticEvent(level=self.level, message=self.message, data=truncated_data)


class DiagnosticLog:
    """An in-memory diagnostic event log.

    Captures a bounded number of events (with optional per-field size
    limiting) for later inspection/debugging.
    """

    def __init__(
        self,
        max_events: int = DEFAULT_MAX_EVENTS,
        field_limit: Optional[int] = None,
    ) -> None:
        if max_events < 0:
            raise ValueError("max_events must be non-negative")
        self.max_events: int = max_events
        self.field_limit: Optional[int] = field_limit
        self._events: List[_DiagnosticEvent] = []
        self._lock = threading.Lock()

    def record(
        self,
        level: str,
        message: str,
        data: Optional[dict] = None,
    ) -> None:
        """Record a single diagnostic event."""
        event = _DiagnosticEvent(level=level, message=message, data=dict(data or {}))
        with self._lock:
            self._events.append(event)
            # Trim to the most recent ``max_events`` entries.
            if self.max_events == 0:
                self._events.clear()
            elif len(self._events) > self.max_events:
                del self._events[: len(self._events) - self.max_events]

    def debug(self, message: str, data: Optional[dict] = None) -> None:
        """Record a ``DEBUG`` level event."""
        self.record("DEBUG", message, data)

    def info(self, message: str, data: Optional[dict] = None) -> None:
        """Record an ``INFO`` level event."""
        self.record("INFO", message, data)

    def warning(self, message: str, data: Optional[dict] = None) -> None:
        """Record a ``WARNING`` level event."""
        self.record("WARNING", message, data)

    def error(self, message: str, data: Optional[dict] = None) -> None:
        """Record an ``ERROR`` level event."""
        self.record("ERROR", message, data)

    def get_events(self) -> List[_DiagnosticEvent]:
        """Return a snapshot copy of the recorded events."""
        with self._lock:
            return list(self._events)

    @property
    def events(self) -> List[_DiagnosticEvent]:
        """Return a snapshot copy of the recorded events."""
        return self.get_events()

    def clear(self) -> None:
        """Remove all recorded events."""
        with self._lock:
            self._events.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._events)

    def __iter__(self) -> Iterator[_DiagnosticEvent]:
        return iter(self.get_events())


class DiagnosticLogFilter(logging.Filter):
    """A :class:`logging.Filter` that attaches a request id to log records.

    When a request id has been set via :func:`set_request_id` (typically by
    the application for each incoming request), the id is attached to every
    emitted log record as the ``request_id`` attribute.  Records are also
    forwarded to the active :class:`DiagnosticLog` so they can be inspected
    after the fact.
    """

    def __init__(self, diagnostic_log: Optional[DiagnosticLog] = None) -> None:
        super().__init__()
        self.diagnostic_log: Optional[DiagnosticLog] = diagnostic_log

    def filter(self, record: logging.LogRecord) -> bool:
        # Attach the current request id (if any) to the record.
        request_id = request_id_var.value
        record.request_id = request_id  # type: ignore[attr-defined]
        if self.diagnostic_log is not None:
            self.diagnostic_log.record(
                level=record.levelname,
                message=record.getMessage(),
                data={
                    "name": record.name,
                    "filename": record.filename,
                    "lineno": record.lineno,
                },
            )
        return True
