"""TikTok OAuth connection and reconnect through the Web Admin (issue #79).

This module wires the shared admin/auth/storage architecture to the TikTok
Login Kit adapter contract defined in :mod:`social_mcp.platforms.tiktok`. It
owns the Web-Admin OAuth *execution* that issue #78 explicitly left out:

* a concrete :class:`TikTokOAuthTransport` backed by ``httpx`` (the HTTP
  boundary the adapter delegates token exchange/refresh to);
* a :class:`TikTokConnectService` that orchestrates the authorization-code
  flow end to end -- authorization-URL construction, session-bound state
  validation, server-side token exchange, encrypted token persistence with
  granted scopes and expiry metadata, and reconnect semantics;
* the FastAPI dependency that supplies the adapter to routes, overridable in
  tests so no live TikTok calls are ever made.

Security rules followed here (see ``docs/PROJECT_CONTEXT.md`` and
``agents/implementer/AGENTS.md``):

* OAuth state is minted and consumed through :class:`OAuthStateManager`,
  bound to the initiating admin session, one-shot and expiry-checked.
* Tokens are encrypted with :class:`TokenCipher` before persistence; this
  module never logs, returns, or otherwise discloses plaintext tokens, client
  secrets or the encryption key.
* The transport raises only :class:`TikTokOAuthError` with safe, non-secret
  messages for any failure.
* Capabilities are exposed only through :func:`resolve_tiktok_capabilities`,
  derived from the scopes actually granted on the connected account.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import RedirectResponse

from social_mcp.auth.oauth_state import OAuthStateManager
from social_mcp.auth.token_cipher import TokenCipher
from social_mcp.container import ApplicationContainer
from social_mcp.platforms.tiktok import (
    PLATFORM_TIKTOK,
    READ_SCOPES,
    TikTokLoginKitAdapter,
    TikTokOAuthError,
    token_response_to_account_state,
)
from social_mcp.storage.models import ConnectedAccount

logger = logging.getLogger(__name__)

#: Session key under which the per-admin-session identifier is stored. The
#: identifier is opaque and unguessable; it is never a credential, but it is
#: used to bind OAuth ``state`` values to the session that started the flow so
#: a state minted in one session cannot be redeemed from another. It is
#: established at login (see :mod:`social_mcp.admin.routes`).
SESSION_ID_KEY = "admin_session_id"

#: Query parameter used to pass a non-secret status back to the accounts page
#: after the (browser-redirected) OAuth round trip. Only fixed, server-chosen
#: values are ever written here; no user input or token material is reflected.
_STATUS_PARAM = "tiktok"


def _session_id(request: Request) -> str:
    """Return the current admin session's identifier.

    Raises:
        HTTPException: 303 to the login page when no session id is present
            (e.g. the session expired mid-flow), so the browser can re-login
            and restart the connection.
    """

    session_id = request.session.get(SESSION_ID_KEY)
    if not isinstance(session_id, str) or not session_id:
        raise HTTPException(status_code=303, headers={"location": "/admin/login"})
    return session_id


def _callback_url(request: Request) -> str:
    """Build the OAuth redirect URI TikTok should return to.

    The URI is derived from the incoming request so the same code serves
    localhost development and a reverse-proxied deployment. The scheme/host
    follow FastAPI's :class:`~starlette.requests.Request` (which honours
    ``ProxyHeadersMiddleware`` when configured), and the path is fixed.

    The value is opaque to an attacker (it is forwarded to TikTok and echoed
    back on the callback) and carries no credentials.
    """

    scheme = request.url.scheme
    host = request.headers.get("host") or request.url.netloc
    return f"{scheme}://{host}/admin/oauth/callback/tiktok"


def _tiktok_client_configured(container: ApplicationContainer) -> bool:
    """Whether the TikTok Login Kit client key and secret are both configured."""

    settings = container.settings
    return bool(settings.tiktok_client_key) and bool(settings.tiktok_client_secret)


# ---------------------------------------------------------------------------
# HTTP transport boundary
# ---------------------------------------------------------------------------


class HttpTikTokOAuthTransport:
    """A concrete :class:`TikTokOAuthTransport` using ``httpx``.

    This is the only part of the Web Admin that speaks directly to TikTok, and
    only for the token exchange/refresh HTTP calls that the adapter delegates.
    A fresh ``httpx.AsyncClient`` is used per request and closed immediately so
    no connection pool is shared or leaked across OAuth round trips.

    The transport returns the parsed JSON body to the adapter for TikTok-aware
    success/error parsing; it raises :class:`TikTokOAuthError` (never a raw
    ``httpx`` exception) on network/HTTP/JSON failures, with a safe, non-secret
    message.
    """

    #: Per-request timeout for token endpoint calls. The token exchange is a
    #: short control-plane call; a 30s budget is generous and bounded.
    timeout_seconds: float = 30.0

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        # ``transport`` exists so tests can inject an httpx MockTransport and
        # exercise the JSON/error mapping of this boundary without a live
        # TikTok call. ``None`` selects httpx's default network transport.
        self._transport = transport

    async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
        """POST a form body to TikTok's token endpoint and return the JSON body.

        Returns the parsed JSON body to the adapter for TikTok-aware parsing;
        raises :class:`TikTokOAuthError` (never a raw ``httpx`` exception) on
        network/JSON/non-object failures, with a safe, non-secret message.
        """

        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self.timeout_seconds
            ) as client:
                response = await client.post(url, data=data)
        except httpx.TransportError as exc:
            # Don't surface the URL, the request body (which carries the
            # client secret) or the underlying network error detail.
            raise TikTokOAuthError("TikTok token request could not be completed") from exc

        try:
            body = response.json()
        except ValueError as exc:
            status = response.status_code
            raise TikTokOAuthError(
                f"TikTok token endpoint returned status {status}"
            ) from exc

        if not isinstance(body, dict):
            raise TikTokOAuthError(
                "TikTok token endpoint returned a non-object response"
            )
        return body


def get_tiktok_adapter() -> TikTokLoginKitAdapter:
    """Return the TikTok OAuth adapter backed by the real HTTP transport.

    This is a FastAPI dependency so routes never construct infrastructure. The
    default uses :class:`HttpTikTokOAuthTransport`; tests override this
    dependency with a fake adapter/transport so no live TikTok calls occur.
    """

    return TikTokLoginKitAdapter(transport=HttpTikTokOAuthTransport())


# ---------------------------------------------------------------------------
# Connection/reconnect orchestration
# ---------------------------------------------------------------------------


class TikTokConnectService:
    """Orchestrates TikTok OAuth connect/reconnect for the Web Admin.

    The service is a thin coordinator over the adapter (URL construction and
    token exchange), the OAuth state manager (session-bound, one-shot state),
    the token cipher (encryption at rest) and the account store (persistence).
    It performs no network I/O or encryption itself: the adapter and cipher do
    that. Its only job is to order those steps correctly and produce a
    :class:`~social_mcp.storage.models.ConnectedAccount`.

    A service is built per request from the application container so each
    request gets the latest cipher/state manager and a fresh adapter; this keeps
    failure handling simple (a missing cipher or state secret fails closed on
    the request that needs it) and is cheap because OAuth exchanges are rare.
    """

    def __init__(
        self,
        *,
        adapter: TikTokLoginKitAdapter,
        state_manager: OAuthStateManager,
        cipher: TokenCipher,
        account_store,
        tiktok_client_key: str,
        tiktok_client_secret: str,
    ) -> None:
        self._adapter = adapter
        self._state_manager = state_manager
        self._cipher = cipher
        self._account_store = account_store
        self._client_key = tiktok_client_key
        self._client_secret = tiktok_client_secret

    def build_authorization_url(self, request: Request) -> str:
        """Mint session-bound state and build the Login Kit authorization URL.

        Args:
            request: The admin request initiating the flow (used to derive the
                session id and the callback redirect URI).

        Returns:
            The TikTok authorization URL the browser should be redirected to.

        Raises:
            TikTokOAuthError: if the TikTok client key is not configured.
        """

        if not self._client_key:
            raise TikTokOAuthError("TikTok client key is not configured")
        # ``disable_auto_auth=True`` so TikTok does not silently
        # auto-authorize a returning user and skip re-consenting scopes.
        state = self._state_manager.create(_session_id(request), platform=PLATFORM_TIKTOK)
        redirect_uri = _callback_url(request)
        return self._adapter.authorization_url(
            client_key=self._client_key,
            redirect_uri=redirect_uri,
            state=state,
            scopes=list(READ_SCOPES),
            disable_auto_auth=True,
        )

    async def complete_callback(
        self,
        request: Request,
        code: str,
        state: str,
    ) -> ConnectedAccount:
        """Validate state, exchange the code, and persist the connected account.

        Args:
            request: The admin callback request (used to derive the session id
                and the callback redirect URI, the latter must match the one
                sent in the authorization request).
            code: The authorization code TikTok returned.
            state: The state value TikTok returned; must match a state minted
                for this session.

        Returns:
            The saved :class:`~social_mcp.storage.models.ConnectedAccount`
            (created on first connect, updated on reconnect -- the store
            upserts by ``(platform, external_account_id)``).

        Raises:
            OAuthStateError: if the state is missing, malformed, expired,
                session-bound mismatch, or already used.
            TikTokOAuthError: if the token exchange fails.
        """

        session_id = _session_id(request)
        data = self._state_manager.consume(state, session_id=session_id)
        if data.platform != PLATFORM_TIKTOK:
            raise TikTokOAuthError("OAuth state was not issued for the TikTok platform")

        redirect_uri = _callback_url(request)
        token = await self._adapter.exchange_code_for_token(
            client_key=self._client_key,
            client_secret=self._client_secret,
            code=code,
            redirect_uri=redirect_uri,
        )

        # Encrypt at rest before constructing the stored model. The cipher
        # raises ValueError on misuse; callers handle encryption failures as
        # an internal error (never persisting plaintext or leaking details).
        access_encrypted = self._cipher.encrypt(token.access_token)
        refresh_encrypted = (
            self._cipher.encrypt(token.refresh_token) if token.refresh_token else b""
        )

        account = token_response_to_account_state(
            token,
            access_token_encrypted=access_encrypted,
            refresh_token_encrypted=refresh_encrypted,
        ).to_connected_account()

        return self._account_store.save(account)


def build_tiktok_connect_service(
    container: ApplicationContainer,
    adapter: TikTokLoginKitAdapter,
) -> TikTokConnectService:
    """Build a :class:`TikTokConnectService` from the container's dependencies.

    The container is the single source of the cipher, state manager and store;
    the adapter is injected separately so tests can substitute a fake while
    keeping the real container (and its real, throwaway cipher/store) wired.

    Raises:
        TokenCipherUnavailableError: if no encryption key is configured.
        OAuthStateUnavailableError: if no OAuth state signing secret is set.
    """

    return TikTokConnectService(
        adapter=adapter,
        state_manager=container.require_oauth_state_manager(),
        cipher=container.require_token_cipher(),
        account_store=container.account_store,
        tiktok_client_key=container.settings.tiktok_client_key or "",
        tiktok_client_secret=container.settings.tiktok_client_secret or "",
    )


def redirect_to_accounts(status: str) -> RedirectResponse:
    """Redirect back to the accounts page with a fixed, safe status flag."""

    return RedirectResponse(
        url=f"/admin/accounts?{_STATUS_PARAM}={status}",
        status_code=303,
    )
