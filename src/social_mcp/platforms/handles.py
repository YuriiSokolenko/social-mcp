"""Reusable, platform-neutral social handle normalization utilities.

These helpers sanitize user-provided social account handles before they are
consumed by platform-specific code or persisted. They intentionally impose no
platform-specific length or character-set restrictions so that adapters remain
the single source of truth for platform rules.
"""

from __future__ import annotations

_URL_SCHEME_MARKER = "://"


def normalize_handle(value: str) -> str:
    """Normalize a user-provided social handle.

    Accepts either ``username`` or ``@username`` and returns the bare username.
    Leading and trailing whitespace is trimmed, and at most one leading ``@``
    marker is removed. The following inputs are rejected with a
    :class:`ValueError`:

    * empty or whitespace-only strings;
    * an input that is only ``@``;
    * values containing whitespace after trimming;
    * URL-like values (such as ``https://example.com/user``);
    * values containing a second ``@`` after the optional leading marker.

    :param value: the raw handle provided by the user.
    :returns: the trimmed username with a single optional leading ``@`` removed.
    :raises ValueError: if the input cannot be normalized to a valid username.
    """
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("handle must not be empty")

    username = trimmed.removeprefix("@")
    if not username:
        raise ValueError("handle must not be empty after stripping '@'")

    if "@" in username:
        raise ValueError("handle must not contain additional '@' markers")

    if any(character.isspace() for character in username):
        raise ValueError("handle must not contain internal whitespace")

    if _URL_SCHEME_MARKER in username:
        raise ValueError("handle must not be a URL")

    return username
