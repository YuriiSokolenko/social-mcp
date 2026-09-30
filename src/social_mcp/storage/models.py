"""Social account storage models.

Data models for connected social-platform accounts persisted by the Social MCP
service. These are pure data containers (no behavior) consumed by the server
and capability modules.

The connected account stores the OAuth scopes granted by the platform as the
authoritative source of which capabilities the account may exercise. No
capability is ever assumed from code presence.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class SocialPlatform(str, Enum):
    """Supported social platforms that can be connected."""

    THREADS = "threads"
    TIKTOK = "tiktok"


@dataclass(init=False, eq=False)
class ConnectedAccount:
    """A connected social-platform account.

    Attributes:
        platform: The social platform this account belongs to.
        external_account_id: Stable external identifier of the user on the
            platform.
        username: Public handle of the connected account.
        access_token_encrypted: Encrypted OAuth access token. Never stored or
            logged in plaintext; always decrypt via the :class:`TokenCipher`.
        scopes: The OAuth scopes granted by the connected account. The
            authoritative source of which capabilities the account may use.
        refresh_token_encrypted: Optional encrypted refresh token.
        expires_at: Optional expiry timestamp for the access token.
        created_at: Optional account creation timestamp.
        updated_at: Optional account last-updated timestamp.
        metadata: Optional platform-specific metadata.
    """

    platform: SocialPlatform
    external_account_id: str
    username: str
    access_token_encrypted: str
    scopes: list[str] = field(default_factory=list)
    refresh_token_encrypted: str | None = None
    expires_at: float | None = None
    created_at: float | None = None
    updated_at: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __init__(
        self,
        platform: SocialPlatform,
        external_account_id: str,
        username: str,
        access_token_encrypted: str,
        scopes: list[str] | None = None,
        refresh_token_encrypted: str | None = None,
        expires_at: float | None = None,
        created_at: float | None = None,
        updated_at: float | None = None,
        metadata: dict[str, Any] | None = None,
        **extra: Any,
    ) -> None:
        # Accept any additional keyword arguments so the model stays compatible
        # with platform-specific account metadata without coupling the core
        # model to a single provider's schema.
        self.platform = platform
        self.external_account_id = external_account_id
        self.username = username
        self.access_token_encrypted = access_token_encrypted
        self.scopes = list(scopes) if scopes is not None else []
        self.refresh_token_encrypted = refresh_token_encrypted
        self.expires_at = expires_at
        self.created_at = created_at
        self.updated_at = updated_at
        self.metadata = dict(metadata) if metadata is not None else {}
        for key, value in extra.items():
            setattr(self, key, value)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, ConnectedAccount) and self.__dict__ == other.__dict__

    def __hash__(self) -> int:
        return hash(
            (
                self.platform,
                self.external_account_id,
                self.username,
                self.access_token_encrypted,
                tuple(self.scopes),
            )
        )
