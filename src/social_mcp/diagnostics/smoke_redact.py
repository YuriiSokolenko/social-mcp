"""Recursive sensitive-value redaction helper for smoke diagnostics."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

__all__ = ["DEFAULT_REDACTION", "redact_mapping"]

DEFAULT_REDACTION = "***"


def redact_mapping(
    mapping: Mapping[str, Any],
    sensitive_keys: Iterable[str],
    *,
    replacement: str = DEFAULT_REDACTION,
) -> dict[str, Any]:
    """Return a copy of ``mapping`` with sensitive values redacted.

    Keys in ``sensitive_keys`` are matched by exact key name, ignoring case.
    Every matching value is replaced with ``replacement``. Nested dictionaries
    and lists are walked recursively; non-matching scalar values are returned
    unchanged. The input object is never mutated.
    """
    lowered = {str(key).casefold() for key in sensitive_keys}
    return _redact(mapping, lowered, replacement)


def _redact(
    value: Any,
    sensitive_keys: set[str],
    replacement: str,
) -> Any:
    if isinstance(value, Mapping):
        return _redact_mapping(value, sensitive_keys, replacement)
    if isinstance(value, list):
        return [_redact(item, sensitive_keys, replacement) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact(item, sensitive_keys, replacement) for item in value)
    return value


def _redact_mapping(
    mapping: Mapping[str, Any],
    sensitive_keys: set[str],
    replacement: str,
) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in mapping.items():
        if str(key).casefold() in sensitive_keys:
            redacted[key] = replacement
        else:
            redacted[key] = _redact(value, sensitive_keys, replacement)
    return redacted
