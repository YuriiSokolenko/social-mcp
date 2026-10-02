"""Recursive sensitive-value redaction helpers.

Standard library only: no third-party or project dependencies.
"""

from __future__ import annotations

from collections.abc import Iterable

__all__ = ["SENSITIVE_KEYS", "redact_mapping"]

#: Default sensitive key names, matched by exact name ignoring case.
SENSITIVE_KEYS = frozenset(
    {
        "authorization",
        "cookie",
        "password",
        "secret",
        "token",
    }
)


def redact_mapping(
    mapping: dict,
    *,
    sensitive_keys: Iterable[str] = SENSITIVE_KEYS,
    replacement: str = "***",
) -> dict:
    """Return a copy of ``mapping`` with sensitive values redacted.

    Keys are matched by exact name, ignoring case. Matching values are replaced
    with ``replacement``. Nested dictionaries and lists are walked recursively;
    every other value, including scalars, is kept unchanged. The input object is
    never modified.

    Args:
        mapping: mapping to redact.
        sensitive_keys: key names to redact, compared case-insensitively.
        replacement: value substituted for sensitive entries.
    """
    lowered = {name.lower() for name in sensitive_keys}

    def redact(value: object) -> object:
        if isinstance(value, dict):
            return {
                key: replacement
                if isinstance(key, str) and key.lower() in lowered
                else redact(inner)
                for key, inner in value.items()
            }
        if isinstance(value, list):
            return [redact(item) for item in value]
        return value

    return redact(mapping)
