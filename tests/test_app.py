from fastapi.testclient import TestClient

from social_mcp.app import app


def test_ready_returns_exactly_ready_true() -> None:
    client = TestClient(app)

    response = client.get("/ready")

    assert response.status_code == 200
    assert response.content == b'{"ready":true}'
