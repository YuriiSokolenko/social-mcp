"""TikTok Login Kit OAuth constants: scopes and endpoints.

This module centralizes the TikTok Login Kit OAuth scope names and the
authorization/token endpoints so the adapter and capability-map stay in sync
with current official TikTok requirements (see "TikTok" in
``docs/PROJECT_CONTEXT.md``). Scope names follow TikTok's dotted notation
exactly and are declared once here; nothing downstream hard-codes them.

Read-side scopes used by this contract map to the three supported capability
areas:

* ``user.info.basic`` -> profile
* ``video.list``      -> video
* ``user.info.stats`` -> statistics

Write-side scopes (``video.upload``, ``video.publish``) are declared for
completeness but are intentionally out of scope for this read-side contract and
are excluded from the capability map (see issues #22 and #23).
"""

from __future__ import annotations

#: Platform identifier reported by the TikTok capability contract and stored on
#: a :class:`~social_mcp.storage.models.ConnectedAccount`. Matches
#: :attr:`~social_mcp.storage.models.SocialPlatform.TIKTOK`.
PLATFORM_TIKTOK = "tiktok"

# --- Read-side scopes (back the profile/video/statistics capability map) ---

#: Read-only access to a user's basic profile (open id, display name, avatar).
#: Added by default to all Login Kit apps; the user must still grant it.
SCOPE_USER_INFO_BASIC = "user.info.basic"

#: Read-only access to the list of a user's public TikTok videos.
SCOPE_VIDEO_LIST = "video.list"

#: Read access to a user's statistical data (likes count, follower count,
#: following count, video count) via TikTok's ``user.info.stats`` Login Kit
#: scope. Maps to the TikTok "statistics" capability. Like the video and other
#: scopes, this must also be enabled on the app page in the TikTok for
#: Developers portal; requesting it alone does not grant access if the app has
#: not been approved for it.
SCOPE_USER_INFO_STATS = "user.info.stats"

# --- Write-side scopes (declared, not mapped to a read capability) ---

#: Upload scope required to upload media that is later published (Direct Post
#: / draft upload). Requires TikTok review/audit; see issues #22 and #23.
SCOPE_VIDEO_UPLOAD = "video.upload"

#: Publish scope that creates and publishes content. Requires TikTok review;
#: not assumed available and excluded from this read-side contract.
SCOPE_VIDEO_PUBLISH = "video.publish"

#: All read-side scopes defined above. Used by tests and capability defaults.
READ_SCOPES: list[str] = [
    SCOPE_USER_INFO_BASIC,
    SCOPE_VIDEO_LIST,
    SCOPE_USER_INFO_STATS,
]

#: Every scope declared by this contract (read and write).
ALL_SCOPES: list[str] = [
    *READ_SCOPES,
    SCOPE_VIDEO_UPLOAD,
    SCOPE_VIDEO_PUBLISH,
]

# --- Authorization/token endpoints used by Login Kit ---

#: Web/Desktop authorization endpoint (new-generation Login Kit). Users are
#: redirected here with ``client_key``, ``scope``, ``redirect_uri``, ``state``
#: and ``response_type=code`` to begin the authorization-code flow.
AUTHORIZATION_URL = "https://www.tiktok.com/v2/auth/authorize/"

#: Token endpoint used for both the authorization-code exchange and the
#: refresh-token grant (POST, ``application/x-www-form-urlencoded``).
TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/"

#: Value of ``response_type`` for the authorization-code flow.
RESPONSE_TYPE_CODE = "code"

#: Scope separator TikTok uses in both the authorization request and the token
#: response ``scope`` field.
SCOPE_SEPARATOR = ","
