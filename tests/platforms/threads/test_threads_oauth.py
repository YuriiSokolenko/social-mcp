"""Tests for the Threads/Meta OAuth adapter contract (issue #16).

Boundaries are mocked: token exchange goes through a fake
:class:`~social_mcp.platforms.threads.ThreadsOAuthTransport`, so no network
calls or live Meta/Threads API access occur. Authorization-URL construction is
pure and tested directly.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest

from social_mcp.platforms.threads.constants import (
    ALL_SCOPES,
    AUTHORIZATION_URL,
    PLATFORM_THREADS,
    RESPONSE_TYPE_CODE,
    SCOPE_SEPARATOR,
    SCOPE_THREADS_BASIC,
    TOKEN_URL,
    parse_scopes,
)
from social_mcp.platforms.threads.oauth import (
    DEFAULT_SHORT_LIVED_TOKEN_TTL_SECONDS,
    ThreadsCodeExchangeRequest,
    ThreadsLoginAdapter,
    ThreadsOAuthError,
    ThreadsOAuthTransport,
    ThreadsTokenErrorResponse,
    ThreadsTokenSuccessResponse,
    token_response_to_account_state,
)
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

# A fake but structurally valid success response as Meta would return it.
SAMPLE_SUCCESS: dict = {
    "access_token": "THQVJ-fake-access-token",
    "token_type": "bearer",
    "user_id": 17841405793187218,
}


class FakeTransport:
    """A deterministic stand-in for the OAuth transport boundary."""

    def __init__(self, response: dict[str, object]) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
        self.calls.append((url, dict(data)))
        return self.response


def _adapter(transport: ThreadsOAuthTransport | object) -> ThreadsLoginAdapter:
    return ThreadsLoginAdapter(transport=transport)  # type: ignore[arg-type]


# --- platform identifier & endpoints ---------------------------------------


def test_platform_identifier_is_threads() -> None:
    assert PLATFORM_THREADS == "threads"


def test_endpoints_are_the_official_meta_urls() -> None:
    assert AUTHORIZATION_URL == "https://threads.com/oauth/authorize"
    assert TOKEN_URL == "https://graph.threads.com/oauth/access_token"


def test_scopes_includes_required_basic_scope() -> None:
    assert SCOPE_THREADS_BASIC == "threads_basic"
    assert SCOPE_THREADS_BASIC in ALL_SCOPES
    assert ALL_SCOPES[0] == SCOPE_THREADS_BASIC


def test_parse_scopes_always_includes_threads_basic() -> None:
    parsed = parse_scopes("threads_content_publish")
    assert SCOPE_THREADS_BASIC in parsed
    assert parsed[0] == SCOPE_THREADS_BASIC
    assert "threads_content_publish" in parsed


def test_parse_scopes_deduplicates_and_preserves_order() -> None:
    parsed = parse_scopes("threads_basic,threads_content_publish,threads_basic")
    assert len(parsed) == 2
    assert parsed[0] == SCOPE_THREADS_BASIC
    assert parsed[1] == "threads_content_publish"


# --- request model construction ---------------------------------------------


def test_code_exchange_request_maps_all_meta_fields() -> None:
    request = ThreadsCodeExchangeRequest(
        client_id="app-id",
        client_secret="app-secret",
        code="auth-code",
        redirect_uri="https://app/callback",
    )

    form = request.as_form()
    assert form == {
        "client_id": "app-id",
        "client_secret": "app-secret",
        "code": "auth-code",
        "grant_type": "authorization_code",
        "redirect_uri": "https://app/callback",
    }


# --- authorization URL construction (pure) ----------------------------------


def test_authorization_url_contains_required_parameters() -> None:
    url = _adapter(FakeTransport(SAMPLE_SUCCESS)).authorization_url(
        "app-id", "https://app/cb", [SCOPE_THREADS_BASIC], "state1"
    )

    assert url.startswith(f"{AUTHORIZATION_URL}?")
    params = parse_qs(urlsplit(url).query)
    assert params["client_id"] == ["app-id"]
    assert params["response_type"] == [RESPONSE_TYPE_CODE]
    assert params["redirect_uri"] == ["https://app/cb"]
    assert params["state"] == ["state1"]


def test_authorization_url_joins_scopes_with_comma_separator() -> None:
    scopes = [SCOPE_THREADS_BASIC, "threads_content_publish"]
    url = _adapter(FakeTransport(SAMPLE_SUCCESS)).authorization_url(
        "app-id", "https://app/cb", scopes, "state1"
    )
    params = parse_qs(urlsplit(url).query)
    assert params["scope"] == [SCOPE_SEPARATOR.join(scopes)]


def test_authorization_url_ensures_threads_basic_present() -> None:
    # Even if the caller omits threads_basic, it is added.
    url = _adapter(FakeTransport(SAMPLE_SUCCESS)).authorization_url(
        "app-id", "https://app/cb", ["threads_content_publish"], "state1"
    )
    params = parse_qs(urlsplit(url).query)
    scope_list = params["scope"][0].split(SCOPE_SEPARATOR)
    assert SCOPE_THREADS_BASIC in scope_list


def test_authorization_url_encodes_special_characters() -> None:
    url = _adapter(FakeTransport(SAMPLE_SUCCESS)).authorization_url(
        "app-id", "https://app/cb?return=/home page",
        [SCOPE_THREADS_BASIC], "state with spaces",
    )
    params = parse_qs(urlsplit(url).query)
    assert params["redirect_uri"] == ["https://app/cb?return=/home page"]
    assert params["state"] == ["state with spaces"]


@pytest.mark.parametrize("missing", ["client_id", "redirect_uri", "state"])
def test_authorization_url_rejects_missing_required_argument(missing: str) -> None:
    adapter = _adapter(FakeTransport(SAMPLE_SUCCESS))
    kwargs = {
        "client_id": "app-id",
        "redirect_uri": "https://app/cb",
        "state": "s",
        "scopes": [SCOPE_THREADS_BASIC],
    }
    kwargs[missing] = ""
    with pytest.raises(ValueError, match="required"):
        adapter.authorization_url(**kwargs)


# --- token exchange (mocked transport) --------------------------------------


def test_adapter_requires_a_transport() -> None:
    with pytest.raises(ValueError):
        ThreadsLoginAdapter(transport=None)  # type: ignore[arg-type]


def test_exchange_code_posts_to_token_endpoint_with_code_grant() -> None:
    transport = FakeTransport(SAMPLE_SUCCESS)
    adapter = _adapter(transport)

    import asyncio
    asyncio.run(
        adapter.exchange_code_for_token("app-id", "app-secret", "auth-code", "https://app/cb")
    )

    assert len(transport.calls) == 1
    url, form = transport.calls[0]
    assert url == TOKEN_URL
    assert form["grant_type"] == "authorization_code"
    assert form["client_id"] == "app-id"
    assert form["client_secret"] == "app-secret"
    assert form["code"] == "auth-code"
    assert form["redirect_uri"] == "https://app/cb"


def test_exchange_code_parses_success_response() -> None:
    transport = FakeTransport(SAMPLE_SUCCESS)

    import asyncio
    response = asyncio.run(
        _adapter(transport).exchange_code_for_token(
            "app-id", "app-secret", "code", "https://app/cb"
        )
    )

    assert response.access_token == "THQVJ-fake-access-token"
    assert response.token_type == "bearer"
    assert response.user_id == "17841405793187218"


def test_exchange_code_coerces_user_id_to_string() -> None:
    """Meta returns user_id as a JSON number; the model coerces it to str."""

    response = ThreadsTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    assert isinstance(response.user_id, str)
    assert response.user_id == "17841405793187218"


def test_exchange_code_raises_on_flat_meta_error_response() -> None:
    error = {
        "error_type": "OAuthException",
        "code": 400,
        "error_message": "Matching code was not found or was already used",
    }
    transport = FakeTransport(error)

    with pytest.raises(ThreadsOAuthError, match="Matching code was not found"):
        import asyncio
        asyncio.run(
            _adapter(transport).exchange_code_for_token(
                "app-id", "app-secret", "code", "https://app/cb"
            )
        )

    assert len(transport.calls) == 1


def test_exchange_code_raises_on_standard_oauth_error_response() -> None:
    error = {"error": "invalid_grant", "error_description": "bad code"}
    transport = FakeTransport(error)

    with pytest.raises(ThreadsOAuthError, match="bad code"):
        import asyncio
        asyncio.run(
            _adapter(transport).exchange_code_for_token(
                "app-id", "app-secret", "code", "https://app/cb"
            )
        )


def test_exchange_code_raises_on_missing_access_token() -> None:
    transport = FakeTransport({"user_id": 12345, "token_type": "bearer"})

    with pytest.raises(ThreadsOAuthError, match="access token"):
        import asyncio
        asyncio.run(
            _adapter(transport).exchange_code_for_token(
                "app-id", "app-secret", "code", "https://app/cb"
            )
        )


def test_exchange_code_raises_on_non_object_response() -> None:
    class _ListTransport:
        async def post(self, url: str, data: dict[str, str]) -> list[str]:
            return ["not", "an", "object"]

    with pytest.raises(ThreadsOAuthError, match="non-object"):
        import asyncio
        asyncio.run(
            ThreadsLoginAdapter(transport=_ListTransport()).exchange_code_for_token(  # type: ignore[arg-type]
                "app-id", "app-secret", "code", "https://app/cb"
            )
        )


# --- error response model --------------------------------------------------


def test_flat_error_response_message_prefers_description_then_message() -> None:
    error = ThreadsTokenErrorResponse.model_validate(
        {"error_type": "OAuthException", "error_message": "msg",
         "error_description": "desc"}
    )
    assert error.message == "desc"


def test_error_response_message_falls_back_to_error_type() -> None:
    error = ThreadsTokenErrorResponse.model_validate({"error_type": "OAuthException"})
    assert error.message == "OAuthException"


# --- success response parsing & expiry --------------------------------------


def test_success_response_preserves_extra_fields_and_defaults() -> None:
    response = ThreadsTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    # The short-lived response has no expires_in or scope.
    assert response.expires_in is None
    assert response.scope is None


def test_success_response_tolerates_extra_undocumented_fields() -> None:
    response = ThreadsTokenSuccessResponse.model_validate(
        {**SAMPLE_SUCCESS, "extra_field": "kept"}
    )
    assert response.access_token == "THQVJ-fake-access-token"
    assert response.user_id == "17841405793187218"


def test_access_expires_at_defaults_to_short_lived_ttl() -> None:
    """Without expires_in, the expiry falls back to the documented 1-hour TTL."""

    before = datetime.now(UTC)
    response = ThreadsTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    after = datetime.now(UTC)

    expected_min = before + timedelta(seconds=DEFAULT_SHORT_LIVED_TOKEN_TTL_SECONDS)
    expected_max = after + timedelta(seconds=DEFAULT_SHORT_LIVED_TOKEN_TTL_SECONDS)

    assert response.access_expires_at == response.access_expires_at  # deterministic
    assert expected_min <= response.access_expires_at <= expected_max


def test_access_expires_at_uses_expires_in_when_present() -> None:
    response = ThreadsTokenSuccessResponse.model_validate(
        {**SAMPLE_SUCCESS, "expires_in": 3600}
    )
    before = datetime.now(UTC)
    assert response.access_expires_at <= datetime.now(UTC) + timedelta(seconds=3700)
    assert before + timedelta(seconds=3500) <= response.access_expires_at


# --- account state representation -------------------------------------------


def test_account_state_carries_encrypted_bytes_and_platform() -> None:
    response = ThreadsTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    state = token_response_to_account_state(
        response,
        access_token_encrypted=b"enc-access",
        scopes=[SCOPE_THREADS_BASIC],
    )

    assert state.platform == PLATFORM_THREADS
    assert state.external_account_id == "17841405793187218"
    assert state.access_token_encrypted == b"enc-access"
    assert state.refresh_token_encrypted == b""
    assert state.token_expires_at is not None
    assert state.scopes == [SCOPE_THREADS_BASIC]
    assert state.token_expires_at == response.access_expires_at


def test_account_state_defaults_refresh_encrypted_to_empty() -> None:
    response = ThreadsTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    state = token_response_to_account_state(
        response, access_token_encrypted=b"enc"
    )
    assert state.refresh_token_encrypted == b""


def test_account_state_to_connected_account_maps_shared_model() -> None:
    response = ThreadsTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    state = token_response_to_account_state(
        response,
        access_token_encrypted=b"enc-access",
        scopes=[SCOPE_THREADS_BASIC],
    )

    account = state.to_connected_account(username="threads_user")

    assert isinstance(account, ConnectedAccount)
    assert account.platform is SocialPlatform.THREADS
    assert account.external_account_id == "17841405793187218"
    assert account.username == "threads_user"
    assert account.scopes == [SCOPE_THREADS_BASIC]
    assert account.access_token_encrypted == b"enc-access"
    assert account.refresh_token_encrypted is None
    assert account.token_expires_at == response.access_expires_at


def test_account_state_to_connected_account_without_username_defaults_none() -> None:
    response = ThreadsTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    state = token_response_to_account_state(
        response, access_token_encrypted=b"enc"
    )
    account = state.to_connected_account()
    assert account.username is None


def test_response_scopes_take_precedence_over_requested() -> None:
    """When the response includes scopes, they are used over the requested ones."""

    response = ThreadsTokenSuccessResponse.model_validate(
        {**SAMPLE_SUCCESS, "scope": "threads_basic,threads_content_publish"}
    )
    state = token_response_to_account_state(
        response,
        access_token_encrypted=b"enc",
        scopes=[SCOPE_THREADS_BASIC],  # requested fewer
    )
    assert state.scopes == ["threads_basic", "threads_content_publish"]


# --- transport protocol is runtime checkable -------------------------------


def test_transport_protocol_is_runtime_checkable() -> None:
    class _OnlyPost:
        async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
            return {}

    assert isinstance(_OnlyPost(), ThreadsOAuthTransport)


def test_adapter_uses_transport_boundary_for_exchange() -> None:
    """The adapter delegates HTTP to the injected transport, not inline."""

    transport = FakeTransport(SAMPLE_SUCCESS)
    adapter = _adapter(transport)

    import asyncio
    asyncio.run(
        adapter.exchange_code_for_token("app-id", "app-secret", "code", "https://app/cb")
    )

    assert len(transport.calls) == 1
    assert transport.calls[0][0] == TOKEN_URL
    assert transport.calls[0][1]["grant_type"] == "authorization_code"


def test_user_id_never_stored_as_integer() -> None:
    """The external_account_id is always a string, even if Meta returns an int."""

    response = ThreadsTokenSuccessResponse.model_validate(SAMPLE_SUCCESS)
    account = token_response_to_account_state(
        response, access_token_encrypted=b"enc", scopes=[SCOPE_THREADS_BASIC]
    ).to_connected_account()

    assert isinstance(account.external_account_id, str)
