"""End-to-end tests for the Social MCP server and its tools.

Issue #18: discovery/capability behavior. Issue #3: read tools for the
connected Threads profile and posts. Tools are driven through an in-memory
MCP client/server session to pin tool discovery, normalized capabilities,
normalized read responses, and permission/missing-account error behavior.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

import httpx
import pytest
from conftest import VALID_TOKEN_ENCRYPTION_KEY
from mcp.client._memory import InMemoryTransport
from mcp.client.session import ClientSession

from social_mcp.auth.token_cipher import TokenCipher
from social_mcp.server.capabilities import (
    PLATFORM_THREADS,
    SCOPE_BASIC,
    SCOPE_CONTENT,
)
from social_mcp.server.errors import (
    AUTHENTICATION_REQUIRED,
    CAPABILITY_UNAVAILABLE,
    PERMISSION_REQUIRED,
    PLATFORM_ERROR,
)
from social_mcp.server.server import (
    _CAPABILITIES_TOOL_NAME,
    create_mcp_server,
)
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

ALL_SCOPES = [
    SCOPE_BASIC,
    SCOPE_CONTENT,
    "threads_content_publish",
    "threads_manage_replies",
    "threads_repost",
    "threads_quote",
    "threads_delete",
    "threads_insights",
    "threads_search",
    "threads_mention",
]

ThreadsAccountProvider = Callable[[], Awaitable[ConnectedAccount | None]]
_DECRYPTABLE_TOKEN = "test-access-token-value"


def _account(scopes=None, platform=SocialPlatform.THREADS):
    now = datetime(2030, 1, 1, tzinfo=UTC)
    return ConnectedAccount(
        platform=platform,
        external_account_id="10001",
        username="tester",
        scopes=scopes or [],
        access_token_encrypted=b"fake-encrypted-token",
        created_at=now,
        updated_at=now,
    )


def _account_with_token(scopes):
    a = _account(scopes)
    a.access_token_encrypted = TokenCipher(VALID_TOKEN_ENCRYPTION_KEY).encrypt(_DECRYPTABLE_TOKEN)
    return a


class FakeThreadsApiTransport:
    """ThreadsApiTransport double recording get calls (no live API)."""

    def __init__(self, responses):
        self.calls = []
        self._responses = responses

    async def get(self, url, *, params=None):
        self.calls.append((url, dict(params or {})))
        for suffix, response in self._responses.items():
            if url.endswith(suffix):
                return response
        return httpx.Response(404, json={"error": {"message": "not found"}})


def _profile_resp():
    return httpx.Response(
        200, json={"id": "40738237891", "username": "tester", "name": "Test User"}
    )


def _posts_resp(after="cursor2"):
    return httpx.Response(
        200,
        json={
            "data": [
                {
                    "id": "5782138901",
                    "media_text": "hello world",
                    "timestamp": "2040-01-01T12:00:00+0000",
                },
                {
                    "id": "5782138901",
                    "media_text": "second post",
                    "timestamp": "2040-01-02T12:00:00+0000",
                },
            ],
            "paging": {
                "cursors": {"after": after},
                "next": "https://graph.threads.com/40738237891/posts",
            },
        },
    )


def _post_resp():
    return httpx.Response(
        200,
        json={
            "id": "5782138901",
            "media_text": "hello world",
            "timestamp": "2040-01-01T12:00:00+0000",
            "permalink": "https://www.threads.net/@tester/post/1",
        },
    )


def _provider(account):
    async def _p():
        return account

    return _p


def make_server(account, *, token_cipher=None, threads_api_transport=None):
    return create_mcp_server(
        _provider(account),
        token_cipher=token_cipher,
        threads_api_transport=threads_api_transport,
    )


async def _list_tools(server):
    async with (
        InMemoryTransport(server) as (r, w),
        ClientSession(read_stream=r, write_stream=w) as session,
    ):
        await session.initialize()
        return (await session.list_tools()).tools


async def _call_tool(server, name, arguments=None):
    async with (
        InMemoryTransport(server) as (r, w),
        ClientSession(read_stream=r, write_stream=w) as session,
    ):
        await session.initialize()
        return await session.call_tool(name, arguments or {})


def _tool_text(result):
    return "\n".join(part.text if hasattr(part, "text") else str(part) for part in result.content)


def _parsed(result):
    return json.loads(_tool_text(result))


# --- discovery & capabilities ------------------------------------------------


@pytest.mark.asyncio
async def test_tool_is_discoverable_via_list_tools():
    tools = await _list_tools(make_server(_account(ALL_SCOPES)))
    assert len(tools) == 4
    names = {t.name for t in tools}
    assert names == {
        _CAPABILITIES_TOOL_NAME,
        "threads_get_profile",
        "threads_list_posts",
        "threads_get_post",
    }
    tool = next(t for t in tools if t.name == _CAPABILITIES_TOOL_NAME)
    assert tool.title == "Threads Capabilities"
    assert tool.annotations.read_only_hint is True


def test_server_name_and_version_are_advertised():
    server = create_mcp_server(_provider(None), server_name="social-mcp", server_version="0.2.0")
    assert server.name == "social-mcp"
    assert server.version == "0.2.0"


def test_platform_threads_constant():
    assert PLATFORM_THREADS == "threads"


@pytest.mark.asyncio
async def test_no_account_capabilities_is_error():
    result = await _call_tool(make_server(None), _CAPABILITIES_TOOL_NAME)
    assert result.is_error is True
    assert AUTHENTICATION_REQUIRED in _tool_text(result)


@pytest.mark.asyncio
async def test_no_account_get_profile_is_error():
    server = make_server(None, token_cipher=TokenCipher(VALID_TOKEN_ENCRYPTION_KEY))
    result = await _call_tool(server, "threads_get_profile")
    assert result.is_error is True
    assert AUTHENTICATION_REQUIRED in _tool_text(result)


@pytest.mark.asyncio
async def test_all_scopes_marks_all_available():
    result = await _call_tool(make_server(_account(ALL_SCOPES)), _CAPABILITIES_TOOL_NAME)
    assert result.is_error is False
    caps = _parsed(result)["capabilities"]
    assert _parsed(result)["connected"] is True
    assert set(caps) == {
        "profile",
        "posts",
        "replies",
        "repost",
        "quote",
        "publish",
        "reply_management",
        "delete",
        "insights",
        "search",
        "mentions",
    }
    for name, cap in caps.items():
        assert cap["available"] is True, name


@pytest.mark.asyncio
async def test_partial_scopes_report_only_granted():
    result = await _call_tool(
        make_server(_account([SCOPE_BASIC, SCOPE_CONTENT])), _CAPABILITIES_TOOL_NAME
    )
    caps = _parsed(result)["capabilities"]
    assert caps["profile"]["available"] is True
    assert caps["posts"]["available"] is True
    assert caps["publish"]["available"] is False
    assert "scope" in caps["publish"]["reason"]


@pytest.mark.asyncio
async def test_provider_called_at_call_time():
    state = {"done": False}

    async def provider():
        state["done"] = True
        return _account([SCOPE_BASIC])

    result = await _call_tool(create_mcp_server(provider), _CAPABILITIES_TOOL_NAME)
    assert state["done"] is True
    assert result.is_error is False


@pytest.mark.asyncio
async def test_provider_returning_none_is_error():
    calls = {"n": 0}

    async def provider():
        calls["n"] += 1

    result = await _call_tool(create_mcp_server(provider), _CAPABILITIES_TOOL_NAME)
    assert result.is_error is True
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_provider_unknown_error_normalized_to_platform_error():
    async def provider():
        raise RuntimeError("unexpected adapter failure")

    result = await _call_tool(create_mcp_server(provider), _CAPABILITIES_TOOL_NAME)
    assert result.is_error is True
    assert PLATFORM_ERROR in _tool_text(result)


@pytest.mark.asyncio
async def test_non_threads_account_is_ignored():
    result = await _call_tool(
        make_server(_account([SCOPE_BASIC], platform=SocialPlatform.TIKTOK)),
        _CAPABILITIES_TOOL_NAME,
    )
    assert result.is_error is True
    assert AUTHENTICATION_REQUIRED in _tool_text(result)


def test_find_connected_account_helper_picks_threads_account():
    from social_mcp.server.server import _find_connected_account

    threads = _account([SCOPE_BASIC])
    tiktok = _account([], platform=SocialPlatform.TIKTOK)
    assert _find_connected_account([tiktok, threads]) == threads
    assert _find_connected_account([tiktok]) is None
    assert _find_connected_account([]) is None
    another = _account([SCOPE_BASIC])
    another.external_account_id = "2"
    assert _find_connected_account([threads, another]).external_account_id == "10001"


# --- read tools --------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_profile_normalized_with_platform_id():
    server = make_server(
        _account_with_token([SCOPE_BASIC]),
        token_cipher=TokenCipher(VALID_TOKEN_ENCRYPTION_KEY),
        threads_api_transport=FakeThreadsApiTransport({"/me": _profile_resp()}),
    )
    result = await _call_tool(server, "threads_get_profile")
    assert result.is_error is False
    profile = _parsed(result)
    assert profile["platform"] == "threads"
    assert profile["id"] == "40738237891"
    assert profile["username"] == "tester"
    assert profile["name"] == "Test User"


@pytest.mark.asyncio
async def test_get_profile_without_scope_is_permission_required():
    server = make_server(
        _account_with_token([SCOPE_CONTENT]), token_cipher=TokenCipher(VALID_TOKEN_ENCRYPTION_KEY)
    )
    result = await _call_tool(server, "threads_get_profile")
    assert result.is_error is True
    assert PERMISSION_REQUIRED in _tool_text(result)


@pytest.mark.asyncio
async def test_get_profile_without_token_cipher_is_capability_unavailable():
    server = make_server(
        _account_with_token([SCOPE_BASIC]),
        token_cipher=None,
        threads_api_transport=FakeThreadsApiTransport({"/me": _profile_resp()}),
    )
    result = await _call_tool(server, "threads_get_profile")
    assert result.is_error is True
    assert CAPABILITY_UNAVAILABLE in _tool_text(result)


@pytest.mark.asyncio
async def test_list_posts_items_and_next_cursor():
    transport = FakeThreadsApiTransport({"/me/posts": _posts_resp()})
    server = make_server(
        _account_with_token([SCOPE_CONTENT]),
        token_cipher=TokenCipher(VALID_TOKEN_ENCRYPTION_KEY),
        threads_api_transport=transport,
    )
    result = await _call_tool(server, "threads_list_posts", {"limit": 10})
    assert result.is_error is False
    payload = _parsed(result)
    assert len(payload["items"]) == 2
    assert payload["items"][0]["id"] == "5782138901"
    assert payload["items"][0]["platform"] == "threads"
    assert payload["next_cursor"] == "cursor2"
    _, params = transport.calls[0]
    assert params["access_token"] == _DECRYPTABLE_TOKEN
    assert params["fields"] == "id,media_text,timestamp,permalink"
    assert params["limit"] == "10"


@pytest.mark.asyncio
async def test_list_posts_forwards_cursor_and_clamps_limit():
    transport = FakeThreadsApiTransport({"/me/posts": _posts_resp(after=None)})
    server = make_server(
        _account_with_token([SCOPE_CONTENT]),
        token_cipher=TokenCipher(VALID_TOKEN_ENCRYPTION_KEY),
        threads_api_transport=transport,
    )
    result = await _call_tool(server, "threads_list_posts", {"limit": 999, "cursor": "abc"})
    assert result.is_error is False
    assert _parsed(result)["next_cursor"] is None
    _, params = transport.calls[0]
    assert params["limit"] == "100"  # clamped to MAX
    assert params["after"] == "abc"


@pytest.mark.asyncio
async def test_list_posts_without_scope_is_permission_required():
    server = make_server(
        _account_with_token([SCOPE_BASIC]), token_cipher=TokenCipher(VALID_TOKEN_ENCRYPTION_KEY)
    )
    result = await _call_tool(server, "threads_list_posts", {"limit": 5})
    assert result.is_error is True
    assert PERMISSION_REQUIRED in _tool_text(result)


@pytest.mark.asyncio
async def test_get_post_normalized_with_platform_id():
    transport = FakeThreadsApiTransport({"/5782138901": _post_resp()})
    server = make_server(
        _account_with_token([SCOPE_CONTENT]),
        token_cipher=TokenCipher(VALID_TOKEN_ENCRYPTION_KEY),
        threads_api_transport=transport,
    )
    result = await _call_tool(server, "threads_get_post", {"post_id": "5782138901"})
    assert result.is_error is False
    post = _parsed(result)
    assert post["platform"] == "threads"
    assert post["id"] == "5782138901"
    assert post["text"] == "hello world"
    assert post["permalink"] == "https://www.threads.net/@tester/post/1"


@pytest.mark.asyncio
async def test_get_post_not_found_is_not_found():
    transport = FakeThreadsApiTransport({"/5782138901": _post_resp()})
    server = make_server(
        _account_with_token([SCOPE_CONTENT]),
        token_cipher=TokenCipher(VALID_TOKEN_ENCRYPTION_KEY),
        threads_api_transport=transport,
    )
    result = await _call_tool(server, "threads_get_post", {"post_id": "missing-id"})
    assert result.is_error is True
    assert "not_found" in _tool_text(result)


@pytest.mark.asyncio
async def test_list_posts_empty_cursor_omitted_when_none():
    """When no cursor is supplied, the request should not carry an after param."""
    transport = FakeThreadsApiTransport({"/me/posts": _posts_resp()})
    server = make_server(
        _account_with_token([SCOPE_CONTENT]),
        token_cipher=TokenCipher(VALID_TOKEN_ENCRYPTION_KEY),
        threads_api_transport=transport,
    )
    await _call_tool(server, "threads_list_posts", {"limit": 5})
    _, params = transport.calls[0]
    assert "after" not in params
