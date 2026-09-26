"""TikTok OAuth connect/reconnect through the Web Admin (issue #79).

All TikTok API boundaries are mocked:

* The token exchange/refresh HTTP seam is substituted via FastAPI dependency
  overrides of :func:`social_mcp.admin.oauth.get_tiktok_adapter` with a
  :class:`TikTokLoginKitAdapter` backed by a fake transport -- no live TikTok
  calls occur.
* The real :class:`HttpTikTokOAuthTransport` is unit-tested in isolation with
  an :class:`httpx.MockTransport` (still no network) to pin its JSON/error
  mapping.

Tokens are fake but structurally valid; they are encrypted in-process with the
same throwaway Fernet key the test app configures, and tests assert the stored
bytes are encrypted (not plaintext) while decrypting back to the expected fake
values.
"""

from __future__ import annotations

import asyncio
import re
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from social_mcp.admin.oauth import (
    HttpTikTokOAuthTransport,
    get_tiktok_adapter,
    redirect_to_accounts,
)
from social_mcp.app import create_app
from social_mcp.auth.token_cipher import TokenCipher
from social_mcp.config import Settings
from social_mcp.platforms.tiktok.constants import (
    AUTHORIZATION_URL,
    READ_SCOPES,
    RESPONSE_TYPE_CODE,
    SCOPE_SEPARATOR,
    SCOPE_USER_INFO_BASIC,
    SCOPE_USER_INFO_STATS,
    SCOPE_VIDEO_LIST,
    TOKEN_URL,
)
from social_mcp.platforms.tiktok.oauth import (
    TikTokLoginKitAdapter,
    TikTokOAuthError,
    TikTokOAuthTransport,
)
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

ADMIN_AUTH = ("admin", "example-secret")
ADMIN_SESSION_SECRET = "test-session-secret-not-for-production-use"
STATE_SECRET = "test-oauth-state-secret-not-for-production-use"
TIKTOK_KEY = "test-tiktok-client-key"
TIKTOK_SECRET = "test-tiktok-client-secret"

# A structurally valid TikTok token-endpoint response.
SAMPLE_SUCCESS = {
    "open_id": "oid-123",
    "access_token": "act.fake-access-token",
    "refresh_token": "rft.fake-refresh-token",
    "scope": "user.info.basic,video.list,user.info.stats",
    "token_type": "Bearer",
    "expires_in": 86400,
    "refresh_expires_in": 31536000,
}


class FakeTransport:
    """Deterministic stand-in for the OAuth token-exchange transport."""

    def __init__(self, response: dict[str, object] | object = SAMPLE_SUCCESS) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
        self.calls.append((url, dict(data)))
        return self.response  # type: ignore[return-value]


@pytest.fixture()
def tiktok_transport() -> FakeTransport:
    """A fresh fake transport, reset per test."""
    return FakeTransport(SAMPLE_SUCCESS)


def _login(client: TestClient) -> str:
    """Log in and return the CSRF token for the established session."""
    response = client.post("/admin/login", auth=ADMIN_AUTH)
    assert response.status_code == 200
    match = re.search(r"value='([^']+)'", response.text)
    assert match is not None, "login response did not expose a CSRF token"
    return match.group(1)


@pytest.fixture()
def make_tiktok_app(tmp_path: Path, make_settings: Callable[..., Settings]):
    """App factory with TikTok and OAuth state configured.

    Returns a function that builds the app and wires a given fake transport as
    the ``get_tiktok_adapter`` dependency, so no real adapter/HTTP is used.
    """

    def build(transport: TikTokOAuthTransport) -> tuple:
        app = create_app(
            make_settings(
                tmp_path,
                admin_username="admin",
                admin_password="example-secret",
                admin_session_secret=ADMIN_SESSION_SECRET,
                tiktok_client_key=TIKTOK_KEY,
                tiktok_client_secret=TIKTOK_SECRET,
                oauth_state_secret=STATE_SECRET,
            )
        )
        adapter = TikTokLoginKitAdapter(transport=transport)
        app.dependency_overrides[get_tiktok_adapter] = lambda: adapter
        return app, adapter, transport

    return build


def _save_account(app, account: ConnectedAccount) -> ConnectedAccount:
    return app.state.container.account_store.save(account)


def _make_account(
    *,
    platform: SocialPlatform = SocialPlatform.TIKTOK,
    external_account_id: str = "oid-123",
    username: str | None = "tiktok_user",
    scopes: list[str] | None = None,
) -> ConnectedAccount:
    now = datetime(2030, 1, 1, 12, 0, 30, tzinfo=UTC)
    return ConnectedAccount(
        platform=platform,
        external_account_id=external_account_id,
        username=username,
        scopes=scopes if scopes is not None else [SCOPE_USER_INFO_BASIC],
        access_token_encrypted=b"fake-access-token-bytes",
        refresh_token_encrypted=None,
        token_expires_at=now,
        created_at=now,
        updated_at=now,
    )


def _connect(client: TestClient, token: str, path: str = "/admin/connect/tiktok") -> httpx.Response:
    return client.post(path, headers={"x-csrf-token": token}, follow_redirects=False)


def _state_from(url: str) -> str:
    return parse_qs(urlsplit(url).query)["state"][0]


# --- accounts page rendering -------------------------------------------------


def test_accounts_page_shows_tiktok_connect_when_configured_and_unconnected(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        body = client.get("/admin/accounts").text

    assert "Connect TikTok" in body
    assert 'action="/admin/connect/tiktok"' in body
    assert 'name="csrf_token"' in body
    # Threads remains a future placeholder (out of scope for this issue).
    assert "Connect Threads (coming soon)" in body


def test_accounts_page_shows_reconnect_when_tiktok_connected(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        _save_account(app, _make_account())
        client.post("/admin/login", auth=ADMIN_AUTH)
        body = client.get("/admin/accounts").text

    assert "Reconnect TikTok" in body
    assert 'action="/admin/reconnect/tiktok"' in body
    assert "Connect TikTok" not in body


def test_accounts_page_reports_unconfigured_tiktok(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """When TikTok client credentials are absent, no connect form is shown."""

    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
            oauth_state_secret=STATE_SECRET,
            # tiktok_client_key intentionally left unset.
        )
    )
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        body = client.get("/admin/accounts").text

    assert "TIKTOK_CLIENT_KEY" in body
    assert "Connect TikTok" not in body


def test_accounts_page_exposes_only_granted_capabilities(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        # Grant only the profile scope: video/statistics must be unavailable.
        _save_account(app, _make_account(scopes=[SCOPE_USER_INFO_BASIC]))
        client.post("/admin/login", auth=ADMIN_AUTH)
        body = client.get("/admin/accounts").text

    assert "TikTok capabilities" in body
    assert "profile: available" in body
    assert "statistics: unavailable" in body
    assert "video: unavailable" in body


# --- connect / reconnect initiation ----------------------------------------


def test_connect_redirects_to_tiktok_authorization_url(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)

        response = _connect(client, token)

    assert response.status_code == 303
    location = response.headers["location"]
    assert location.startswith(f"{AUTHORIZATION_URL}?")
    params = parse_qs(urlsplit(location).query)
    assert params["client_key"] == [TIKTOK_KEY]
    assert params["response_type"] == [RESPONSE_TYPE_CODE]
    assert params["scope"] == [SCOPE_SEPARATOR.join(READ_SCOPES)]
    assert params["state"]  # opaque, session-bound state
    # disable_auto_auth is set so returning users re-consent.
    assert params["disable_auto_auth"] == ["1"]
    # redirect_uri points back at this app's callback.
    assert params["redirect_uri"] == ["http://testserver/admin/oauth/callback/tiktok"]


def test_connect_requires_csrf_token(make_tiktok_app, tiktok_transport) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        _login(client)
        response = client.post("/admin/connect/tiktok", follow_redirects=False)

    assert response.status_code == 403


def test_connect_requires_an_active_session(make_tiktok_app, tiktok_transport) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        response = client.post(
            "/admin/connect/tiktok",
            headers={"x-csrf-token": "anything"},
            follow_redirects=False,
        )

    # No session -> unauthenticated POST -> 401 (not a redirect to TikTok).
    assert response.status_code == 401


def test_connect_without_tiktok_configuration_is_unavailable(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
            oauth_state_secret=STATE_SECRET,
            # tiktok_client_key intentionally left unset.
        )
    )
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        response = client.post(
            "/admin/connect/tiktok",
            headers={"x-csrf-token": token},
            follow_redirects=False,
        )

    assert response.status_code == 503


# --- graceful degradation: persistence dependencies unavailable -------------#
# When TikTok credentials are present but OAUTH_STATE_SECRET or
# TOKEN_ENCRYPTION_KEY is missing, connect/reconnect must return a graceful
# 503 rather than an unhandled 500 (the raising call now runs inside the
# try/except so the unavailability handlers actually fire).

def _base_tiktok_settings(
    make_settings: Callable[..., Settings], tmp_path: Path, **overrides
) -> Settings:
    """Build settings with TikTok configured and admin auth ready."""

    return make_settings(
        tmp_path,
        admin_username="admin",
        admin_password="example-secret",
        admin_session_secret=ADMIN_SESSION_SECRET,
        tiktok_client_key=TIKTOK_KEY,
        tiktok_client_secret=TIKTOK_SECRET,
        **overrides,
    )


def test_connect_without_oauth_state_secret_returns_503(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """TikTok configured but OAUTH_STATE_SECRET unset: connect returns 503, not 500."""

    app = create_app(_base_tiktok_settings(make_settings, tmp_path))
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        response = client.post(
            "/admin/connect/tiktok",
            headers={"x-csrf-token": token},
            follow_redirects=False,
        )

    assert response.status_code == 503


def test_connect_without_token_encryption_key_returns_503(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """TikTok configured but TOKEN_ENCRYPTION_KEY unset: connect returns 503, not 500."""

    app = create_app(_base_tiktok_settings(make_settings, tmp_path, token_encryption_key=""))
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        response = client.post(
            "/admin/connect/tiktok",
            headers={"x-csrf-token": token},
            follow_redirects=False,
        )

    assert response.status_code == 503


def test_reconnect_without_oauth_state_secret_returns_503(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """Same graceful-degradation contract for the reconnect path."""

    app = create_app(_base_tiktok_settings(make_settings, tmp_path))
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        response = client.post(
            "/admin/reconnect/tiktok",
            headers={"x-csrf-token": token},
            follow_redirects=False,
        )

    assert response.status_code == 503


def test_reconnect_without_token_encryption_key_returns_503(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """Same graceful-degradation contract for the reconnect path."""

    app = create_app(_base_tiktok_settings(make_settings, tmp_path, token_encryption_key=""))
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        response = client.post(
            "/admin/reconnect/tiktok",
            headers={"x-csrf-token": token},
            follow_redirects=False,
        )

    assert response.status_code == 503


# --- connect / reconnect initiation ----------------------------------------

def test_reconnect_redirects_to_tiktok_authorization_url(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        _save_account(app, _make_account())
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        response = client.post(
            "/admin/reconnect/tiktok",
            headers={"x-csrf-token": token},
            follow_redirects=False,
        )

    assert response.status_code == 303
    params = parse_qs(urlsplit(response.headers["location"]).query)
    assert params["client_key"] == [TIKTOK_KEY]
    assert params["state"]


# --- callback: success (connect) -------------------------------------------


def test_callback_persists_encrypted_account_and_reports_connected(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        container = app.state.container
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)

        # Initiate the flow; capture the state TikTok will echo back.
        auth_url = _connect(client, token).headers["location"]
        state = _state_from(auth_url)

        # Simulate TikTok redirecting back with a code and the same state.
        response = client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code-from-tiktok", "state": state},
            follow_redirects=False,
        )

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/accounts?tiktok=connected"

    # The exchange was performed exactly once, with the code grant.
    assert len(tiktok_transport.calls) == 1
    _url, form = tiktok_transport.calls[0]
    assert _url == TOKEN_URL
    assert form["grant_type"] == "authorization_code"
    assert form["code"] == "auth-code-from-tiktok"
    assert form["client_key"] == TIKTOK_KEY

    # The account was persisted.
    accounts = container.account_store.list_accounts()
    assert len(accounts) == 1
    account = accounts[0]
    assert account.platform is SocialPlatform.TIKTOK
    assert account.external_account_id == "oid-123"
    # Granted scopes are persisted (parsed from the comma-separated response).
    assert account.scopes == [
        SCOPE_USER_INFO_BASIC,
        SCOPE_VIDEO_LIST,
        SCOPE_USER_INFO_STATS,
    ]
    # Tokens are stored encrypted, never in plaintext.
    assert account.access_token_encrypted != b"act.fake-access-token"
    assert b"act.fake-access-token" not in account.access_token_encrypted
    assert account.refresh_token_encrypted is not None
    assert b"rft.fake-refresh-token" not in account.refresh_token_encrypted


def test_callback_tokens_decrypt_back_to_exchanged_values(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        cipher = TokenCipher(app.state.settings.token_encryption_key)  # type: ignore[arg-type]
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        state = _state_from(_connect(client, token).headers["location"])
        client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": state},
        )

        account = app.state.container.account_store.list_accounts()[0]
    assert cipher.decrypt(account.access_token_encrypted) == "act.fake-access-token"
    assert cipher.decrypt(account.refresh_token_encrypted) == "rft.fake-refresh-token"


def test_callback_reports_reconnected_when_account_already_exists(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        _save_account(app, _make_account())
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        state = _state_from(_connect(client, token).headers["location"])
        response = client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": state},
            follow_redirects=False,
        )

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/accounts?tiktok=reconnected"


# --- callback: failure modes -----------------------------------------------


def test_callback_without_code_or_state_reports_error(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        response = client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "only-code"},
            follow_redirects=False,
        )

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/accounts?tiktok=error"
    assert tiktok_transport.calls == []  # no exchange attempted


def test_callback_rejects_tampered_state(make_tiktok_app, tiktok_transport) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        response = client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": "not-a-valid-state"},
            follow_redirects=False,
        )

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/accounts?tiktok=error"
    assert tiktok_transport.calls == []


def test_callback_rejects_state_minted_for_a_different_session(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client_a:
        client_a.post("/admin/login", auth=ADMIN_AUTH)
        token_a = _login(client_a)
        state_a = _state_from(_connect(client_a, token_a).headers["location"])

    # A different login session has a different session id; the state bound
    # to session A must not be consumable from session B.
    with TestClient(app) as client_b:
        client_b.post("/admin/login", auth=ADMIN_AUTH)
        response = client_b.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": state_a},
            follow_redirects=False,
        )

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/accounts?tiktok=error"
    assert tiktok_transport.calls == []


def test_callback_rejects_state_reuse(make_tiktok_app, tiktok_transport) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        state = _state_from(_connect(client, token).headers["location"])

        first = client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": state},
            follow_redirects=False,
        )

    assert first.headers["location"] == "/admin/accounts?tiktok=connected"
    # Reusing the same state must be rejected (one-shot), and no second
    # exchange is performed.
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        second = client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": state},
            follow_redirects=False,
        )

    assert second.headers["location"] == "/admin/accounts?tiktok=error"
    assert len(tiktok_transport.calls) == 1  # only the first attempt exchanged


def test_callback_handles_token_exchange_error(make_tiktok_app, tiktok_transport) -> None:
    tiktok_transport.response = {"error": "invalid_grant", "error_description": "bad code"}
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        state = _state_from(_connect(client, token).headers["location"])
        response = client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": state},
            follow_redirects=False,
        )

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/accounts?tiktok=error"
    # No account persisted.
    assert app.state.container.account_store.list_accounts() == []


def test_callback_without_oauth_state_secret_reports_error(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """Callback with TikTok configured but OAUTH_STATE_SECRET unset degrades
    gracefully to an error redirect instead of a 500.

    The raising call (``build_tiktok_connect_service``) now runs inside the
    try/except, so ``OAuthStateUnavailableError`` is caught and returned as
    ``?tiktok=error``.
    """

    app = create_app(_base_tiktok_settings(make_settings, tmp_path))
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        response = client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": "some-state"},
            follow_redirects=False,
        )

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/accounts?tiktok=error"


def test_callback_without_token_encryption_key_reports_error(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """Callback with TikTok configured but TOKEN_ENCRYPTION_KEY unset degrades
    gracefully to an error redirect instead of a 500.

    ``TokenCipherUnavailableError`` is raised inside the try/except and caught
    by the persistence-dependency handler.
    """

    app = create_app(_base_tiktok_settings(make_settings, tmp_path, token_encryption_key=""))
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        response = client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": "some-state"},
            follow_redirects=False,
        )

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/accounts?tiktok=error"


def test_callback_unavailable_does_not_record_connected(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """An unavailable cipher/state does not record a spurious "connected" event."""

    app = create_app(_base_tiktok_settings(make_settings, tmp_path, token_encryption_key=""))
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": "some-state"},
            follow_redirects=False,
        )
        events = app.state.container.diagnostics.recent()

    assert not any("connected" in (event.message or "") for event in events)
    assert any(event.level == "error" for event in events)


# --- callback: storage error handling -------------------------------------------
# A sqlite3.Error from list_accounts (before state consumption) or from save
# (inside complete_callback) must produce a graceful ?tiktok=error redirect
# rather than a 500, matching the dashboard/accounts routes which already guard
# list_accounts against sqlite3.Error.


def test_callback_handles_storage_error_before_state_consumption(
    make_tiktok_app, tiktok_transport
) -> None:
    """A sqlite3.Error when listing accounts (before state consumption) yields
    a graceful ``?tiktok=error`` redirect instead of a 500.

    The state is left unconsumed (retryable) and no token exchange is attempted,
    because the failure occurs before ``complete_callback`` runs.
    """

    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        state = _state_from(_connect(client, token).headers["location"])

        store = app.state.container.account_store
        with mock.patch.object(
            store, "list_accounts",
            side_effect=sqlite3.OperationalError("disk I/O error"),
        ):
            response = client.get(
                "/admin/oauth/callback/tiktok",
                params={"code": "auth-code", "state": state},
                follow_redirects=False,
            )

        assert response.status_code == 303
        assert response.headers["location"] == "/admin/accounts?tiktok=error"
        # No token exchange was attempted (state was not consumed).
        assert tiktok_transport.calls == []
        # No account persisted.
        assert store.list_accounts() == []


def test_callback_handles_storage_error_during_save(
    make_tiktok_app, tiktok_transport
) -> None:
    """A sqlite3.Error during account persistence (inside complete_callback)
    yields a graceful ``?tiktok=error`` redirect instead of a 500.

    The token exchange is attempted (state is consumed) but no account is
    persisted.
    """

    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        state = _state_from(_connect(client, token).headers["location"])

        store = app.state.container.account_store
        with mock.patch.object(
            store, "save",
            side_effect=sqlite3.OperationalError("disk I/O error"),
        ):
            response = client.get(
                "/admin/oauth/callback/tiktok",
                params={"code": "auth-code", "state": state},
                follow_redirects=False,
            )

        assert response.status_code == 303
        assert response.headers["location"] == "/admin/accounts?tiktok=error"
        # The token exchange WAS attempted (state was consumed).
        assert len(tiktok_transport.calls) == 1
        # No account persisted (save failed).
        assert store.list_accounts() == []


# --- security: no credential disclosure -----------------------------------


def test_callback_records_a_connected_diagnostic_event(
    make_tiktok_app, tiktok_transport
) -> None:
    """A successful connect+callback is recorded in the admin diagnostic log."""

    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        state = _state_from(_connect(client, token).headers["location"])
        client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": state},
        )
        events = app.state.container.diagnostics.recent()

    messages = [event.message for event in events]
    assert "TikTok OAuth flow initiated" in messages
    assert "TikTok account connected" in messages
    # Diagnostic events must never carry token material.
    blob = " ".join(event.message + str(event.detail or "") for event in events)
    assert "act.fake-access-token" not in blob
    assert "rft.fake-refresh-token" not in blob


def test_callback_failure_records_an_error_diagnostic(
    make_tiktok_app, tiktok_transport
) -> None:
    """A failed token exchange is recorded as an error diagnostic."""

    tiktok_transport.response = {"error": "invalid_grant", "error_description": "bad"}
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        state = _state_from(_connect(client, token).headers["location"])
        client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": state},
        )
        events = app.state.container.diagnostics.recent()

    assert any(event.level == "error" for event in events)
    assert any("exchange failed" in event.message for event in events)
    # The diagnostic detail must not echo platform error descriptions that
    # could carry sensitive context.
    blob = " ".join(event.message + str(event.detail or "") for event in events)
    assert TIKTOK_SECRET not in blob


def test_no_token_or_secret_material_in_callback_or_accounts_responses(
    make_tiktok_app, tiktok_transport
) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        state = _state_from(_connect(client, token).headers["location"])
        client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": state},
        )

        accounts_body = client.get("/admin/accounts").text

    blob = accounts_body
    assert "act.fake-access-token" not in blob
    assert "rft.fake-refresh-token" not in blob
    assert TIKTOK_SECRET not in blob
    assert "code=auth-code" not in blob


def test_state_value_is_not_rendered_in_responses(make_tiktok_app, tiktok_transport) -> None:
    app, _adapter, _transport = make_tiktok_app(tiktok_transport)
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        token = _login(client)
        state = _state_from(_connect(client, token).headers["location"])

        callback = client.get(
            "/admin/oauth/callback/tiktok",
            params={"code": "auth-code", "state": state},
            follow_redirects=False,
        )
        accounts = client.get("/admin/accounts").text

    # The opaque state must never be echoed back in any response body.
    assert state not in callback.text
    assert state not in accounts


# --- redirect_to_accounts helper -------------------------------------------


def test_redirect_to_accounts_uses_fixed_flags() -> None:
    for flag in ("connected", "reconnected", "error"):
        redirect = redirect_to_accounts(flag)
        assert redirect.status_code == 303
        assert redirect.headers["location"] == f"/admin/accounts?tiktok={flag}"


# --- real HttpTikTokOAuthTransport (mocked httpx boundary) -----------------


def _mock_handler(body: dict[str, object], status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=status, json=body)

    return handler


def test_transport_returns_parsed_json_body() -> None:
    transport = HttpTikTokOAuthTransport(
        transport=httpx.MockTransport(_mock_handler(SAMPLE_SUCCESS))
    )

    body = asyncio.run(
        transport.post(TOKEN_URL, {"grant_type": "authorization_code", "code": "x"})
    )

    assert body == SAMPLE_SUCCESS
    assert isinstance(body, dict)


def test_transport_wraps_transport_errors_as_oauth_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network down")

    transport = HttpTikTokOAuthTransport(transport=httpx.MockTransport(handler))

    with pytest.raises(TikTokOAuthError, match="could not be completed"):
        asyncio.run(transport.post(TOKEN_URL, {"grant_type": "authorization_code"}))


def test_transport_wraps_non_json_responses_as_oauth_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=502, text="<html>bad gateway</html>")

    transport = HttpTikTokOAuthTransport(transport=httpx.MockTransport(handler))

    with pytest.raises(TikTokOAuthError, match="status 502"):
        asyncio.run(transport.post(TOKEN_URL, {"grant_type": "authorization_code"}))


def test_transport_rejects_non_object_json() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=200, json=["not", "an", "object"])

    transport = HttpTikTokOAuthTransport(transport=httpx.MockTransport(handler))

    with pytest.raises(TikTokOAuthError, match="non-object"):
        asyncio.run(transport.post(TOKEN_URL, {"grant_type": "authorization_code"}))


def test_transport_error_message_does_not_leak_credentials() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("secret-network-detail")

    transport = HttpTikTokOAuthTransport(transport=httpx.MockTransport(handler))
    with pytest.raises(TikTokOAuthError, match="could not be completed") as exc_info:
        asyncio.run(transport.post(TOKEN_URL, {"client_secret": TIKTOK_SECRET}))

    # The network error detail (which could carry sensitive context) is hidden.
    assert "secret-network-detail" not in str(exc_info.value)
    assert "client_secret" not in str(exc_info.value)


def test_transport_implements_the_protocol() -> None:
    transport = HttpTikTokOAuthTransport()
    assert isinstance(transport, TikTokOAuthTransport)
