"""Standalone key/value text parsing helpers.

Standard library only: no third-party or project dependencies.
"""

from __future__ import annotations

__all__ = ["parse_key_value_lines"]


def parse_key_value_lines(text: str) -> dict[str, str]:
    """Parse ``key=value`` text into a dictionary.

    Input is processed line by line:

    * blank lines are ignored;
    * every non-blank line must contain at least one ``=`` separator;
    * whitespace around the key and the value is trimmed;
    * additional ``=`` characters are kept verbatim inside the value;
    * later duplicate keys replace earlier values.

    Raises:
        ValueError: a non-blank line has no ``=`` separator, or its key is
            empty after trimming.
    """
    parsed: dict[str, str] = {}

    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue

        key, separator, value = line.partition("=")
        if not separator:
            raise ValueError(f"line {lineno}: missing '=' separator")

        key = key.strip()
        if not key:
            raise ValueError(f"line {lineno}: empty key")

        parsed[key] = value.strip()

    return parsed
