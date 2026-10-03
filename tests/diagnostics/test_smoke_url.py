"""Focused coverage for the smoke URL canonicalisation helper."""

import pytest

from social_mcp.diagnostics.smoke_url import canonicalize_url


def test_canonicalize_sorts_query_parameters_by_key() -> None:
    assert (
        canonicalize_url("https://example.com/api?utm=b&api=a")
        == "https://example.com/api?api=a&utm=b"
    )


def test_canonicalize_is_idempotent() -> None:
    once = canonicalize_url("https://example.com/api?b=2&a=1")
    assert once == "https://example.com/api?a=1&b=2"
    assert canonicalize_url(once) == once


def test_canonicalize_sorts_duplicate_keys_by_value_and_keeps_them() -> None:
    assert (
        canonicalize_url("https://example.com/f?b=2&a=2&a=1&b=1")
        == "https://example.com/f?a=1&a=2&b=1&b=2"
    )


def test_canonicalize_keeps_blank_values() -> None:
    assert canonicalize_url("https://example.com/s?q=&q=1") == (
        "https://example.com/s?q=&q=1"
    )
    assert canonicalize_url("https://example.com/s?b=1&a=") == (
        "https://example.com/s?a=&b=1"
    )


def test_canonicalize_preserves_fragment() -> None:
    assert canonicalize_url("https://example.com/page#frag") == (
        "https://example.com/page#frag"
    )
    assert canonicalize_url("https://example.com/page?b=1&a=2#frag") == (
        "https://example.com/page?a=2&b=1#frag"
    )


def test_canonicalize_preserves_port() -> None:
    assert canonicalize_url("http://example.com:8443/path?z=1&a=2") == (
        "http://example.com:8443/path?a=2&z=1"
    )


def test_canonicalize_keeps_already_encoded_values_without_double_encoding() -> None:
    url = "https://example.com/s?tag=hello%20world&other=a%2Fb"
    assert canonicalize_url(url) == (
        "https://example.com/s?other=a%2Fb&tag=hello%20world"
    )
    assert canonicalize_url("https://example.com/s?a=%2B1") == (
        "https://example.com/s?a=%2B1"
    )
    assert "%25" not in canonicalize_url(url)


def test_canonicalize_leaves_urls_without_query_untouched() -> None:
    assert canonicalize_url("https://example.com/no-query") == (
        "https://example.com/no-query"
    )
    assert canonicalize_url("https://example.com:8443/no-query#frag") == (
        "https://example.com:8443/no-query#frag"
    )


def test_canonicalize_drops_trailing_question_mark_for_empty_query() -> None:
    assert canonicalize_url("https://example.com/empty?") == (
        "https://example.com/empty"
    )
    assert canonicalize_url("https://example.com/empty?#frag") == (
        "https://example.com/empty#frag"
    )


@pytest.mark.parametrize("url", ["https://example.com/x", "https://example.com/x?a=1"])
def test_canonicalize_is_a_no_op_for_already_canonical_urls(url: str) -> None:
    assert canonicalize_url(url) == url
