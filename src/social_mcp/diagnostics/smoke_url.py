"""Deterministic URL canonicalisation helper for smoke diagnostics."""

from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

__all__ = ["canonicalize_url"]


def canonicalize_url(url: str) -> str:
    """Return a deterministic canonical form of ``url``.

    The scheme, host (including any port), path, and fragment are preserved
    verbatim. Query parameters are sorted by key and then by value while
    duplicate keys and repeated parameters are preserved. An empty query never
    leaves a trailing ``?`` behind, and percent-encoded values are kept exactly
    as supplied so they are never re-encoded.
    """
    scheme, netloc, path, query, fragment = urlsplit(url)
    return urlunsplit((scheme, netloc, path, _canonical_query(query), fragment))


def _canonical_query(query: str) -> str:
    """Sort raw ``key=value`` pairs of a query string, keeping duplicates."""
    if not query:
        return ""

    pairs: list[tuple[str, str]] = []
    for token in query.split("&"):
        if not token:
            # Tolerate stray separators; they carry no parameter.
            continue
        key, _, value = token.partition("=")
        pairs.append((key, value))

    pairs.sort()
    return "&".join(f"{key}={value}" for key, value in pairs)
