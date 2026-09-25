"""Tests for Threads capability resolution.

Capability discovery is the core deliverable of issue #18 ("server transport and
capability discovery"). These tests pin the contract that a capability is reported
**only** from the connected account's granted scopes — never from code presence —
across the no-account, partial-scope, and full-scope paths.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from social_mcp.server.capabilities import (
    CAPABILITY_DEFS,
    PLATFORM_THREADS,
    SCOPE_BASIC,
    SCOPE_CONTENT,
    SCOPE_CONTENT_PUBLISH,
    SCOPE_DELETE,
    SCOPE_INSIGHTS,
    SCOPE_MANAGE_REPLIES,
    SCOPE_MENTION,
    SCOPE_QUOTE,
    SCOPE_REPOST,
    SCOPE_SEARCH,
    is_scope_sufficient,
    resolve_threads_capabilities,
)
from social_mcp.storage.models import ConnectedAccount, SocialPlatform


def _account(scopes: list[str]) -> ConnectedAccount:
    now = datetime(2030, 1, 1, tzinfo=UTC)
    return ConnectedAccount(
        platform=SocialPlatform.THREADS,
        external_account_id="10001",
        username="tester",
        scopes=scopes,
        access_token_encrypted=b"fake-encrypted-token",
        created_at=now,
        updated_at=now,
    )


ALL_SCOPES = [
    SCOPE_BASIC,
    SCOPE_CONTENT,
    SCOPE_CONTENT_PUBLISH,
    SCOPE_MANAGE_REPLIES,
    SCOPE_REPOST,
    SCOPE_QUOTE,
    SCOPE_DELETE,
    SCOPE_INSIGHTS,
    SCOPE_SEARCH,
    SCOPE_MENTION,
]


def test_platform_is_threads() -> None:
    assert PLATFORM_THREADS == "threads"


def test_no_connected_account_marks_every_capability_unavailable() -> None:
    resolved = resolve_threads_capabilities(None)

    assert resolved.platform == PLATFORM_THREADS
    assert resolved.connected is False
    assert resolved.available == []
    for cap in resolved.capabilities.values():
        assert cap.available is False
        assert cap.reason == "no connected account"


def test_all_capability_names_are_defined_once() -> None:
    names = [name for name, _, _ in CAPABILITY_DEFS]
    assert len(names) == len(set(names))  # no duplicate capability names


def test_full_scope_account_marks_every_capability_available() -> None:
    resolved = resolve_threads_capabilities(_account(ALL_SCOPES))

    assert resolved.connected is True
    assert set(resolved.available) == {name for name, _, _ in CAPABILITY_DEFS}
    assert set(resolved.capabilities) == set(resolved.available)
    for cap in resolved.capabilities.values():
        assert cap.available is True
        assert cap.reason == ""
        assert cap.requires_scopes  # each declares its required scopes


def test_partial_scope_account_reports_only_granted_capabilities() -> None:
    # Only basic + content: profile and posts available; nothing else.
    resolved = resolve_threads_capabilities(_account([SCOPE_BASIC, SCOPE_CONTENT]))

    assert resolved.connected is True
    assert resolved.available == ["profile", "posts"]

    unavailable = {
        name: cap for name, cap in resolved.capabilities.items() if not cap.available
    }
    # profile and posts are the only ones available, so they are absent here.
    assert "profile" not in unavailable
    assert "posts" not in unavailable
    # Every unavailable capability cites the missing scope, never code presence.
    assert unavailable["replies"].reason == f"missing required scope {SCOPE_MANAGE_REPLIES}"
    assert unavailable["publish"].reason == f"missing required scope {SCOPE_CONTENT_PUBLISH}"

    for cap in unavailable.values():
        assert "scope" in cap.reason

    # reply_management needs both content_publish and manage_replies.
    reply_mgmt = resolved.capabilities["reply_management"]
    assert reply_mgmt.available is False
    assert SCOPE_CONTENT_PUBLISH in reply_mgmt.requires_scopes
    assert SCOPE_MANAGE_REPLIES in reply_mgmt.requires_scopes


def test_reply_management_requires_both_scopes() -> None:
    # Having publish but not manage_replies -> not available.
    only_publish = resolve_threads_capabilities(_account([SCOPE_CONTENT_PUBLISH]))
    assert only_publish.capabilities["reply_management"].available is False

    # Having manage_replies but not publish -> still not available, because both
    # are required. This is the whole point of "no capability from code presence."
    only_replies = resolve_threads_capabilities(_account([SCOPE_MANAGE_REPLIES]))
    assert only_replies.capabilities["reply_management"].available is False

    # Both -> available.
    both = resolve_threads_capabilities(_account([SCOPE_CONTENT_PUBLISH, SCOPE_MANAGE_REPLIES]))
    assert both.capabilities["reply_management"].available is True


def test_extra_scopes_do_not_enable_unrelated_capabilities() -> None:
    # Granting insights must not flip publish (requires content_publish) on.
    resolved = resolve_threads_capabilities(_account([SCOPE_INSIGHTS]))
    assert resolved.capabilities["insights"].available is True
    assert resolved.capabilities["publish"].available is False
    assert resolved.capabilities["publish"].requires_scopes == [SCOPE_CONTENT_PUBLISH]


def test_no_capability_available_without_a_connected_account_even_with_scopes_concept() -> None:
    # resolve takes only the account object; None always wins regardless of what
    # scopes *could* be present, since there is no account to carry them.
    resolved = resolve_threads_capabilities(None)
    assert all(not cap.available for cap in resolved.capabilities.values())
    assert resolved.connected is False


def test_reasons_never_contain_token_placeholders() -> None:
    account = _account([SCOPE_BASIC])
    resolved = resolve_threads_capabilities(account)
    # Capability resolution is derived only from scopes; serialized output
    # must never leak token material stored on the account model.
    blob = resolved.model_dump_json()
    assert "access_token" not in blob
    assert "refresh_token" not in blob
    assert "fake-encrypted-token" not in blob
    assert "token" not in blob
    for cap in resolved.capabilities.values():
        assert "token" not in cap.reason
        assert "encrypted" not in cap.reason


@pytest.mark.parametrize(
    ("scopes", "expected_available"),
    [
        ([SCOPE_BASIC], ["profile"]),
        ([SCOPE_CONTENT], ["posts"]),
        ([SCOPE_INSIGHTS], ["insights"]),
        ([SCOPE_SEARCH], ["search"]),
        ([SCOPE_MENTION], ["mentions"]),
        ([SCOPE_REPOST], ["repost"]),
        ([SCOPE_QUOTE], ["quote"]),
        ([SCOPE_DELETE], ["delete"]),
    ],
)
def test_each_scope_unlocks_its_singleton_capability(scopes, expected_available) -> None:
    resolved = resolve_threads_capabilities(_account(scopes))
    assert resolved.available == expected_available


def test_is_scope_sufficient_is_false_for_no_account() -> None:
    assert is_scope_sufficient(None, [SCOPE_BASIC]) is False
    assert is_scope_sufficient(None, []) is False


def test_is_scope_sufficient_checks_all_required_scopes() -> None:
    account = _account([SCOPE_BASIC, SCOPE_CONTENT])
    assert is_scope_sufficient(account, [SCOPE_BASIC]) is True
    assert is_scope_sufficient(account, [SCOPE_BASIC, SCOPE_CONTENT]) is True
    assert is_scope_sufficient(account, [SCOPE_BASIC, SCOPE_INSIGHTS]) is False
    assert is_scope_sufficient(account, [SCOPE_INSIGHTS]) is False


def test_threads_capabilities_model_serializes_expected_fields() -> None:
    resolved = resolve_threads_capabilities(_account([SCOPE_BASIC]))
    dumped = resolved.model_dump()
    assert dumped["platform"] == "threads"
    assert dumped["connected"] is True
    assert "capabilities" in dumped
    assert "profile" in dumped["capabilities"]
    # Each capability carries the structural fields used by clients/tests.
    cap = dumped["capabilities"]["profile"]
    assert set(cap) == {"available", "name", "reason", "requires_scopes"}
