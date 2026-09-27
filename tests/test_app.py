"""Tests for the pipeline-check endpoint.

A deterministic smoke test for the deployment pipeline. The endpoint does not
touch account storage, so these tests exercise it without running startup.
"""

from fastapi.testclient import TestClient

from social_mcp.app import app


def test_pipeline_check_returns_200() -> None:
    response = TestClient(app).get("/pipeline-check")

    assert response.status_code == 200
    assert response.json() == {"status": "pipeline-ok"}


def test_pipeline_check_response_body_is_exact() -> None:
    response = TestClient(app).get("/pipeline-check")

    assert response.content == b'{"status":"pipeline-ok"}'


def test_pipeline_check_rejects_other_methods() -> None:
    assert TestClient(app).post("/pipeline-check").status_code == 405


def test_pipeline_check_is_registered_in_openapi() -> None:
    assert "/pipeline-check" in app.openapi()["paths"]
