"""Tests for the TikTok scope-to-capability mapping (issue #78).

Capability discovery mirrors the Threads pattern in
``tests/server/test_capabilities.py``: a capability is reported **only** from
the connected account's granted scopes, never from code presence. These tests
pin that contract for the TikTok profile/video/statistics capability areas.
"""

from __future__ import annotations

from datetime import UTC, datetime

from social_mcp.platforms.tiktok.capabilities import (
    TIKTOK_CAPABILITY_DEFS,
    TikTokCapabilities,
    TikTokCapability,
    is_tiktok_scope_sufficient,
    resolve_tiktok_capabilities,
)
from social_mcp.platforms.tiktok.constants import (
    PLATFORM_TIKTOK,
    SCOPE_USER_INFO_BASIC,
    SCOPE_USER_INFO_STATS,
    SCOPE_VIDEO_LIST,
)
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

ALL_TIKTOK_SCOPES = [
    SCOPE_USER_INFO_BASIC,
    SCOPE_VIDEO_LIST,
    SCOPE_USER_INFO_STATS,
]


def _account(scopes: list[str]) -> ConnectedAccount:
    now = datetime(2030, 1, 1, tzinfo=UTC)
    return ConnectedAccount(
        platform=SocialPlatform.TIKTOK,
        external_account_id="oid-123",
        username="tiktok_user",
        scopes=scopes,
        access_token_encrypted=b"fake-encrypted-token",
        created_at=now,
        updated_at=now,
    )


# --- platform identifier & definition shape --------------------------------


def test_platform_is_tiktok() -> None:
    assert PLATFORM_TIKTOK == "tiktok"


def test_capability_names_are_profile_video_statistics() -> None:
    names = [name for name, _, _ in TIKTOK_CAPABILITY_DEFS]
    assert names == ["profile", "video", "statistics"]


def test_each_capability_name_appears_exactly_once() -> None:
    names = [name for name, _, _ in TIKTOK_CAPABILITY_DEFS]
    assert len(names) == len(set(names))


def test_each_capability_requires_its_own_read_scope() -> None:
    for name, _, required in TIKTOK_CAPABILITY_DEFS:
        assert len(required) == 1, name
        assert isinstance(name, str)


def test_capability_to_scope_mapping_matches_contract() -> None:
    mapping = {name: required for name, _, required in TIKTOK_CAPABILITY_DEFS}
    assert mapping["profile"] == [SCOPE_USER_INFO_BASIC]
    assert mapping["video"] == [SCOPE_VIDEO_LIST]
    assert mapping["statistics"] == [SCOPE_USER_INFO_STATS]


def test_statistics_scope_value_is_real_tiktok_scope() -> None:
    # Regression guard for issue #78: the statistics capability must be backed
    # by TikTok's real "user.info.stats" Login Kit scope ("Read access to a
    # user's statistical data..."), not the non-existent "analytics.dashboard"
    # scope. See the TikTok Scopes Reference at developers.tiktok.com.
    assert SCOPE_USER_INFO_STATS == "user.info.stats"
    assert SCOPE_USER_INFO_STATS != "analytics.dashboard"


# --- no connected account --------------------------------------------------


def test_no_connected_account_marks_every_capability_unavailable() -> None:
    resolved = resolve_tiktok_capabilities(None)

    assert resolved.platform == PLATFORM_TIKTOK
    assert resolved.connected is False
    assert resolved.available == []
    for cap in resolved.capabilities.values():
        assert cap.available is False
        assert cap.reason == "no connected account"


# --- full scope account ----------------------------------------------------


def test_full_scope_account_marks_every_capability_available() -> None:
    resolved = resolve_tiktok_capabilities(_account(ALL_TIKTOK_SCOPES))

    assert resolved.connected is True
    assert set(resolved.available) == {name for name, _, _ in TIKTOK_CAPABILITY_DEFS}
    assert set(resolved.capabilities) == set(resolved.available)
    for cap in resolved.capabilities.values():
        assert cap.available is True
        assert cap.reason == ""
        assert cap.requires_scopes  # each declares its required scope


# --- partial scope account -------------------------------------------------


def test_partial_scope_account_reports_only_granted_capabilities() -> None:
    resolved = resolve_tiktok_capabilities(
        _account([SCOPE_USER_INFO_BASIC, SCOPE_VIDEO_LIST])
    )

    assert resolved.connected is True
    assert resolved.available == ["profile", "video"]

    unavailable = {n: cap for n, cap in resolved.capabilities.items() if not cap.available}
    assert "statistics" in unavailable
    assert unavailable["statistics"].reason == (
        f"missing required scope {SCOPE_USER_INFO_STATS}"
    )
    assert "profile" not in unavailable
    assert "video" not in unavailable


def test_each_scope_unlocks_only_its_singleton_capability() -> None:
    cases = [
        ([SCOPE_USER_INFO_BASIC], ["profile"]),
        ([SCOPE_VIDEO_LIST], ["video"]),
        ([SCOPE_USER_INFO_STATS], ["statistics"]),
    ]
    for scopes, expected in cases:
        resolved = resolve_tiktok_capabilities(_account(scopes))
        assert resolved.available == expected, scopes


def test_extra_scopes_do_not_enable_unrelated_capabilities() -> None:
    # Granting statistics must not flip the profile capability (needs basic).
    resolved = resolve_tiktok_capabilities(_account([SCOPE_USER_INFO_STATS]))
    assert resolved.capabilities["statistics"].available is True
    assert resolved.capabilities["profile"].available is False
    assert resolved.capabilities["profile"].requires_scopes == [SCOPE_USER_INFO_BASIC]


def test_no_capability_available_without_a_connected_account() -> None:
    resolved = resolve_tiktok_capabilities(None)
    assert all(not cap.available for cap in resolved.capabilities.values())
    assert resolved.connected is False


# --- reasons never leak token material -------------------------------------


def test_reasons_never_contain_token_placeholders() -> None:
    account = _account([SCOPE_USER_INFO_BASIC])
    resolved = resolve_tiktok_capabilities(account)

    blob = resolved.model_dump_json()
    assert "access_token" not in blob
    assert "refresh_token" not in blob
    assert "fake-encrypted-token" not in blob
    for cap in resolved.capabilities.values():
        assert "token" not in cap.reason
        assert "encrypted" not in cap.reason


# --- model shape -----------------------------------------------------------


def test_tiktok_capabilities_model_serializes_expected_fields() -> None:
    resolved = resolve_tiktok_capabilities(_account([SCOPE_USER_INFO_BASIC]))
    dumped = resolved.model_dump()
    assert dumped["platform"] == "tiktok"
    assert dumped["connected"] is True
    assert "capabilities" in dumped
    assert "profile" in dumped["capabilities"]
    cap = dumped["capabilities"]["profile"]
    assert set(cap) == {"available", "name", "reason", "requires_scopes"}


def test_capability_model_defaults() -> None:
    cap = TikTokCapability(name="profile", available=False, requires_scopes=[SCOPE_USER_INFO_BASIC])
    assert cap.reason == ""


# --- is_tiktok_scope_sufficient helper -------------------------------------


def test_is_tiktok_scope_sufficient_is_false_for_no_account() -> None:
    assert is_tiktok_scope_sufficient(None, [SCOPE_USER_INFO_BASIC]) is False
    assert is_tiktok_scope_sufficient(None, []) is False


def test_is_tiktok_scope_sufficient_checks_all_required_scopes() -> None:
    account = _account([SCOPE_USER_INFO_BASIC, SCOPE_VIDEO_LIST])
    assert is_tiktok_scope_sufficient(account, [SCOPE_USER_INFO_BASIC]) is True
    assert (
        is_tiktok_scope_sufficient(account, [SCOPE_USER_INFO_BASIC, SCOPE_VIDEO_LIST])
        is True
    )
    assert is_tiktok_scope_sufficient(account, [SCOPE_USER_INFO_STATS]) is False
    assert is_tiktok_scope_sufficient(account, [SCOPE_USER_INFO_BASIC, SCOPE_USER_INFO_STATS]) is False


def test_is_tiktok_scope_sufficient_with_empty_required_is_true_for_account() -> None:
    # An account with no required scopes is trivially sufficient for an empty
    # requirement list (mirrors the Threads helper semantics).
    account = _account([])
    assert is_tiktok_scope_sufficient(account, []) is True


# --- resolved model type ---------------------------------------------------


def test_resolve_returns_tiktok_capabilities_type() -> None:
    resolved = resolve_tiktok_capabilities(_account(ALL_TIKTOK_SCOPES))
    assert isinstance(resolved, TikTokCapabilities)
    assert all(isinstance(c, TikTokCapability) for c in resolved.capabilities.values())
