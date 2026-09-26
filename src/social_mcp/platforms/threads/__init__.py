"""Threads/Meta OAuth adapter contract (issue #16).

This package defines the stable contract that the Web Admin and MCP layers
share for Threads account connection:

* :mod:`social_mcp.platforms.threads.constants` -- Threads/Meta OAuth scope
  constants and the authorization/token endpoints;
* :mod:`social_mcp.platforms.threads.oauth` -- the adapter interface
  (authorization-URL construction, server-side token exchange), the token
  request/response models, the injectable HTTP transport boundary, and the
  Threads account-state representation that maps a token response onto the
  shared :class:`~social_mcp.storage.models.ConnectedAccount`.

No Web Admin routes, OAuth execution, live Meta/Threads API calls, or
credential handling live here: the adapter builds requests and parses
responses, but performs no network I/O itself and never stores or reads
secrets.
"""

from __future__ import annotations

from social_mcp.platforms.threads.constants import (
    ALL_SCOPES,
    AUTHORIZATION_URL,
    DEFAULT_CALLBACK_PATH,
    PLATFORM_THREADS,
    RESPONSE_TYPE_CODE,
    SCOPE_SEPARATOR,
    SCOPE_THREADS_BASIC,
    TOKEN_URL,
    parse_scopes,
)
from social_mcp.platforms.threads.oauth import (
    DEFAULT_SHORT_LIVED_TOKEN_TTL_SECONDS,
    ThreadsAccountState,
    ThreadsCodeExchangeRequest,
    ThreadsLoginAdapter,
    ThreadsOAuthAdapter,
    ThreadsOAuthError,
    ThreadsOAuthTransport,
    ThreadsTokenErrorResponse,
    ThreadsTokenSuccessResponse,
    token_response_to_account_state,
)

__all__ = [
    "ALL_SCOPES",
    "AUTHORIZATION_URL",
    "DEFAULT_CALLBACK_PATH",
    "DEFAULT_SHORT_LIVED_TOKEN_TTL_SECONDS",
    "PLATFORM_THREADS",
    "RESPONSE_TYPE_CODE",
    "SCOPE_SEPARATOR",
    "SCOPE_THREADS_BASIC",
    "TOKEN_URL",
    "ThreadsAccountState",
    "ThreadsCodeExchangeRequest",
    "ThreadsLoginAdapter",
    "ThreadsOAuthAdapter",
    "ThreadsOAuthError",
    "ThreadsOAuthTransport",
    "ThreadsTokenErrorResponse",
    "ThreadsTokenSuccessResponse",
    "parse_scopes",
    "token_response_to_account_state",
]
