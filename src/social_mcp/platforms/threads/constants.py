"""Threads/Meta OAuth constants: scopes and endpoints.

This module centralizes the Threads/Meta OAuth scope names and the
authorization/token endpoints so the adapter and Web Admin stay in sync with
the official Meta/Threads API (verified against ``developers.facebook.com/docs/``
as referenced by ``docs/oauth.md``). Scope names follow the Threads API exactly
and are declared once here; nothing downstream hard-codes them.

``threads_basic`` is the required minimum scope for connecting an account and
cannot be removed. The remaining scopes back the read/write capabilities
described in ``docs/threads-tool-contract.md``; only the scopes the connected
account actually grants are ever persisted or surfaced.
"""

from __future__ import annotations

#: Platform identifier reported by the Threads capability contract and stored on
#: a :class:`~social_mcp.storage.models.ConnectedAccount`. Matches
#: :attr:`~social_mcp.storage.models.SocialPlatform.THREADS`.
PLATFORM_THREADS = "threads"

# --- Required minimum scope -------------------------------------------------

#: Required scope for connecting a Threads account. It grants access to the
#: connected profile and **must always** be requested; Meta will not accept a
#: connection without it. See ``docs/oauth.md`` "Required minimum scopes".
SCOPE_THREADS_BASIC = "threads_basic"

# --- Optional scopes (documented; requested only as needed) -----------------
# The names below mirror ``docs/oauth.md`` "Required minimum scopes" so the
# configuration, the authorization URL and the documentation cannot drift apart.

#: Read replies to the connected user's posts.
SCOPE_READ_REPLIES = "threads_read_replies"
#: Publish, reply to, and delete posts.
SCOPE_CONTENT_PUBLISH = "threads_content_publish"
#: Moderate/manage replies.
SCOPE_MANAGE_REPLIES = "threads_manage_replies"
#: Read account/content insights.
SCOPE_MANAGE_INSIGHTS = "threads_manage_insights"
#: Delete posts.
SCOPE_DELETE = "threads_delete"
#: Keyword search.
SCOPE_KEYWORD_SEARCH = "threads_keyword_search"
#: Location tagging on posts.
SCOPE_LOCATION_TAGGING = "threads_location_tagging"
#: Manage mentions.
SCOPE_MANAGE_MENTIONS = "threads_manage_mentions"
#: Profile discovery/search.
SCOPE_PROFILE_DISCOVERY = "threads_profile_discovery"

#: Every Threads scope declared by this contract, with the required scope first.
ALL_SCOPES: list[str] = [
    SCOPE_THREADS_BASIC,
    SCOPE_READ_REPLIES,
    SCOPE_CONTENT_PUBLISH,
    SCOPE_MANAGE_REPLIES,
    SCOPE_MANAGE_INSIGHTS,
    SCOPE_DELETE,
    SCOPE_KEYWORD_SEARCH,
    SCOPE_LOCATION_TAGGING,
    SCOPE_MANAGE_MENTIONS,
    SCOPE_PROFILE_DISCOVERY,
]

# --- Authorization/token endpoints used by the OAuth flow -------------------

#: Web authorization endpoint. The browser is redirected here with
#: ``client_id``, ``redirect_uri``, ``scope``, ``state`` and
#: ``response_type=code`` to begin the authorization-code flow.
AUTHORIZATION_URL = "https://threads.com/oauth/authorize"

#: Token endpoint used for the authorization-code exchange. Exchanged server-side
#: via ``POST`` ``application/x-www-form-urlencoded``.
TOKEN_URL = "https://graph.threads.com/oauth/access_token"

#: Value of ``response_type`` for the authorization-code flow.
RESPONSE_TYPE_CODE = "code"

#: Scope separator the Threads API uses in both the authorization request and
#: the token response ``scope`` field.
SCOPE_SEPARATOR = ","

#: The OAuth callback route registered in the admin router. The redirect URI
#: sent to Meta is built around this path (see ``docs/oauth.md``).
DEFAULT_CALLBACK_PATH = "/admin/oauth/callback/threads"


def parse_scopes(raw: str) -> list[str]:
    """Parse a comma-separated scope string into a de-duplicated list.

    The required ``threads_basic`` scope is always present: if the caller omits
    it (or supplies only optional scopes) it is inserted first, because Meta will
    not grant a Threads connection without it.
    """

    parsed = [part.strip() for part in raw.split(SCOPE_SEPARATOR) if part.strip()]
    if SCOPE_THREADS_BASIC not in parsed:
        parsed.insert(0, SCOPE_THREADS_BASIC)
    # De-duplicate while preserving order (the required scope stays first).
    seen: set[str] = set()
    scopes: list[str] = []
    for scope in parsed:
        if scope not in seen:
            seen.add(scope)
            scopes.append(scope)
    return scopes
