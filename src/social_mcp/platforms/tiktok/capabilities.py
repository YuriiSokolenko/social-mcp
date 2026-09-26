"""TikTok scope-to-capability mapping and resolution.

This module turns a connected TikTok account's granted Login Kit scopes into the
set of read capabilities an MCP client may rely on, mirroring the Threads
pattern in :mod:`social_mcp.server.capabilities` and the capability contract
described in ``docs/threads-tool-contract.md``.

Design rules (consistent with ``docs/PROJECT_CONTEXT.md`` and the MCP capability
contract):

* A capability is reported **only** when the connected account's granted scopes
  authorize it. No capability is reported merely because the corresponding tool
  handler exists.
* Resolution is a pure function of the connected account, so it is
  deterministic and testable without a network or a real token.
* Only the read-side capability areas requested in issue #78 are mapped:
  ``profile``, ``video`` and ``statistics``. Write/publish scopes are declared
  in :mod:`social_mcp.platforms.tiktok.constants` but intentionally excluded
  from this read-side map (their tools belong to issues #22 and #23).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from social_mcp.platforms.tiktok.constants import (
    PLATFORM_TIKTOK,
    SCOPE_USER_INFO_BASIC,
    SCOPE_USER_INFO_STATS,
    SCOPE_VIDEO_LIST,
)
from social_mcp.storage.models import ConnectedAccount

#: Ordered capability definitions for TikTok: name, human-readable reason for the
#: unavailable case, and the minimal set of granted scopes that unlock it. The
#: ``required`` list is the source of truth: no capability becomes available
#: unless every one of these scopes is granted on the connected account.
type TikTokCapabilityDef = tuple[str, str, list[str]]

TIKTOK_CAPABILITY_DEFS: list[TikTokCapabilityDef] = [
    (
        "profile",
        f"missing required scope {SCOPE_USER_INFO_BASIC}",
        [SCOPE_USER_INFO_BASIC],
    ),
    (
        "video",
        f"missing required scope {SCOPE_VIDEO_LIST}",
        [SCOPE_VIDEO_LIST],
    ),
    (
        "statistics",
        f"missing required scope {SCOPE_USER_INFO_STATS}",
        [SCOPE_USER_INFO_STATS],
    ),
]


class TikTokCapability(BaseModel):
    """A single TikTok capability surfaced to the MCP client."""

    #: Whether the capability is currently available to the connected account.
    available: bool
    #: Stable identifier of the capability (profile/video/statistics).
    name: str
    #: Machine-readable reason for the current state (never contains secrets).
    reason: str = ""
    #: The set of scopes that would make this capability available.
    requires_scopes: list[str] = Field(default_factory=list)


class TikTokCapabilities(BaseModel):
    """The resolved capabilities for the connected (or absent) TikTok account."""

    platform: str = PLATFORM_TIKTOK
    #: Whether a TikTok account is connected at all.
    connected: bool
    #: Capabilities keyed by their contract name (profile/video/statistics).
    capabilities: dict[str, TikTokCapability] = Field(default_factory=dict)

    @property
    def available(self) -> list[str]:
        """The names of capabilities that are currently available."""

        return [name for name, cap in self.capabilities.items() if cap.available]


def _granted_scopes(account: ConnectedAccount | None) -> frozenset[str]:
    if account is None:
        return frozenset()
    return frozenset(account.scopes)


def resolve_tiktok_capabilities(account: ConnectedAccount | None) -> TikTokCapabilities:
    """Resolve the capabilities available to a TikTok account.

    Args:
        account: The connected TikTok account, or ``None`` when no account is
            connected. Nothing is assumed from code presence: every capability
            below is derived from the granted scopes on this account.

    Returns:
        A :class:`TikTokCapabilities` describing which operations the
        connected account may perform. When ``account`` is ``None`` every
        capability reports ``available=False`` with the reason "no connected
        account".
    """

    scopes = _granted_scopes(account)
    connected = account is not None

    capabilities: dict[str, TikTokCapability] = {}
    for name, reason_missing, required in TIKTOK_CAPABILITY_DEFS:
        available = connected and all(scope in scopes for scope in required)
        if not connected:
            reason = "no connected account"
        elif not available:
            reason = reason_missing
        else:
            reason = ""
        capabilities[name] = TikTokCapability(
            name=name,
            available=available,
            reason=reason,
            requires_scopes=required,
        )

    return TikTokCapabilities(
        platform=PLATFORM_TIKTOK,
        connected=connected,
        capabilities=capabilities,
    )


def is_tiktok_scope_sufficient(
    account: ConnectedAccount | None,
    required_scopes: list[str],
) -> bool:
    """Return whether an account has every scope in ``required_scopes``.

    A ``None`` account is never sufficient. Shared with the MCP layer so tools
    and platform adapters use one definition of "granted" rather than
    re-deriving it from scope names.
    """

    if account is None:
        return False
    granted = set(account.scopes)
    return all(scope in granted for scope in required_scopes)
