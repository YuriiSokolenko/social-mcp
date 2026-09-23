from fastapi.testclient import TestClient

from social_mcp.app import app


def test_ping_returns_pong() -> None:
    client = TestClient(app)

    response = client.get("/ping")

    assert response.status_code == 200
    assert response.json() == {"message": "pong"}


def test_ping_response_body_is_exact() -> None:
    client = TestClient(app)

    response = client.get("/ping")

    assert response.content == b'{"message":"pong"}'


def test_ping_rejects_other_methods() -> None:
    client = TestClient(app)

    assert client.post("/ping").status_code == 405


def test_health_is_unchanged() -> None:
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
