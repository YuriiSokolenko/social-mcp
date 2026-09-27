"""Threads/Meta OAuth adapter: authorization URL and server-side code exchange.

This module defines the contract the Web Admin shares for Threads account
connection (issue #16). It covers:

* the **authorization-URL construction** (a pure operation: no HTTP);
* the **server-side token-exchange** request/response shapes;
* a concrete adapter that performs URL construction directly and delegates the
  HTTP exchange to an injectable :class:`ThreadsOAuthTransport` boundary;
* the **Threads account-state representation** that maps a token response onto
  the shared :class:`~social_mcp.storage.models.ConnectedAccount`.

Security notes
--------------

Per the issue, this module performs **no OAuth execution or credential
handling**: it never stores, logs, or reads configuration secrets. Token
exchange accepts ``client_id``/``client_secret`` only as call parameters
(required by the Meta token endpoint) and forwards them through the transport
boundary; persistence/encryption of tokens belongs to the ``auth``/``storage``
layers. The account-state mapping produced here carries the *encrypted* token
bytes supplied by the caller, never plaintext tokens.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import ClassVar, Protocol, runtime_checkable
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator

from social_mcp.platforms.threads import constants as threads_constants
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

#: Lifetime, in seconds, assumed for a short-lived Threads access token
#: issued by the authorization-code exchange. The short-lived token response
#: from Meta does not include an ``expires_in`` field; Meta documents
#: short-lived tokens as valid for 1 hour. This default backs account-state
#: expiry only when the response omits it.
DEFAULT_SHORT_LIVED_TOKEN_TTL_SECONDS = 60 * 60


def _now_utc() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""

    return datetime.now(UTC)


class ThreadsOAuthError(ValueError):
    """A Threads OAuth failure with a safe, non-secret message."""


# ---------------------------------------------------------------------------
# Token endpoint request/response models
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ThreadsCodeExchangeRequest:
    """The form body for exchanging an authorization code for tokens.

    All fields map 1:1 to the Meta Threads token-endpoint request body
    parameters. ``client_secret`` is carried to the transport boundary but is
    never logged or persisted by this adapter.
    """

    client_id: str
    client_secret: str
    code: str
    redirect_uri: str
    grant_type: str = "authorization_code"

    def as_form(self) -> dict[str, str]:
        """Return the request payload as a form-encodable mapping."""

        return {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code": self.code,
            "grant_type": self.grant_type,
            "redirect_uri": self.redirect_uri,
        }


class ThreadsTokenSuccessResponse(BaseModel):
    """A successful Threads token-endpoint response.

    Field names mirror the documented Meta Threads response keys so the mapping
    is explicit and stable. ``user_id`` is coerced to a string because Meta
    returns it as a JSON number, while :class:`ConnectedAccount` stores the
    external account id as a string.

    The short-lived token response returns only ``access_token``,
    ``token_type`` and ``user_id``; ``expires_in`` and ``scope`` are absent but
    tolerated when present (e.g. future long-lived responses).
    """

    model_config = ConfigDict(extra="allow")

    access_token: str = Field(
        ..., description="The user's short-lived Threads access token."
    )
    token_type: str = Field(
        default="bearer", description="Token type; Meta returns 'bearer'."
    )
    user_id: str = Field(
        ..., description="The connected Threads user's stable identifier."
    )
    expires_in: int | None = Field(
        default=None,
        description="Access-token lifetime in seconds, when returned by Meta.",
    )
    scope: str | None = Field(
        default=None,
        description="A comma-separated list of granted scopes, when returned.",
    )

    # Absolute expiry frozen at construction so every read returns the same
    # value (deterministic for the account-state mapping and for tests).
    # Computed from ``expires_in`` or the documented short-lived TTL.
    _access_expires_at: datetime = PrivateAttr()

    @model_validator(mode="before")
    @classmethod
    def _coerce_user_id_to_str(cls, data: object) -> object:
        """Coerce ``user_id`` from ``int`` to ``str`` (Meta sends a number)."""

        if isinstance(data, dict) and "user_id" in data:
            data = dict(data)
            data["user_id"] = str(data["user_id"])
        return data

    @model_validator(mode="after")
    def _freeze_expiry(self) -> ThreadsTokenSuccessResponse:
        """Compute and freeze the access-token expiry at construction time."""

        ttl = (
            self.expires_in
            if self.expires_in is not None
            else DEFAULT_SHORT_LIVED_TOKEN_TTL_SECONDS
        )
        self._access_expires_at = _now_utc() + timedelta(seconds=ttl)
        return self

    @property
    def scopes(self) -> list[str]:
        """The granted scopes as a list, split on Threads' comma separator.

        Returns an empty list when the response does not carry a ``scope``
        field (as is the case for the short-lived token exchange).
        """

        if not self.scope:
            return []
        separator = threads_constants.SCOPE_SEPARATOR
        return [
            part.strip()
            for part in self.scope.split(separator)
            if part.strip()
        ]

    @property
    def access_expires_at(self) -> datetime:
        """When the access token expires (frozen at response construction)."""

        return self._access_expires_at


class ThreadsTokenErrorResponse(BaseModel):
    """A Threads token-endpoint failure response.

    Meta's token endpoint returns a flat error payload
    (``error_type`` / ``error_message``); a standard OAuth error
    (``error`` / ``error_description``) is also tolerated so the adapter
    degrades gracefully if the shape changes. Extra fields are preserved but
    never rendered to the user.
    """

    model_config = ConfigDict(extra="allow")

    error: str = ""
    error_description: str = ""
    error_type: str | None = None
    error_message: str | None = None

    @property
    def message(self) -> str:
        """A safe, non-secret summary of the error for display."""

        return (
            self.error_description
            or self.error_message
            or self.error
            or self.error_type
            or "unknown Threads OAuth error"
        )


# ---------------------------------------------------------------------------
# HTTP transport boundary (mocked in tests; never executed by this module)
# ---------------------------------------------------------------------------


@runtime_checkable
class ThreadsOAuthTransport(Protocol):
    """The HTTP boundary the adapter delegates OAuth execution to.

    Implementations POST to the Meta token endpoint. Tests substitute a fake;
    the adapter itself never makes network calls. Only the form body and target
    URL determined by this contract are passed in: the transport owns
    credentials in transit and is responsible for TLS/HTTP errors.
    """

    async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
        """POST a form body to ``url`` and return the parsed JSON body."""
        ...


# ---------------------------------------------------------------------------
# Adapter interface
# ---------------------------------------------------------------------------


class ThreadsOAuthAdapter(Protocol):
    """The Threads OAuth adapter interface.

    The Web Admin callback layer calls these operations. URL construction is a
    pure function implemented here directly; token exchange delegates HTTP to a
    :class:`ThreadsOAuthTransport` so this module stays free of network code.
    """

    def authorization_url(
        self,
        client_id: str,
        redirect_uri: str,
        scopes: list[str],
        state: str,
    ) -> str:
        """Build the Threads/Meta authorization URL.

        Args:
            client_id: The Meta Threads App ID (never logged).
            redirect_uri: A registered valid OAuth redirect URI.
            scopes: Threads scopes to request (joined with ``scope`` separator).
            state: An unpredictable, session-bound CSRF state value.

        Returns:
            The full authorization URL the browser should be redirected to.
        """
        ...

    async def exchange_code_for_token(
        self,
        client_id: str,
        client_secret: str,
        code: str,
        redirect_uri: str,
    ) -> ThreadsTokenSuccessResponse:
        """Exchange an authorization code for access tokens.

        Delegates the HTTP call to the transport boundary; parses the response
        into :class:`ThreadsTokenSuccessResponse` or raises
        :class:`ThreadsOAuthError`.
        """
        ...


# ---------------------------------------------------------------------------
# Account state representation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ThreadsAccountState:
    """The Threads-specific account state derived from a token response.

    This documents how a Threads token maps onto the shared
    :class:`~social_mcp.storage.models.ConnectedAccount`. It carries only
    metadata (scopes, expiry, platform identifier) and the *encrypted* token
    bytes supplied by the caller: it never holds plaintext credentials, which
    remain the responsibility of the ``auth``/``storage`` layers.
    """

    #: The Threads platform identifier this state always represents (matches
    #: :attr:`~social_mcp.storage.models.SocialPlatform.THREADS`).
    platform: ClassVar[str] = threads_constants.PLATFORM_THREADS
    #: The Threads ``user_id``: the connected user's stable identifier.
    external_account_id: str
    #: The scopes the user granted (or the scopes requested, since Meta grants
    #: the app's requested scopes per authorization).
    scopes: list[str]
    #: Encrypted access-token bytes (encrypted by the caller; never plaintext).
    access_token_encrypted: bytes
    #: Encrypted refresh-token bytes (encrypted by the caller; may be empty —
    #: the short-lived token exchange does not issue a refresh token).
    refresh_token_encrypted: bytes = b""
    #: When the access token expires.
    token_expires_at: datetime | None = None

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
            platform=SocialPlatform.THREADS,
            external_account_id=self.external_account_id,
            username=username,
            scopes=list(self.scopes),
            access_token_encrypted=self.access_token_encrypted,
            refresh_token_encrypted=(
                self.refresh_token_encrypted if self.refresh_token_encrypted else None
            ),
            token_expires_at=self.token_expires_at,
            created_at=now,
            updated_at=now,
        )


def token_response_to_account_state(
    response: ThreadsTokenSuccessResponse,
    *,
    access_token_encrypted: bytes,
    scopes: list[str] = (),
) -> ThreadsAccountState:
    """Map a token response onto :class:`ThreadsAccountState`.

    The caller supplies the already-encrypted token bytes; this function does
    not encrypt, decrypt, or touch plaintext credentials. ``scopes`` defaults
    to the response's granted scopes when the short-lived response carries
    them; otherwise the caller supplies the requested scopes (which Meta grants
    for the app).
    """

    granted = response.scopes or list(scopes)
    return ThreadsAccountState(
        external_account_id=response.user_id,
        scopes=granted,
        access_token_encrypted=access_token_encrypted,
        token_expires_at=response.access_expires_at,
    )


# ---------------------------------------------------------------------------
# Concrete adapter
# ---------------------------------------------------------------------------


class ThreadsLoginAdapter:
    """Concrete Threads/Meta OAuth adapter.

    Implements :class:`ThreadsOAuthAdapter`. URL construction is performed
    here directly; token exchange is delegated to an injected
    :class:`ThreadsOAuthTransport`, keeping this module free of network code.
    """

    def __init__(self, *, transport: ThreadsOAuthTransport) -> None:
        if transport is None:
            raise ValueError("A ThreadsOAuthTransport is required for the Threads adapter.")
        self._transport = transport

    def authorization_url(
        self,
        client_id: str,
        redirect_uri: str,
        scopes: list[str],
        state: str,
    ) -> str:
        if not client_id:
            raise ValueError("client_id is required to build a Threads authorization URL.")
        if not redirect_uri:
            raise ValueError("redirect_uri is required to build a Threads authorization URL.")
        if not state:
            raise ValueError("state is required to build a Threads authorization URL.")

        requested = threads_constants.parse_scopes(
            threads_constants.SCOPE_SEPARATOR.join(scopes)
        )
        params: list[tuple[str, str]] = [
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("scope", threads_constants.SCOPE_SEPARATOR.join(requested)),
            ("response_type", threads_constants.RESPONSE_TYPE_CODE),
            ("state", state),
        ]

        query = "&".join(
            f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in params
        )
        return f"{threads_constants.AUTHORIZATION_URL}?{query}"

    async def exchange_code_for_token(
        self,
        client_id: str,
        client_secret: str,
        code: str,
        redirect_uri: str,
    ) -> ThreadsTokenSuccessResponse:
        request = ThreadsCodeExchangeRequest(
            client_id=client_id,
            client_secret=client_secret,
            code=code,
            redirect_uri=redirect_uri,
        )
        body = await self._post_and_parse(threads_constants.TOKEN_URL, request.as_form())
        return self._parse_token_response(body)

    async def _post_and_parse(self, url: str, data: dict[str, str]) -> dict[str, object]:
        body = await self._transport.post(url, data)
        if not isinstance(body, dict):
            raise ThreadsOAuthError("Threads token endpoint returned a non-object response.")
        return body

    @staticmethod
    def _parse_token_response(body: dict[str, object]) -> ThreadsTokenSuccessResponse:
        # Meta's flat error format (error_type/error_message) and the standard
        # OAuth error format (error/error_description) are both detected.
        has_error = bool(body.get("error_type")) or bool(body.get("error"))
        if has_error:
            error = ThreadsTokenErrorResponse.model_validate(body)
            raise ThreadsOAuthError(f"Threads token request failed: {error.message}")
        if "access_token" not in body:
            raise ThreadsOAuthError("Threads token response was missing an access token.")
        return ThreadsTokenSuccessResponse.model_validate(body)
