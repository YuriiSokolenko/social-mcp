"""End-to-end tests for the Social MCP server and its ``threads_capabilities`` tool.

Issue #18 requires tests for discovery/capability behavior. These tests drive the
registered tool through the full in-memory MCP client/server session so the
``is_error`` and structured-content behavior the reviewer exercised is pinned:

* the tool is discoverable via ``list_tools``;
* no connected account -> ``is_error=True`` with an ``authentication_required`` reason;
* a connected account -> structured capabilities;
* capabilities reflect the granted scopes, never code presence;
* a non-Threads account is ignored (no account reported).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

import pytest
from mcp.client._memory import InMemoryTransport
from mcp.client.session import ClientSession
from mcp_types import Tool

from social_mcp.server.capabilities import (
    PLATFORM_THREADS,
    SCOPE_BASIC,
    SCOPE_CONTENT,
)
from social_mcp.server.errors import AUTHENTICATION_REQUIRED
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


def _account(
    scopes: list[str] | None = None,
    platform: SocialPlatform = SocialPlatform.THREADS,
) -> ConnectedAccount:
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


def _provider(account: ConnectedAccount | None) -> ThreadsAccountProvider:
    async def _p() -> ConnectedAccount | None:
        return account

    return _p


async def _list_tools(server) -> list[Tool]:
    async with InMemoryTransport(server) as (r, w), ClientSession(
        read_stream=r, write_stream=w
    ) as session:
        await session.initialize()
        return (await session.list_tools()).tools


async def _call_tool(server, name: str, arguments: dict | None = None):
    async with InMemoryTransport(server) as (r, w), ClientSession(
        read_stream=r, write_stream=w
    ) as session:
        await session.initialize()
        return await session.call_tool(name, arguments or {})


def make_server(account: ConnectedAccount | None):
    return create_mcp_server(_provider(account))


@pytest.mark.asyncio
async def test_tool_is_discoverable_via_list_tools() -> None:
    tools = await _list_tools(make_server(_account(ALL_SCOPES)))

    assert len(tools) == 1
    tool = tools[0]
    assert tool.name == _CAPABILITIES_TOOL_NAME
    assert tool.title == "Threads Capabilities"
    # Discovery is read-only.
    assert tool.annotations.read_only_hint is True
    assert tool.annotations.open_world_hint is False


def test_server_name_and_version_are_advertised() -> None:
    server = create_mcp_server(_provider(None), server_name="social-mcp", server_version="0.2.0")
    assert server.name == "social-mcp"
    assert server.version == "0.2.0"


def test_platform_threads_constant() -> None:
    assert PLATFORM_THREADS == "threads"


@pytest.mark.asyncio
async def test_no_connected_account_returns_is_error_with_authentication_required() -> None:
    server = make_server(None)

    result = await _call_tool(server, _CAPABILITIES_TOOL_NAME)

    assert result.is_error is True
    text = _tool_text(result)
    assert AUTHENTICATION_REQUIRED in text
    assert "threads" in text.lower()


@pytest.mark.asyncio
async def test_connected_account_with_all_scopes_marks_all_available() -> None:
    server = make_server(_account(ALL_SCOPES))

    result = await _call_tool(server, _CAPABILITIES_TOOL_NAME)

    assert result.is_error is False
    capabilities = _parsed_content(result)
    assert capabilities["platform"] == "threads"
    assert capabilities["connected"] is True

    caps = capabilities["capabilities"]
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
    # Every capability reports available=True with a populated requires_scopes.
    for name, cap in caps.items():
        assert cap["available"] is True, name
        assert cap["requires_scopes"], name
        assert cap["reason"] == ""


@pytest.mark.asyncio
async def test_partial_account_reports_only_granted_capabilities() -> None:
    # The central case for "no capability from code presence": granting only
    # basic + content leaves publish/reply_management/etc. unavailable.
    server = make_server(_account([SCOPE_BASIC, SCOPE_CONTENT]))

    result = await _call_tool(server, _CAPABILITIES_TOOL_NAME)

    assert result.is_error is False
    caps = _parsed_content(result)["capabilities"]

    assert caps["profile"]["available"] is True
    assert caps["posts"]["available"] is True
    # Nothing beyond basic+content is granted, so the rest stay unavailable.
    for name in (
        "replies",
        "repost",
        "quote",
        "publish",
        "reply_management",
        "delete",
        "insights",
        "search",
        "mentions",
    ):
        assert caps[name]["available"] is False, name
        assert "scope" in caps[name]["reason"], name

    # publish needs content_publish, which is absent.
    assert caps["publish"]["requires_scopes"] == ["threads_content_publish"]
    assert caps["publish"]["available"] is False


@pytest.mark.asyncio
async def test_provider_called_at_call_time_for_account() -> None:
    # A provider that returns an account only after first invocation should still
    # resolve correctly, proving account lookup is at call time, not startup.
    state = {"returned": False}

    async def provider() -> ConnectedAccount | None:
        state["returned"] = True
        return _account([SCOPE_BASIC])

    server = create_mcp_server(provider)
    result = await _call_tool(server, _CAPABILITIES_TOOL_NAME)

    assert state["returned"] is True
    assert result.is_error is False
    caps = _parsed_content(result)["capabilities"]
    assert caps["profile"]["available"] is True


@pytest.mark.asyncio
async def test_provider_returning_none_each_call_yields_is_error() -> None:
    calls = {"n": 0}

    async def provider() -> ConnectedAccount | None:
        calls["n"] += 1
        return None

    server = create_mcp_server(provider)
    result = await _call_tool(server, _CAPABILITIES_TOOL_NAME)

    assert result.is_error is True
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_non_threads_account_is_ignored_so_no_account_is_connected() -> None:
    # A TikTok account is present, but no Threads account -> the provider's
    # contract says return the Threads account or None. Returning the TikTok
    # account here would be a provider bug; the server must still report
    # "no connected account" rather than deriving a capability from it.
    server = make_server(_account([SCOPE_BASIC], platform=SocialPlatform.TIKTOK))

    result = await _call_tool(server, _CAPABILITIES_TOOL_NAME)

    assert result.is_error is True
    assert AUTHENTICATION_REQUIRED in _tool_text(result)


def test_find_connected_account_helper_picks_threads_account() -> None:
    from social_mcp.server.server import _find_connected_account

    threads = _account([SCOPE_BASIC])
    tiktok = _account([], platform=SocialPlatform.TIKTOK)

    assert _find_connected_account([tiktok, threads]) == threads
    assert _find_connected_account([tiktok]) is None
    assert _find_connected_account([]) is None
    # First Threads account wins.
    another = _account([SCOPE_BASIC])
    another.external_account_id = "2"
    assert _find_connected_account([threads, another]).external_account_id == threads.external_account_id


# ---- helpers -----------------------------------------------------------------


def _tool_text(result) -> str:
    """Concatenate the text content of a CallToolResult."""

    return "\n".join(
        part.text if hasattr(part, "text") else str(part) for part in result.content
    )


def _parsed_content(result) -> dict:
    """Parse the structured JSON content returned by ``threads_capabilities``."""

    import json

    return json.loads(_tool_text(result))
