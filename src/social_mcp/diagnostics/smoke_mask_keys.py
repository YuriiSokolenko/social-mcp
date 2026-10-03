"""Recursive sensitive-key masking helper used by diagnostics smoke checks."""

from __future__ import annotations

from collections.abc import Collection, Mapping
from typing import Any

__all__ = ["DEFAULT_REPLACEMENT", "SENSITIVE_KEYS", "mask_mapping"]

#: Exact key names treated as sensitive, matched case-insensitively.
SENSITIVE_KEYS = frozenset(
    {
        "api_key",
        "authorization",
        "cookie",
        "password",
        "secret",
        "token",
    }
)

#: Value substituted for every value found under a sensitive key.
DEFAULT_REPLACEMENT = "<redacted>"


def mask_mapping(
    value: Any,
    replacement: str = DEFAULT_REPLACEMENT,
    sensitive_keys: Collection[str] | None = None,
) -> Any:
    """Return ``value`` with every sensitive mapping value masked.

    Keys listed in ``sensitive_keys`` (``SENSITIVE_KEYS`` by default) are
    matched by exact name, ignoring case. Any value stored under a matching
    key is replaced with ``replacement``. Dictionaries and lists are
    traversed recursively; other values are returned unchanged. The input
    object is never mutated.

    Args:
        value: Mapping, list, tuple, or scalar to mask.
        replacement: Stand-in for masked values.
        sensitive_keys: Key names to mask, defaulting to ``SENSITIVE_KEYS``.

    Returns:
        A masked copy of ``value``.
    """
    keys = SENSITIVE_KEYS if sensitive_keys is None else sensitive_keys
    return _mask(value, frozenset(str(key).casefold() for key in keys), replacement)


def _mask(value: Any, keys: frozenset[str], replacement: str) -> Any:
    if isinstance(value, Mapping):
        return {
            key: replacement
            if str(key).casefold() in keys
            else _mask(item, keys, replacement)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_mask(item, keys, replacement) for item in value]
    if isinstance(value, tuple):
        return tuple(_mask(item, keys, replacement) for item in value)
    return value
