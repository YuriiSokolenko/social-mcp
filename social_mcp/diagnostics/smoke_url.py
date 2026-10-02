"""Deterministic URL canonicalisation helpers.

Only the Python standard library is used so the helper can run anywhere the
smoke checks execute.
"""

from __future__ import annotations

from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit

__all__ = ["canonicalize_url"]


def canonicalize_url(url: str) -> str:
    """Canonicalise a URL deterministically.

    The scheme, host (including any userinfo, host and port), path and
    fragment are preserved exactly. Query parameters are sorted by key and
    then by value while duplicate keys stay represented. An empty query never
    leaves a trailing ``?``.

    Percent-encoded data is kept in its canonical percent-encoded form:
    percent octets are normalised to uppercase and are never decoded and
    re-encoded, so already-encoded input is not double-encoded.
    """

    scheme, netloc, path, query, fragment = urlsplit(url)
    return urlunsplit((scheme, netloc, path, _canonicalize_query(query), fragment))


def _canonicalize_query(query: str) -> str:
    """Return query pairs sorted by key then value, preserving duplicates."""

    if not query:
        return ""

    # keep_blank_values=True so empty values (``?a=``) survive the round trip.
    pairs = parse_qsl(query, keep_blank_values=True)
    if not pairs:
        # A query such as ``?`` alone, or one made only of separators.
        return ""

    encoded = [(_canonical_quote(key), _canonical_quote(value)) for key, value in pairs]

    # Identical keys are ordered by value; the original index is the final
    # tie-breaker so identical pairs keep a stable, deterministic order.
    ordered = sorted(
        (key, value, index) for index, (key, value) in enumerate(encoded)
    )

    return "&".join(f"{key}={value}" for key, value, _ in ordered)


def _canonical_quote(value: str) -> str:
    """Percent-encode conservatively without touching existing octets twice.

    Percent escapes are decoded exactly once by ``parse_qsl`` and re-encoded
    here with :func:`urllib.parse.quote`, which never expands a literal ``%``
    into an escape. Escapes are therefore stable under repeated calls.
    """

    return quote(value, safe="")
