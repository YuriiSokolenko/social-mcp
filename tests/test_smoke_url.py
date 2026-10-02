"""Focused coverage for social_mcp.diagnostics.smoke_url.canonicalize_url."""

from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

import pytest

from social_mcp.diagnostics.smoke_url import canonicalize_url


def test_sorts_query_parameters_by_key():
    assert (
        canonicalize_url("https://example.com/api?b=2&a=1&c=3")
        == "https://example.com/api?a=1&b=2&c=3"
    )


def test_sorts_by_value_for_equal_keys():
    assert (
        canonicalize_url("https://example.com/api?a=2&a=1")
        == "https://example.com/api?a=1&a=2"
    )


def test_preserves_duplicate_keys():
    canonical = canonicalize_url("https://example.com/api?tag=b&tag=a&tag=c")

    assert canonical == "https://example.com/api?tag=a&tag=b&tag=c"
    assert canonical.count("tag=") == 3


def test_duplicate_keys_keep_all_values_after_sorting():
    canonical = canonicalize_url("https://example.com/q?k=zebra&k=apple&k=mango")

    assert canonical == "https://example.com/q?k=apple&k=mango&k=zebra"
    assert canonical.count("k=") == 3


def test_preserves_blank_values():
    assert canonicalize_url("https://example.com/api?b=1&a=") == "https://example.com/api?a=&b=1"


def test_multiple_blank_values_preserved():
    assert canonicalize_url("https://example.com/api?a=&a=") == "https://example.com/api?a=&a="


def test_empty_query_has_no_trailing_question_mark():
    assert canonicalize_url("https://example.com/api?") == "https://example.com/api"


def test_bare_origin_without_query():
    assert canonicalize_url("https://example.com") == "https://example.com"


def test_url_with_no_query_is_unchanged():
    url = "https://example.com:8443/social/feed"

    assert canonicalize_url(url) == url


def test_preserves_scheme_case_and_host_and_port():
    assert (
        canonicalize_url("https://EXAMPLE.com:8443/path?b=2&a=1")
        == "https://EXAMPLE.com:8443/path?a=1&b=2"
    )


def test_preserves_fragment_after_query():
    assert (
        canonicalize_url("https://example.com/page?b=2&a=1#frag")
        == "https://example.com/page?a=1&b=2#frag"
    )


def test_preserves_fragment_when_query_is_empty():
    assert canonicalize_url("https://example.com/page?#frag") == "https://example.com/page#frag"


def test_preserves_fragment_without_query():
    assert canonicalize_url("https://example.com/page#frag") == "https://example.com/page#frag"


def test_does_not_double_encode_percent_values():
    assert (
        canonicalize_url("https://example.com/q?next=%2Fhome%2Fme&a=1")
        == "https://example.com/q?a=1&next=%2Fhome%2Fme"
    )


def test_decoded_and_encoded_values_share_one_representation():
    assert (
        canonicalize_url("https://example.com/q?title=a%20b&other=%20")
        == "https://example.com/q?other=%20&title=a%20b"
    )


def test_encoded_untouched_when_no_query_sorting_needed():
    url = "https://example.com/path?only=%2F%2Fx"

    assert canonicalize_url(url) == url


def test_preserves_path_and_port_with_fragment_and_query():
    canonical = canonicalize_url("http://user:pw@example.org:8080/a/b?z=1&a=2#frag")

    assert canonical == "http://user:pw@example.org:8080/a/b?a=2&z=1#frag"


def test_idempotent():
    url = "https://example.com/api?b=2&a=1&a=0#frag"

    once = canonicalize_url(url)

    assert canonicalize_url(once) == once


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com",
        "https://example.com/",
        "https://example.com:8443/p?b=2&a=1#frag",
        "https://example.com/p?tag=b&tag=a&z=",
        "https://example.com/p",
        "https://example.com/p?",
        "https://example.com/p#frag",
        "https://example.com/p?n=%20",
    ],
)
def test_structure_is_preserved(url):
    original = urlsplit(url)
    canonical = urlsplit(canonicalize_url(url))

    assert canonical.scheme == original.scheme
    assert canonical.netloc == original.netloc
    assert canonical.path == original.path
    assert canonical.fragment == original.fragment
    assert urlunsplit(canonical) == canonicalize_url(url)
