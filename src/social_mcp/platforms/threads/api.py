"""Threads read API adapter for the Social MCP server.

Single boundary that knows about the Threads/Meta Graph API: endpoint shapes,
request fields and response parsing. Read-only (GET only) by construction.

Design rules (from ``docs/threads-tool-contract.md``):
* Read tools never mutate Threads state.
* Platform API details stay inside this adapter.
* Normalized responses preserve platform IDs for follow-up operations.
* Access tokens are supplied by the caller (the MCP server decrypts them) and
  are never stored, logged or returned. HTTP reliability is delegated to the
  shared :class:`~social_mcp.platforms.reliability.PlatformHttpClient`.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Protocol, Self, runtime_checkable

import httpx
from pydantic import BaseModel, ConfigDict, Field

from social_mcp.platforms.reliability import PlatformHttpClient
from social_mcp.platforms.threads.constants import PLATFORM_THREADS

#: Base URL of the Threads/Meta Graph API.
GRAPH_BASE_URL = "https://graph.threads.com"

#: Field selectors accepted by the Threads Graph API.
_PROFILE_FIELDS = "id,username,name"
_POST_FIELDS = "id,media_text,timestamp,permalink"

#: Bounds for the paginated ``limit`` parameter. Threads allows up to 100.
MIN_LIMIT = 1
MAX_LIMIT = 100
DEFAULT_LIMIT = 10


# ---------------------------------------------------------------------------
# Normalized response models (preserve platform IDs)
# ---------------------------------------------------------------------------


class ThreadsProfile(BaseModel):
    """The connected Threads profile.

    ``id`` is the Threads platform user ID, preserved for follow-up operations.
    """

    model_config = ConfigDict(extra="ignore")

    platform: str = PLATFORM_THREADS
    id: str
    username: str | None = None
    name: str | None = None


class ThreadsPost(BaseModel):
    """A single Threads post.

    ``id`` is the platform post ID, preserved for ``threads_get_post`` and future
    reply/moderation tools.
    """

    model_config = ConfigDict(extra="ignore")

    platform: str = PLATFORM_THREADS
    id: str
    text: str | None = None
    created_at: datetime | None = None
    permalink: str | None = None


class ThreadsPostList(BaseModel):
    """A page of posts plus a cursor for the next page.

    ``next_cursor`` is set when another page exists, ``None`` otherwise.
    """

    model_config = ConfigDict(extra="ignore")

    items: list[ThreadsPost] = Field(default_factory=list)
    next_cursor: str | None = None


# ---------------------------------------------------------------------------
# Transport boundary (mirrors ThreadsOAuthTransport Protocol pattern)
# ---------------------------------------------------------------------------


@runtime_checkable
class ThreadsApiTransport(Protocol):
    """Injectable network boundary for the Threads Graph API.

    Mirrors ``ThreadsOAuthTransport``: a single-method protocol that adapters
    implement and tests fake. Returns an :class:`httpx.Response` so the client
    can inspect status, headers (e.g. paging cursors) and JSON bodies whether
    the transport is a real ``PlatformHttpClient`` or a deterministic test
    double.
    """

    async def get(
        self,
        url: str,
        *,
        params: Mapping[str, object] | None = None,
    ) -> httpx.Response:
        """Issue a ``GET`` to ``url`` and return the raw response."""

        raise NotImplementedError


class ThreadsApiError(Exception):
    """API-level (non-HTTP) issues surfaced by the client.

    HTTP failures surface as ``PlatformHttpError`` from the reliability policy
    and map to MCP categories via ``to_mcp_error``. This covers malformed-but-
    2xx responses (e.g. a missing required field); it maps to ``platform_error``.
    """


def _clamp_limit(limit: int) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise ThreadsApiError(f"limit must be an integer, got {type(limit).__name__}")
    return max(MIN_LIMIT, min(MAX_LIMIT, limit))


def _http_error(response: httpx.Response) -> Exception:
    """Turn a non-2xx response into a ``PlatformHttpError``.

    Uses the response's status code and JSON body (when present and safe) so
    the caller's ``to_mcp_error`` can normalize it; no credentials are read.
    """

    from social_mcp.platforms.reliability import PlatformHttpError

    message = f"graph.threads.com request failed (HTTP {response.status_code})"
    try:
        body = response.json()
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict) and error.get("message"):
                # ``redact_message`` is applied by the mapping layer; the OAuth
                # adapter contract already guarantees safe non-secret messages
                # here, but we keep only the message string regardless.
                message = str(error["message"])
    except (ValueError, AttributeError):
        pass
    return PlatformHttpError(message, status_code=response.status_code)


class _PlatformTransport(ThreadsApiTransport):
    """Default transport backed by the shared reliability policy."""

    def __init__(self) -> None:
        self._client = PlatformHttpClient()

    async def get(self, url: str, *, params=None) -> httpx.Response:
        return await self._client.request("GET", url, params=params)

    async def aclose(self) -> None:
        await self._client.aclose()


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class ThreadsApiClient:
    """A read-only client for the Threads Graph API.

    Issues only ``GET`` requests (profile, posts listing, single post) so it can
    never mutate Threads state. The access token is supplied at construction
    and forwarded as a Bearer credential; it is never logged, stored beyond the
    request, or included in any exception message.

    Args:
        access_token: A decrypted OAuth access token for the connected account.
        transport: Optional :class:`ThreadsApiTransport`. When omitted, a
            :class:`PlatformHttpClient` (via :class:`_PlatformTransport`) is
            used, providing retry, rate-limit and timeout handling for real API
            calls.
        graph_base_url: Override the API base URL (tests only).
    """

    def __init__(
        self,
        access_token: str,
        transport: ThreadsApiTransport | None = None,
        *,
        graph_base_url: str | None = None,
    ) -> None:
        if not access_token or not isinstance(access_token, str):
            raise ValueError("access_token must be a non-empty string")
        self._access_token = access_token
        self._base_url = (graph_base_url or GRAPH_BASE_URL).rstrip("/")
        self._transport = transport
        self._owns_transport = transport is None
        self._platform_transport: _PlatformTransport | None = None

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Release any transport-owned resources."""

        if self._platform_transport is not None:
            await self._platform_transport.aclose()
            self._platform_transport = None

    def _effective_transport(self) -> ThreadsApiTransport:
        if self._transport is not None:
            return self._transport
        if self._platform_transport is None:
            self._platform_transport = _PlatformTransport()
        return self._platform_transport

    async def _get(
        self, path: str, *, params: Mapping[str, object] | None = None
    ) -> dict[str, Any]:
        """Issue an authenticated GET and return the parsed JSON body.

        The access token is passed as a query parameter per the Threads Graph
        API and is never logged. HTTP errors surface as ``PlatformHttpError``.
        """

        url = f"{self._base_url}{path}"
        merged: dict[str, object] = dict(params) if params else {}
        merged.setdefault("access_token", self._access_token)
        response = await self._effective_transport().get(url, params=merged)
        if response.status_code >= 400:
            raise _http_error(response)
        body = response.json()
        if not isinstance(body, dict):
            raise ThreadsApiError(f"unexpected non-object response from {path}")
        return body

    # -- public API -------------------------------------------------------

    async def get_profile(self) -> ThreadsProfile:
        """Return the connected account's profile.

        ``GET /me?fields=id,username,name``. HTTP failures surface as
        ``PlatformHttpError``; a 2xx missing ``id`` raises
        :class:`ThreadsApiError`.
        """

        body = await self._get("/me", params={"fields": _PROFILE_FIELDS})
        user_id = body.get("id")
        if not user_id:
            raise ThreadsApiError("profile response missing 'id'")
        return ThreadsProfile(
            id=str(user_id),
            username=body.get("username"),
            name=body.get("name"),
        )

    async def list_posts(
        self, limit: int = DEFAULT_LIMIT, cursor: str | None = None
    ) -> ThreadsPostList:
        """List the connected account's posts.

        ``GET /me/posts?fields=...&limit=<clamped>&after=<cursor>``. ``limit``
        is clamped to ``[1, 100]``. ``next_cursor`` is taken from the response
        paging block when another page exists.
        """

        clamped = _clamp_limit(limit)
        params: dict[str, object] = {"fields": _POST_FIELDS, "limit": str(clamped)}
        if cursor:
            params["after"] = cursor
        body = await self._get("/me/posts", params=params)
        data = body.get("data")
        if not isinstance(data, list):
            raise ThreadsApiError("posts response missing 'data' list")
        items = [_parse_post(item) for item in data if isinstance(item, dict)]
        paging = body.get("paging") or {}
        next_cursor = None
        if isinstance(paging, dict):
            cursors = paging.get("cursors")
            if isinstance(cursors, dict):
                next_cursor = cursors.get("after")
        return ThreadsPostList(items=items, next_cursor=next_cursor)

    async def get_post(self, post_id: str) -> ThreadsPost:
        """Return a single accessible post by platform ID.

        ``GET /{post_id}?fields=...``.
        """

        if not post_id or not isinstance(post_id, str):
            raise ThreadsApiError("post_id must be a non-empty string")
        body = await self._get(f"/{post_id}", params={"fields": _POST_FIELDS})
        return _parse_post(body)


def _parse_post(item: dict[str, Any]) -> ThreadsPost:
    """Normalize a single post dict from the Threads API."""

    post_id = item.get("id")
    if not post_id:
        raise ThreadsApiError("post response missing 'id'")
    return ThreadsPost(
        id=str(post_id),
        text=item.get("media_text"),
        created_at=item.get("timestamp"),
        permalink=item.get("permalink"),
    )
