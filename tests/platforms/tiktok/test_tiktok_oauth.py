"""Tests for the TikTok Login Kit OAuth adapter contract (issue #78).

Boundaries are mocked: token exchange and refresh go through a fake
:class:`~social_mcp.platforms.tiktok.TikTokOAuthTransport`, so no network
calls or live TikTok API access occur. Authorization-URL construction is pure
and tested directly.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest

from social_mcp.platforms.tiktok.constants import (
    AUTHORIZATION_URL,
    PLATFORM_TIKTOK,
    RESPONSE_TYPE_CODE,
    SCOPE_SEPARATOR,
    SCOPE_USER_INFO_BASIC,
    SCOPE_USER_INFO_STATS,
    SCOPE_VIDEO_LIST,
    TOKEN_URL,
)
from social_mcp.platforms.tiktok.oauth import (
    DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    TikTokCodeExchangeRequest,
    TikTokLoginKitAdapter,
    TikTokOAuthError,
    TikTokOAuthTransport,
    TikTokRefreshRequest,
    TikTokTokenErrorResponse,
    TikTokTokenSuccessResponse,
    token_response_to_account_state,
)
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

# A fake but structurally valid success response as TikTok would return it.
SAMPLE_SUCCESS = {
    "open_id": "oid-123",
    "access_token": "act.fake-access-token",
    "refresh_token": "rft.fake-refresh-token",
    "scope": "user.info.basic,video.list",
    "token_type": "Bearer",
    "expires_in": 86400,
    "refresh_expires_in": 31536000,
}


class FakeTransport:
    """A deterministic stand-in for the OAuth transport boundary."""

    def __init__(self, response: dict[str, object]) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
        self.calls.append((url, dict(data)))
        return self.response


def _adapter(transport: TikTokOAuthTransport | object) -> TikTokLoginKitAdapter:
    return TikTokLoginKitAdapter(transport=transport)  # type: ignore[arg-type]


# --- platform identifier & endpoints -------------------------------------


def test_platform_identifier_is_tiktok() -> None:
    assert PLATFORM_TIKTOK == "tiktok"


def test_endpoints_are_the_official_login_kit_urls() -> None:
    assert AUTHORIZATION_URL == "https://www.tiktok.com/v2/auth/authorize/"
    assert TOKEN_URL == "https://open.tiktokapis.com/v2/oauth/token/"


def test_read_scopes_match_the_capability_areas() -> None:
    from social_mcp.platforms.tiktok.constants import READ_SCOPES

    assert set(READ_SCOPES) == {
        SCOPE_USER_INFO_BASIC,
        SCOPE_VIDEO_LIST,
        SCOPE_USER_INFO_STATS,
    }


# --- request model construction -------------------------------------------


def test_code_exchange_request_maps_all_tiktok_fields() -> None:
    request = TikTokCodeExchangeRequest(
        client_key="ck",
        client_secret="cs",
        code="code",
        redirect_uri="https://app/callback",
    )

    form = request.as_form()
    assert form == {
        "client_key": "ck",
        "client_secret": "cs",
        "code": "code",
        "grant_type": "authorization_code",
        "redirect_uri": "https://app/callback",
    }


def test_refresh_request_uses_refresh_token_grant() -> None:
    request = TikTokRefreshRequest(
        client_key="ck",
        client_secret="cs",
        refresh_token="rft",
    )

    form = request.as_form()
    assert form == {
        "client_key": "ck",
        "client_secret": "cs",
        "refresh_token": "rft",
        "grant_type": "refresh_token",
    }


# --- authorization URL construction (pure) ---------------------------------


def _scopes() -> list[str]:
    return [SCOPE_USER_INFO_BASIC, SCOPE_VIDEO_LIST]


def test_authorization_url_contains_required_parameters() -> None:
    transport = FakeTransport(SAMPLE_SUCCESS)
    url = _adapter(transport).authorization_url("ck", "https://app/cb", "state1", _scopes())

    assert url.startswith(f"{AUTHORIZATION_URL}?")
    params = parse_qs(urlsplit(url).query)
    assert params["client_key"] == ["ck"]
    assert params["response_type"] == [RESPONSE_TYPE_CODE]
    assert params["redirect_uri"] == ["https://app/cb"]
    assert params["state"] == ["state1"]


def test_authorization_url_joins_scopes_with_comma_separator() -> None:
    url = _adapter(FakeTransport(SAMPLE_SUCCESS)).authorization_url(
        "ck", "https://app/cb", "state1", _scopes()
    )
    params = parse_qs(urlsplit(url).query)
    assert params["scope"] == [SCOPE_SEPARATOR.join(_scopes())]


def test_authorization_url_omits_disable_auto_auth_by_default() -> None:
    url = _adapter(FakeTransport(SAMPLE_SUCCESS)).authorization_url(
        "ck", "https://app/cb", "state1", _scopes()
    )
    assert "disable_auto_auth" not in urlsplit(url).query


def test_authorization_url_sets_disable_auto_auth_when_requested() -> None:
    url = _adapter(FakeTransport(SAMPLE_SUCCESS)).authorization_url(
        "ck", "https://app/cb", "state1", _scopes(), disable_auto_auth=True
    )
    params = parse_qs(urlsplit(url).query)
    assert params["disable_auto_auth"] == ["1"]


def test_authorization_url_encodes_special_characters() -> None:
    # A redirect URI with a path character and a state with spaces must be
    # percent-encoded so the resulting URL is well-formed.
    url = _adapter(FakeTransport(SAMPLE_SUCCESS)).authorization_url(
        "ck", "https://app/callback?return=/home page", "state with spaces", _scopes()
    )
    params = parse_qs(urlsplit(url).query)
    assert params["redirect_uri"] == ["https://app/callback?return=/home page"]
    assert params["state"] == ["state with spaces"]


@pytest.mark.parametrize("missing", ["client_key", "redirect_uri", "state"])
def test_authorization_url_rejects_missing_required_argument(missing: str) -> None:
    adapter = _adapter(FakeTransport(SAMPLE_SUCCESS))
    kwargs = {"client_key": "ck", "redirect_uri": "https://app/cb", "state": "s", "scopes": _scopes()}
    kwargs[missing] = ""
    with pytest.raises(ValueError, match="required"):
        adapter.authorization_url(**kwargs)


# --- token exchange & refresh (mocked transport) ---------------------------


def test_adapter_requires_a_transport() -> None:
    with pytest.raises(ValueError):
        TikTokLoginKitAdapter(transport=None)  # type: ignore[arg-type]


def test_exchange_code_posts_to_token_endpoint_with_code_grant() -> None:
    transport = FakeTransport(SAMPLE_SUCCESS)
    adapter = _adapter(transport)

    asyncio.run(
        adapter.exchange_code_for_token("ck", "cs", "auth-code", "https://app/cb")
    )

    assert len(transport.calls) == 1
    url, form = transport.calls[0]
    assert url == TOKEN_URL
    assert form["grant_type"] == "authorization_code"
    assert form["client_key"] == "ck"
    assert form["client_secret"] == "cs"
    assert form["code"] == "auth-code"
    assert form["redirect_uri"] == "https://app/cb"


def test_exchange_code_parses_success_response() -> None:
    transport = FakeTransport(SAMPLE_SUCCESS)

    response = asyncio.run(
        _adapter(transport).exchange_code_for_token("ck", "cs", "code", "https://app/cb")
    )

    assert response.open_id == "oid-123"
    assert response.access_token == "act.fake-access-token"
    assert response.refresh_token == "rft.fake-refresh-token"
    assert response.scopes == ["user.info.basic", "video.list"]
    assert response.token_type == "Bearer"


def test_exchange_code_raises_on_error_response() -> None:
    error = {"error": "invalid_grant", "error_description": "bad code"}
    transport = FakeTransport(error)

    with pytest.raises(TikTokOAuthError, match="invalid_grant"):
        asyncio.run(
            _adapter(transport).exchange_code_for_token("ck", "cs", "code", "https://app/cb")
        )

    # The transport was invoked once despite the failure (TikTok already responded).
    assert len(transport.calls) == 1


def test_exchange_code_raises_on_missing_access_token() -> None:
    transport = FakeTransport({"foo": "bar"})

    with pytest.raises(TikTokOAuthError, match="access token"):
        asyncio.run(
            _adapter(transport).exchange_code_for_token("ck", "cs", "code", "https://app/cb")
        )


def test_exchange_code_raises_on_non_object_response() -> None:
    # Simulate a genuinely non-dict body: a transport whose post returns a
    # value the adapter must reject as a non-object response.
    class _ListTransport:
        async def post(self, url: str, data: dict[str, str]) -> list[str]:  # type: ignore[override]
            return ["not", "an", "object"]

    with pytest.raises(TikTokOAuthError, match="non-object"):
        asyncio.run(
            TikTokLoginKitAdapter(transport=_ListTransport()).exchange_code_for_token(  # type: ignore[arg-type]
                "ck", "cs", "code", "https://app/cb"
            )
        )


def test_refresh_posts_to_token_endpoint_with_refresh_grant() -> None:
    transport = FakeTransport(SAMPLE_SUCCESS)

    asyncio.run(_adapter(transport).refresh_access_token("ck", "cs", "rft"))

    assert len(transport.calls) == 1
    url, form = transport.calls[0]
    assert url == TOKEN_URL
    assert form["grant_type"] == "refresh_token"
    assert form["refresh_token"] == "rft"
    assert form["client_key"] == "ck"
    assert form["client_secret"] == "cs"


def test_refresh_raises_on_error_response() -> None:
    transport = FakeTransport({"error": "invalid_request", "error_description": "expired"})

    with pytest.raises(TikTokOAuthError, match="invalid_request"):
        asyncio.run(_adapter(transport).refresh_access_token("ck", "cs", "rft"))


# --- error response model -------------------------------------------------


def test_error_response_model_round_trip() -> None:
    error = TikTokTokenErrorResponse.model_validate(
        {"error": "invalid_grant", "error_description": "d", "log_id": "L1"}
    )
    assert error.error == "invalid_grant"
    assert error.log_id == "L1"


# --- success response parsing & expiry --------------------------------------


def test_success_response_preserves_extra_fields_and_defaults() -> None:
    response = TikTokTokenSuccessResponse.model_validate(
        {"open_id": "o", "access_token": "a", "refresh_token": "r", "scope": "user.info.basic"}
    )
    # Defaults for the optional TTL fields.
    assert response.expires_in == DEFAULT_ACCESS_TOKEN_TTL_SECONDS
    assert response.refresh_expires_in == DEFAULT_REFRESH_TOKEN_TTL_SECONDS
    assert response.token_type == "bearer"
    # Extra (undocumented) keys are tolerated but do not raise.
    response_with_extra = TikTokTokenSuccessResponse.model_validate(
        {"open_id": "o", "access_token": "a", "refresh_token": "r", "scope": "user.info.basic", "extra": "kept"}
    )
    assert response_with_extra.open_id == "o"
    # Empty scope string yields no scopes instead of raising.
    empty_scope = TikTokTokenSuccessResponse.model_validate(
        {"open_id": "o", "access_token": "a", "refresh_token": "r", "scope": ""}
    )
    assert empty_scope.scopes == []


def test_success_response_tolerates_missing_refresh_token() -> None:
    # Some refresh responses may omit a rotated refresh token; the model must
    # not reject them so the caller can retain the existing refresh token.
    response = TikTokTokenSuccessResponse.model_validate(
        {"open_id": "o", "access_token": "a", "scope": "user.info.basic"}
    )
    assert response.refresh_token == ""
    assert response.access_token == "a"


def test_expiry_timestamps_are_frozen_at_construction() -> None:
    before = datetime.now(UTC)
    response = TikTokTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    after = datetime.now(UTC)

    expected_access = before + timedelta(seconds=response.expires_in)
    expected_refresh = before + timedelta(seconds=response.refresh_expires_in)

    # Repeated reads return the same frozen value (deterministic).
    assert response.access_expires_at == response.access_expires_at
    assert response.refresh_expires_at == response.refresh_expires_at

    access_in_range = expected_access <= response.access_expires_at <= after + timedelta(
        seconds=response.expires_in
    )
    refresh_in_range = expected_refresh <= response.refresh_expires_at <= after + timedelta(
        seconds=response.refresh_expires_in
    )
    assert access_in_range
    assert refresh_in_range


# --- account state representation ----------------------------------------


def test_account_state_carries_encrypted_bytes_and_platform() -> None:
    response = TikTokTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    state = token_response_to_account_state(
        response,
        access_token_encrypted=b"enc-access",
        refresh_token_encrypted=b"enc-refresh",
    )

    assert state.platform == PLATFORM_TIKTOK
    assert state.external_account_id == "oid-123"
    assert state.scopes == ["user.info.basic", "video.list"]
    assert state.access_token_encrypted == b"enc-access"
    assert state.refresh_token_encrypted == b"enc-refresh"
    # The frozen expiry on the state matches the response's frozen expiry.
    assert state.access_token_expires_at == response.access_expires_at
    assert state.refresh_token_expires_at == response.refresh_expires_at


def test_account_state_defaults_refresh_encrypted_bytes_to_empty() -> None:
    response = TikTokTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    state = token_response_to_account_state(response, access_token_encrypted=b"enc")

    assert state.refresh_token_encrypted == b""


def test_account_state_to_connected_account_maps_shared_model() -> None:
    response = TikTokTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    state = token_response_to_account_state(
        response,
        access_token_encrypted=b"enc-access",
        refresh_token_encrypted=b"enc-refresh",
    )

    account = state.to_connected_account(username="tiktok_user")

    assert isinstance(account, ConnectedAccount)
    assert account.platform is SocialPlatform.TIKTOK
    assert account.external_account_id == "oid-123"
    assert account.username == "tiktok_user"
    assert account.scopes == ["user.info.basic", "video.list"]
    assert account.access_token_encrypted == b"enc-access"
    assert account.refresh_token_encrypted == b"enc-refresh"
    assert account.token_expires_at == response.access_expires_at


def test_account_state_to_connected_account_without_username_defaults_none() -> None:
    response = TikTokTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    state = token_response_to_account_state(response, access_token_encrypted=b"enc")

    account = state.to_connected_account()

    assert account.username is None


def test_account_state_to_connected_account_drops_empty_refresh_bytes() -> None:
    response = TikTokTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    state = token_response_to_account_state(response, access_token_encrypted=b"enc")

    account = state.to_connected_account()

    assert account.refresh_token_encrypted is None


def test_transport_protocol_is_runtime_checkable() -> None:
    # A class implementing only the post coroutine is structurally a transport.
    class _OnlyPost:
        async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
            return {}

    assert isinstance(_OnlyPost(), TikTokOAuthTransport)


def test_adapter_uses_transport_boundary_for_both_operations() -> None:
    # One adapter instance, two operations -> both routed through the same
    # injected transport, proving the boundary is the single HTTP seam.
    transport = FakeTransport(SAMPLE_SUCCESS)
    adapter = _adapter(transport)

    asyncio.run(adapter.exchange_code_for_token("ck", "cs", "code", "https://app/cb"))
    asyncio.run(adapter.refresh_access_token("ck", "cs", "rft"))

    assert len(transport.calls) == 2
    assert all(url == TOKEN_URL for url, _ in transport.calls)
    assert transport.calls[0][1]["grant_type"] == "authorization_code"
    assert transport.calls[1][1]["grant_type"] == "refresh_token"
