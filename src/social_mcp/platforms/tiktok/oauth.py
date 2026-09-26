"""TikTok Login Kit OAuth adapter interface and construction logic.

This module defines the contract the Web Admin and MCP layers share for TikTok
account connection (issue #78). It covers:

* the **authorization-URL construction** (a pure operation: no HTTP);
* the **server-side token exchange** and **refresh-token** request/response
  shapes;
* a concrete adapter that performs URL construction directly and delegates the
  HTTP steps to an injectable :class:`TikTokOAuthTransport` boundary;
* the **TikTok account state representation** that maps a token response onto the
  shared :class:`~social_mcp.storage.models.ConnectedAccount`.

Security notes
--------------

Per the issue, this module performs **no OAuth execution and no credential
handling**: it never stores, logs, or reads configuration secrets. Token
exchange and refresh accept ``client_key``/``client_secret`` only as call
parameters (required by TikTok's token endpoint) and forward them through the
transport boundary; persistence/encryption of tokens belongs to the
``auth``/``storage`` layers. The account-state mapping produced here carries the
*encrypted* token bytes supplied by the caller, never plaintext tokens.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import ClassVar, Protocol, runtime_checkable
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator

from social_mcp.platforms.tiktok import constants as tiktok_constants
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

#: Lifetime, in seconds, the access token TikTok reports on issuance. TikTok
#: states access tokens are valid for 24 hours after initial issuance; refresh
#: tokens are valid for 365 days. These defaults back
#: :attr:`TikTokTokenSuccessResponse.access_expires_at` when an explicit
#: ``expires_in`` is absent.
DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60
DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60


class TikTokOAuthError(ValueError):
    """A TikTok OAuth failure with a safe, non-secret message."""


# ---------------------------------------------------------------------------
# Token endpoint request/response models
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TikTokCodeExchangeRequest:
    """The form body for exchanging an authorization code for tokens.

    All fields map 1:1 to the TikTok ``/v2/oauth/token/`` request body
    parameters. ``client_secret`` is carried to the transport boundary but is
    never logged or persisted by this adapter.
    """

    client_key: str
    client_secret: str
    code: str
    redirect_uri: str
    grant_type: str = "authorization_code"

    def as_form(self) -> dict[str, str]:
        """Return the request payload as a form-encodable mapping.

        The ``code`` is URL-decoded by TikTok before exchange; callers pass the
        raw code value as received in the callback.
        """

        return {
            "client_key": self.client_key,
            "client_secret": self.client_secret,
            "code": self.code,
            "grant_type": self.grant_type,
            "redirect_uri": self.redirect_uri,
        }


@dataclass(frozen=True)
class TikTokRefreshRequest:
    """The form body for refreshing an access token."""

    client_key: str
    client_secret: str
    refresh_token: str
    grant_type: str = "refresh_token"

    def as_form(self) -> dict[str, str]:
        """Return the refresh request payload as a form-encodable mapping."""

        return {
            "client_key": self.client_key,
            "client_secret": self.client_secret,
            "refresh_token": self.refresh_token,
            "grant_type": self.grant_type,
        }


class TikTokTokenSuccessResponse(BaseModel):
    """A successful TikTok token-endpoint response.

    Field names mirror the documented TikTok response keys so the mapping is
    explicit and stable. ``scope`` is a comma-separated string as returned by
    TikTok; use :attr:`scopes` to access it as a list.
    """

    model_config = ConfigDict(extra="allow")

    open_id: str = Field(..., description="The TikTok user's unique identifier.")
    access_token: str = Field(..., description="Bearer access token for API calls.")
    refresh_token: str = Field(
        default="",
        # Required on authorization-code exchange; some refresh responses may
        # omit a rotated refresh token, in which case the caller retains the
        # existing one. An empty default keeps this model tolerant of both.
        description="Token used to renew the access token.",
    )
    scope: str = Field(
        ...,
        description="A comma-separated list of scopes the user authorized.",
    )
    token_type: str = Field(
        default="bearer",
        description="Token type; TikTok returns 'Bearer'.",
    )
    expires_in: int = Field(
        default=DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
        description="Access-token lifetime in seconds.",
    )
    refresh_expires_in: int = Field(
        default=DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
        description="Refresh-token lifetime in seconds.",
    )

    # Absolute expiry timestamps, frozen at construction so every call to the
    # property returns the same value (deterministic for the account state
    # mapping and for tests). Computed from ``expires_in``/``refresh_expires_in``
    # plus the time the response was constructed.
    _access_expires_at: datetime = PrivateAttr()
    _refresh_expires_at: datetime = PrivateAttr()

    @model_validator(mode="after")
    def _compute_expiry(self) -> TikTokTokenSuccessResponse:
        issued_at = _now_utc()
        self._access_expires_at = issued_at + timedelta(seconds=self.expires_in)
        self._refresh_expires_at = issued_at + timedelta(seconds=self.refresh_expires_in)
        return self

    @property
    def scopes(self) -> list[str]:
        """The granted scopes as a list, split on TikTok's comma separator."""

        if not self.scope:
            return []
        separator = tiktok_constants.SCOPE_SEPARATOR
        return [
            part.strip()
            for part in self.scope.split(separator)
            if part.strip()
        ]

    @property
    def access_expires_at(self) -> datetime:
        """When the access token expires (frozen at response construction)."""

        return self._access_expires_at

    @property
    def refresh_expires_at(self) -> datetime:
        """When the refresh token expires (frozen at response construction)."""

        return self._refresh_expires_at


class TikTokTokenErrorResponse(BaseModel):
    """A TikTok token-endpoint failure response."""

    error: str
    error_description: str = ""
    log_id: str | None = None


# ---------------------------------------------------------------------------
# HTTP transport boundary (mocked in tests; never executed by this module)
# ---------------------------------------------------------------------------


@runtime_checkable
class TikTokOAuthTransport(Protocol):
    """The HTTP boundary the adapter delegates OAuth execution to.

    Implementations call TikTok's token endpoint. Tests substitute a fake; the
    adapter itself never makes network calls. Only the form body and target URL
    determined by this contract are passed in: the transport owns credentials in
    transit and is responsible for TLS/HTTP errors.
    """

    async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
        """POST a form body to ``url`` and return the parsed JSON body."""
        ...


# ---------------------------------------------------------------------------
# Adapter interface
# ---------------------------------------------------------------------------


class TikTokOAuthAdapter(Protocol):
    """The TikTok OAuth adapter interface.

    The Web Admin callback layer and (later) the MCP layer call these three
    operations. URL construction is a pure function implemented here; token
    exchange and refresh delegate HTTP to a :class:`TikTokOAuthTransport` so
    this module stays free of network code and live TikTok calls.
    """

    def authorization_url(
        self,
        client_key: str,
        redirect_uri: str,
        state: str,
        scopes: list[str],
        *,
        disable_auto_auth: bool = False,
    ) -> str:
        """Build the Login Kit authorization URL.

        Args:
            client_key: The app's TikTok client key (never logged).
            redirect_uri: A registered, https redirect URI for the app.
            state: An unpredictable, session-bound CSRF state value.
            scopes: TikTok Login Kit scopes to request (comma-separated on
                the wire).
            disable_auto_auth: When True, passes ``disable_auto_auth=1`` so
                TikTok does not silently auto-authorize returning users.

        Returns:
            The full authorization URL the browser should be redirected to.
        """
        ...

    async def exchange_code_for_token(
        self,
        client_key: str,
        client_secret: str,
        code: str,
        redirect_uri: str,
    ) -> TikTokTokenSuccessResponse:
        """Exchange an authorization code for access/refresh tokens.

        Delegates the HTTP call to the transport boundary; parses the response
        into :class:`TikTokTokenSuccessResponse` or raises
        :class:`TikTokOAuthError`.
        """
        ...

    async def refresh_access_token(
        self,
        client_key: str,
        client_secret: str,
        refresh_token: str,
    ) -> TikTokTokenSuccessResponse:
        """Refresh an expired access token using a refresh token.

        Delegates the HTTP call to the transport boundary; parses the response
        into :class:`TikTokTokenSuccessResponse` or raises
        :class:`TikTokOAuthError`.
        """
        ...


# ---------------------------------------------------------------------------
# Account state representation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TikTokAccountState:
    """The TikTok-specific account state derived from a token response.

    This documents how a TikTok token maps onto the shared
    :class:`~social_mcp.storage.models.ConnectedAccount`. It carries only
    metadata (scopes, expiries, platform identifier) and the *encrypted* token
    bytes supplied by the caller: it never holds plaintext credentials, which
    remain the responsibility of the ``auth``/``storage`` layers.
    """

    #: The TikTok platform identifier this state always represents (matches
    #: :attr:`~social_mcp.storage.models.SocialPlatform.TIKTOK`). It is a class
    #: constant rather than per-instance state: every ``TikTokAccountState``
    #: instance represents the ``tiktok`` platform.
    platform: ClassVar[str] = tiktok_constants.PLATFORM_TIKTOK
    #: The TikTok ``open_id``: the connected user's stable TikTok identifier.
    external_account_id: str
    #: The scopes the user actually granted (parsed from the response).
    scopes: list[str]
    #: When the access token expires.
    access_token_expires_at: datetime
    #: When the refresh token expires, if one was issued.
    refresh_token_expires_at: datetime | None = None
    #: Encrypted access-token bytes (encrypted by the caller; never plaintext).
    access_token_encrypted: bytes = b""
    #: Encrypted refresh-token bytes (encrypted by the caller; may be empty).
    refresh_token_encrypted: bytes = b""

    def to_connected_account(self, *, username: str | None = None) -> ConnectedAccount:
        """Render this state as the shared connected-account model.

        Callers (e.g. the Web Admin callback layer) supply the encrypted token
        bytes via this state and are responsible for encrypting actual token
        strings with :class:`~social_mcp.auth.token_cipher.TokenCipher` before
        constructing it. This method only re-shapes data; it performs no
        encryption, decryption, persistence, or credential access.
        """

        now = _now_utc()
        return ConnectedAccount(
            platform=SocialPlatform.TIKTOK,
            external_account_id=self.external_account_id,
            username=username,
            scopes=list(self.scopes),
            access_token_encrypted=self.access_token_encrypted,
            refresh_token_encrypted=(
                self.refresh_token_encrypted if self.refresh_token_encrypted else None
            ),
            token_expires_at=self.access_token_expires_at,
            created_at=now,
            updated_at=now,
        )


def token_response_to_account_state(
    response: TikTokTokenSuccessResponse,
    *,
    access_token_encrypted: bytes,
    refresh_token_encrypted: bytes = b"",
) -> TikTokAccountState:
    """Map a token response onto :class:`TikTokAccountState`.

    The caller supplies the already-encrypted token bytes; this function does
    not encrypt, decrypt, or touch plaintext credentials.
    """

    return TikTokAccountState(
        external_account_id=response.open_id,
        scopes=response.scopes,
        access_token_expires_at=response.access_expires_at,
        refresh_token_expires_at=response.refresh_expires_at,
        access_token_encrypted=access_token_encrypted,
        refresh_token_encrypted=refresh_token_encrypted,
    )


# ---------------------------------------------------------------------------
# Concrete adapter
# ---------------------------------------------------------------------------


class TikTokLoginKitAdapter:
    """Concrete TikTok Login Kit OAuth adapter.

    Implements :class:`TikTokOAuthAdapter`. URL construction is performed here
    directly; token exchange and refresh are delegated to an injected
    :class:`TikTokOAuthTransport`, keeping this module free of network code.
    """

    def __init__(self, *, transport: TikTokOAuthTransport) -> None:
        if transport is None:
            raise ValueError("A TikTokOAuthTransport is required for the TikTok adapter.")
        self._transport = transport

    def authorization_url(
        self,
        client_key: str,
        redirect_uri: str,
        state: str,
        scopes: list[str],
        *,
        disable_auto_auth: bool = False,
    ) -> str:
        if not client_key:
            raise ValueError("client_key is required to build a TikTok authorization URL.")
        if not redirect_uri:
            raise ValueError("redirect_uri is required to build a TikTok authorization URL.")
        if not state:
            raise ValueError("state is required to build a TikTok authorization URL.")

        params: list[tuple[str, str]] = [
            ("client_key", client_key),
            ("scope", tiktok_constants.SCOPE_SEPARATOR.join(scopes)),
            ("redirect_uri", redirect_uri),
            ("state", state),
            ("response_type", tiktok_constants.RESPONSE_TYPE_CODE),
        ]
        if disable_auto_auth:
            params.append(("disable_auto_auth", "1"))

        query = "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in params)
        return f"{tiktok_constants.AUTHORIZATION_URL}?{query}"

    async def exchange_code_for_token(
        self,
        client_key: str,
        client_secret: str,
        code: str,
        redirect_uri: str,
    ) -> TikTokTokenSuccessResponse:
        request = TikTokCodeExchangeRequest(
            client_key=client_key,
            client_secret=client_secret,
            code=code,
            redirect_uri=redirect_uri,
        )
        body = await self._post_and_parse(tiktok_constants.TOKEN_URL, request.as_form())
        return self._parse_token_response(body)

    async def refresh_access_token(
        self,
        client_key: str,
        client_secret: str,
        refresh_token: str,
    ) -> TikTokTokenSuccessResponse:
        request = TikTokRefreshRequest(
            client_key=client_key,
            client_secret=client_secret,
            refresh_token=refresh_token,
        )
        body = await self._post_and_parse(tiktok_constants.TOKEN_URL, request.as_form())
        return self._parse_token_response(body)

    async def _post_and_parse(self, url: str, data: dict[str, str]) -> dict[str, object]:
        body = await self._transport.post(url, data)
        if not isinstance(body, dict):
            raise TikTokOAuthError("TikTok token endpoint returned a non-object response.")
        return body

    @staticmethod
    def _parse_token_response(body: dict[str, object]) -> TikTokTokenSuccessResponse:
        # A TikTok error response carries an ``error`` key; the success path
        # carries ``access_token``. ``open_id`` is always present on success.
        if "error" in body and body.get("error"):
            error = TikTokTokenErrorResponse.model_validate(body)
            raise TikTokOAuthError(
                f"TikTok token request failed: {error.error}"
                + (f" - {error.error_description}" if error.error_description else "")
            )
        if "access_token" not in body:
            raise TikTokOAuthError("TikTok token response was missing an access token.")
        return TikTokTokenSuccessResponse.model_validate(body)


def _now_utc() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""

    return datetime.now(UTC)
