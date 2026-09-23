import json

import httpx

from social_mcp.app import VERSION, app


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_version_endpoint_returns_expected_body() -> None:
    async with _client() as client:
        response = await client.get("/version")

    assert response.status_code == 200
    assert response.json() == {"version": "0.1.0"}
    assert response.text == '{"version":"0.1.0"}'


async def test_version_endpoint_body_matches_app_version() -> None:
    async with _client() as client:
        response = await client.get("/version")

    assert app.version == VERSION
    assert response.json() == {"version": VERSION}


async def test_health_endpoint_is_unchanged() -> None:
    async with _client() as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_version_endpoint_rejects_post() -> None:
    async with _client() as client:
        response = await client.post("/version", json={"version": "9.9.9"})

    assert response.status_code == 405


async def test_version_endpoint_is_not_listed_under_other_paths() -> None:
    async with _client() as client:
        response = await client.get("/versions")

    assert response.status_code == 404
    assert json.loads(response.text) == {"detail": "Not Found"}
