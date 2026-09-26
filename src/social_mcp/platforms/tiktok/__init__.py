"""TikTok Login Kit OAuth adapter and capability contract (issue #78).

This package defines the stable contract that the Web Admin and MCP layers
share for TikTok account connection:

* :mod:`social_mcp.platforms.tiktok.constants` -- Login Kit OAuth scope
  constants and the authorization/token endpoints;
* :mod:`social_mcp.platforms.tiktok.oauth` -- the adapter interface
  (authorization-URL construction, server-side token exchange and refresh-token
  handling), the token request/response models, the injectable HTTP transport
  boundary, and the TikTok account-state representation;
* :mod:`social_mcp.platforms.tiktok.capabilities` -- the TikTok
  scope-to-capability mapping (profile, video, statistics).

No Web Admin routes, OAuth execution, live TikTok API calls, or credential
handling live here: the adapter builds requests and parses responses, but
performs no network I/O itself and never stores or reads secrets.
"""

from __future__ import annotations

from social_mcp.platforms.tiktok.capabilities import (
    TIKTOK_CAPABILITY_DEFS,
    TikTokCapabilities,
    TikTokCapability,
    is_tiktok_scope_sufficient,
    resolve_tiktok_capabilities,
)
from social_mcp.platforms.tiktok.constants import (
    ALL_SCOPES,
    AUTHORIZATION_URL,
    PLATFORM_TIKTOK,
    READ_SCOPES,
    RESPONSE_TYPE_CODE,
    SCOPE_SEPARATOR,
    SCOPE_USER_INFO_BASIC,
    SCOPE_USER_INFO_STATS,
    SCOPE_VIDEO_LIST,
    SCOPE_VIDEO_PUBLISH,
    SCOPE_VIDEO_UPLOAD,
    TOKEN_URL,
)
from social_mcp.platforms.tiktok.oauth import (
    DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    TikTokAccountState,
    TikTokCodeExchangeRequest,
    TikTokLoginKitAdapter,
    TikTokOAuthAdapter,
    TikTokOAuthError,
    TikTokOAuthTransport,
    TikTokRefreshRequest,
    TikTokTokenErrorResponse,
    TikTokTokenSuccessResponse,
    token_response_to_account_state,
)

__all__ = [
    "ALL_SCOPES",
    "AUTHORIZATION_URL",
    "DEFAULT_ACCESS_TOKEN_TTL_SECONDS",
    "DEFAULT_REFRESH_TOKEN_TTL_SECONDS",
    "PLATFORM_TIKTOK",
    "READ_SCOPES",
    "RESPONSE_TYPE_CODE",
    "SCOPE_SEPARATOR",
    "SCOPE_USER_INFO_BASIC",
    "SCOPE_USER_INFO_STATS",
    "SCOPE_VIDEO_LIST",
    "SCOPE_VIDEO_PUBLISH",
    "SCOPE_VIDEO_UPLOAD",
    "TIKTOK_CAPABILITY_DEFS",
    "TOKEN_URL",
    "TikTokAccountState",
    "TikTokCapabilities",
    "TikTokCapability",
    "TikTokCodeExchangeRequest",
    "TikTokLoginKitAdapter",
    "TikTokOAuthAdapter",
    "TikTokOAuthError",
    "TikTokOAuthTransport",
    "TikTokRefreshRequest",
    "TikTokTokenErrorResponse",
    "TikTokTokenSuccessResponse",
    "is_tiktok_scope_sufficient",
    "resolve_tiktok_capabilities",
    "token_response_to_account_state",
]
