"""Unit tests for the Threads read API adapter.

Uses an injectable ThreadsApiTransport fake (canned httpx.Response objects) so
no live Threads/Meta API calls are made.
"""

from __future__ import annotations

import httpx
import pytest

from social_mcp.platforms.mapping import to_mcp_error
from social_mcp.platforms.reliability import PlatformHttpError
from social_mcp.platforms.threads.api import (
    GRAPH_BASE_URL,
    MAX_LIMIT,
    MIN_LIMIT,
    ThreadsApiClient,
    ThreadsApiError,
    ThreadsApiTransport,
    ThreadsPost,
    ThreadsPostList,
    ThreadsProfile,
)

_TOKEN = "test-access-token"


class FakeTransport:
    def __init__(self, responses=None, default_status=404):
        self.calls = []
        self._responses = responses or {}
        self._default_status = default_status

    async def get(self, url, *, params=None):
        self.calls.append((url, dict(params or {})))
        for suffix, response in self._responses.items():
            if url.endswith(suffix):
                return response
        return httpx.Response(self._default_status, json={"error": {"message": "nope"}})


def _profile_body():
    return {"id": "40738237891", "username": "tester", "name": "Test User"}


def _posts_body(after=None):
    return {
        "data": [
            {"id": "5782138901", "media_text": "hello", "timestamp": "2040-01-01T12:00:00+0000"},
            {"id": "5782138902", "media_text": "second", "timestamp": "2040-01-02T12:00:00+0000"},
        ],
        "paging": {"cursors": {"after": after}, "next": "https://graph.threads.com/x"},
    }


def _post_body():
    return {
        "id": "5782138901",
        "media_text": "hello",
        "timestamp": "2040-01-01T12:00:00+0000",
        "permalink": "https://www.threads.net/@tester/post/1",
    }


def _client(transport=None):
    return ThreadsApiClient(
        _TOKEN, transport=transport or FakeTransport(), graph_base_url=GRAPH_BASE_URL
    )


def test_default_transport_is_platform_http_client():
    assert isinstance(ThreadsApiClient(_TOKEN)._effective_transport(), ThreadsApiTransport)


def test_injected_transport_is_used():
    t = FakeTransport()
    assert _client(t)._effective_transport() is t


def test_empty_access_token_rejected():
    with pytest.raises(ValueError, match="access_token"):
        ThreadsApiClient("")


@pytest.mark.asyncio
async def test_get_profile_normalized_with_platform_id():
    t = FakeTransport({"/me": httpx.Response(200, json=_profile_body())})
    async with _client(t) as client:
        profile = await client.get_profile()
    assert isinstance(profile, ThreadsProfile)
    assert profile.platform == "threads"
    assert profile.id == "40738237891"
    assert profile.username == "tester"
    assert profile.name == "Test User"
    url, params = t.calls[0]
    assert url == f"{GRAPH_BASE_URL}/me"
    assert params["access_token"] == _TOKEN
    assert params["fields"] == "id,username,name"


@pytest.mark.asyncio
async def test_get_profile_missing_id_raises_api_error():
    t = FakeTransport({"/me": httpx.Response(200, json={"username": "x"})})
    async with _client(t) as client:
        with pytest.raises(ThreadsApiError):
            await client.get_profile()


@pytest.mark.asyncio
async def test_get_profile_non_dict_body_raises_api_error():
    t = FakeTransport({"/me": httpx.Response(200, json=[1, 2, 3])})
    async with _client(t) as client:
        with pytest.raises(ThreadsApiError):
            await client.get_profile()


@pytest.mark.asyncio
async def test_get_profile_401_maps_to_authentication_required():
    t = FakeTransport({"/me": httpx.Response(401, json={"error": {"message": "bad token"}})})
    async with _client(t) as client:
        with pytest.raises(PlatformHttpError) as exc_info:
            await client.get_profile()
    assert to_mcp_error(exc_info.value).category == "authentication_required"


@pytest.mark.asyncio
async def test_get_profile_403_maps_to_permission_required():
    t = FakeTransport({"/me": httpx.Response(403, json={"error": {"message": "forbidden"}})})
    async with _client(t) as client:
        with pytest.raises(PlatformHttpError) as exc_info:
            await client.get_profile()
    assert to_mcp_error(exc_info.value).category == "permission_required"


@pytest.mark.asyncio
async def test_list_posts_items_and_next_cursor():
    t = FakeTransport({"/me/posts": httpx.Response(200, json=_posts_body(after="cursor2"))})
    async with _client(t) as client:
        result = await client.list_posts(limit=5, cursor=None)
    assert isinstance(result, ThreadsPostList)
    assert len(result.items) == 2
    assert result.items[0].id == "5782138901"
    assert result.items[0].platform == "threads"
    assert result.next_cursor == "cursor2"
    _, params = t.calls[0]
    assert params["fields"] == "id,media_text,timestamp,permalink"
    assert params["limit"] == "5"
    assert "after" not in params


@pytest.mark.asyncio
async def test_list_posts_forwards_cursor_as_after():
    t = FakeTransport({"/me/posts": httpx.Response(200, json=_posts_body(after=None))})
    async with _client(t) as client:
        await client.list_posts(limit=10, cursor="cursor1")
    _, params = t.calls[0]
    assert params["after"] == "cursor1"


@pytest.mark.asyncio
async def test_list_posts_no_next_cursor_when_absent():
    t = FakeTransport(
        {"/me/posts": httpx.Response(200, json={"data": [{"id": "1"}], "paging": {}})}
    )
    async with _client(t) as client:
        result = await client.list_posts()
    assert result.next_cursor is None
    assert len(result.items) == 1


@pytest.mark.asyncio
async def test_list_posts_clamps_limit_to_max():
    t = FakeTransport({"/me/posts": httpx.Response(200, json=_posts_body())})
    async with _client(t) as client:
        await client.list_posts(limit=999)
    assert int(t.calls[0][1]["limit"]) == MAX_LIMIT


@pytest.mark.asyncio
async def test_list_posts_clamps_limit_to_min():
    t = FakeTransport({"/me/posts": httpx.Response(200, json=_posts_body())})
    async with _client(t) as client:
        await client.list_posts(limit=0)
    assert int(t.calls[0][1]["limit"]) == MIN_LIMIT


@pytest.mark.asyncio
async def test_list_posts_invalid_limit_type_raises_api_error():
    t = FakeTransport({"/me/posts": httpx.Response(200, json=_posts_body())})
    async with _client(t) as client:
        with pytest.raises(ThreadsApiError):
            await client.list_posts(limit=True)  # bool is rejected


@pytest.mark.asyncio
async def test_get_post_normalized_with_platform_id():
    t = FakeTransport({"/5782138901": httpx.Response(200, json=_post_body())})
    async with _client(t) as client:
        post = await client.get_post("5782138901")
    assert isinstance(post, ThreadsPost)
    assert post.platform == "threads"
    assert post.id == "5782138901"
    assert post.text == "hello"
    assert post.permalink == "https://www.threads.net/@tester/post/1"
    url, params = t.calls[0]
    assert url == f"{GRAPH_BASE_URL}/5782138901"
    assert params["fields"] == "id,media_text,timestamp,permalink"


@pytest.mark.asyncio
async def test_get_post_not_found_maps_via_to_mcp_error():
    t = FakeTransport({"/missing": httpx.Response(404, json={"error": {"message": "not found"}})})
    async with _client(t) as client:
        with pytest.raises(PlatformHttpError) as exc_info:
            await client.get_post("missing")
    assert to_mcp_error(exc_info.value).category == "not_found"


@pytest.mark.asyncio
async def test_get_post_empty_id_raises_api_error():
    async with _client(FakeTransport()) as client:
        with pytest.raises(ThreadsApiError):
            await client.get_post("")


@pytest.mark.asyncio
async def test_context_manager_closes_client():
    t = FakeTransport({"/me": httpx.Response(200, json=_profile_body())})
    async with _client(t) as client:
        await client.get_profile()
    # no assertions beyond not raising; closes the owned transport cleanly
