"""Threads capability resolution.

This module is the application-core logic that turns a connected account's
granted OAuth scopes into the set of capabilities an MCP client may rely on.

Design rules from the tool contract (``docs/threads-tool-contract.md``) and the
issue this implements:

* A capability is reported **only** when the connected account's granted scopes
  authorize it. No capability is reported merely because the corresponding
  handler code exists.
* Resolution is a pure function of the connected account so it is deterministic
  and testable without a network or a real token.

Scope names follow the Threads/Meta API. The mapping below is the minimal set
that backs the ``threads_capabilities`` tool; it can be extended as the
implementation validates exact current Meta scope requirements without changing
the function's contract.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from social_mcp.storage.models import ConnectedAccount

#: The Threads platform identifier reported by ``threads_capabilities``.
PLATFORM_THREADS = "threads"

# Threads/Meta OAuth scope names. Declared once so the mapping below stays in
# sync with the values stored in a ConnectedAccount and returned by Meta.
SCOPE_BASIC = "threads_basic"
SCOPE_CONTENT = "threads_content"
SCOPE_CONTENT_PUBLISH = "threads_content_publish"
SCOPE_MANAGE_REPLIES = "threads_manage_replies"
SCOPE_MANAGE_REACTION = "threads_manage_reaction"
SCOPE_REPOST = "threads_repost"
SCOPE_QUOTE = "threads_quote"
SCOPE_DELETE = "threads_delete"
SCOPE_INSIGHTS = "threads_insights"
SCOPE_SEARCH = "threads_search"
SCOPE_MENTION = "threads_mention"

# A mapping from a Threads/Meta scope to the *display* capability names it
# enables. The inverse of this (which scopes a capability needs) is computed in
# :func:`CAPABILITY_DEFS`, but keeping scope -> capability as well lets the
# resolver answer "does this scope matter at all" without special-casing.
SCOPE_TO_CAPABILITIES: dict[str, list[str]] = {
    SCOPE_BASIC: ["profile"],
    SCOPE_CONTENT: ["posts"],
    SCOPE_CONTENT_PUBLISH: ["publish"],
    SCOPE_MANAGE_REPLIES: ["reply_management"],
    SCOPE_REPOST: ["repost"],
    SCOPE_QUOTE: ["quote"],
    SCOPE_DELETE: ["delete"],
    SCOPE_INSIGHTS: ["insights"],
    SCOPE_SEARCH: ["search"],
    SCOPE_MENTION: ["mentions"],
}

#: Ordered capability definitions: name, human-readable reason template (used
#: only when the capability is unavailable and an account is connected), and the
#: minimal set of granted scopes that unlock it. The ``required`` list is the
#: source of truth: no capability becomes available unless every one of these
#: scopes is granted on the connected account.
type CapabilityDef = tuple[str, str, list[str]]

CAPABILITY_DEFS: list[CapabilityDef] = [
    (
        "profile",
        f"missing required scope {SCOPE_BASIC}",
        [SCOPE_BASIC],
    ),
    (
        "posts",
        f"missing required scope {SCOPE_CONTENT}",
        [SCOPE_CONTENT],
    ),
    (
        "replies",
        f"missing required scope {SCOPE_MANAGE_REPLIES}",
        [SCOPE_MANAGE_REPLIES],
    ),
    (
        "repost",
        f"missing required scope {SCOPE_REPOST}",
        [SCOPE_REPOST],
    ),
    (
        "quote",
        f"missing required scope {SCOPE_QUOTE}",
        [SCOPE_QUOTE],
    ),
    (
        "publish",
        f"missing required scope {SCOPE_CONTENT_PUBLISH}",
        [SCOPE_CONTENT_PUBLISH],
    ),
    # Reply management needs to both read and publish; both scopes unlock it.
    (
        "reply_management",
        f"missing required scopes {SCOPE_CONTENT_PUBLISH} and {SCOPE_MANAGE_REPLIES}",
        [SCOPE_CONTENT_PUBLISH, SCOPE_MANAGE_REPLIES],
    ),
    (
        "delete",
        f"missing required scope {SCOPE_DELETE}",
        [SCOPE_DELETE],
    ),
    (
        "insights",
        f"missing required scope {SCOPE_INSIGHTS}",
        [SCOPE_INSIGHTS],
    ),
    (
        "search",
        f"missing required scope {SCOPE_SEARCH}",
        [SCOPE_SEARCH],
    ),
    (
        "mentions",
        f"missing required scope {SCOPE_MENTION}",
        [SCOPE_MENTION],
    ),
]


class Capability(BaseModel):
    """A single capability surfaced to the MCP client."""

    #: Whether the capability is currently available to the connected account.
    available: bool
    #: Stable identifier of the capability, matching the contract section.
    name: str
    #: Machine-readable reason for the current state (never contains secrets).
    reason: str = ""
    #: The set of scopes that would make this capability available.
    requires_scopes: list[str] = Field(default_factory=list)


class ThreadsCapabilities(BaseModel):
    """The resolved capabilities for the connected (or absent) Threads account."""

    platform: str = PLATFORM_THREADS
    #: Whether a Threads account is connected at all.
    connected: bool
    #: Capabilities keyed by their contract name.
    capabilities: dict[str, Capability] = Field(default_factory=dict)

    @property
    def available(self) -> list[str]:
        """The names of capabilities that are currently available."""

        return [name for name, cap in self.capabilities.items() if cap.available]


def _granted_scopes(account: ConnectedAccount | None) -> frozenset[str]:
    if account is None:
        return frozenset()
    return frozenset(account.scopes)


def resolve_threads_capabilities(account: ConnectedAccount | None) -> ThreadsCapabilities:
    """Resolve the capabilities available to a Threads account.

    Args:
        account: The connected Threads account, or ``None`` when no account is
            connected. Nothing is assumed from code presence: every capability
            below is derived from the granted scopes on this account.

    Returns:
        A :class:`ThreadsCapabilities` describing which operations the
        connected account may perform. When ``account`` is ``None`` every
        capability reports ``available=False`` with the reason "no connected
        account".
    """

    scopes = _granted_scopes(account)
    connected = account is not None

    capabilities: dict[str, Capability] = {}
    for name, reason_missing, required in CAPABILITY_DEFS:
        available = connected and all(scope in scopes for scope in required)
        if connected and not available:
            reason = reason_missing
        elif not connected:
            reason = "no connected account"
        else:
            reason = ""
        capabilities[name] = Capability(
            name=name,
            available=available,
            reason=reason,
            requires_scopes=required,
        )

    return ThreadsCapabilities(
        platform=PLATFORM_THREADS,
        connected=connected,
        capabilities=capabilities,
    )


def is_scope_sufficient(
    account: ConnectedAccount | None,
    required_scopes: list[str],
) -> bool:
    """Return whether an account has every scope in ``required_scopes``.

    A ``None`` account is never sufficient. This helper exists so the MCP tools
    and future platform adapters share one definition of "granted" rather than
    re-deriving it from scope names.
    """

    if account is None:
        return False
    granted = set(account.scopes)
    return all(scope in granted for scope in required_scopes)
