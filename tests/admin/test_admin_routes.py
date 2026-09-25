"""The admin shell is closed by default and never exposes stored credentials."""

from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from social_mcp.app import create_app
from social_mcp.config import Settings


@pytest.mark.parametrize("path", ["/admin/", "/admin/dashboard", "/admin/accounts"])
@pytest.mark.parametrize(
    "config",
    [{}, {"admin_username": "admin"}, {"admin_password": "example-secret"}],
)
def test_admin_routes_require_configuration(
    path: str, config: dict[str, str], tmp_path: Path,
    make_settings: Callable[..., Settings],
) -> None:
    app = create_app(make_settings(tmp_path, **config))

    with TestClient(app) as client:
        response = client.get(path, auth=("admin", "example-secret"))
        health = client.get("/health")

    assert response.status_code == 503
    assert health.status_code == 200


def test_admin_requires_valid_credentials(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(tmp_path, admin_username="admin", admin_password="example-secret")
    )

    with TestClient(app) as client:
        missing = client.get("/admin/dashboard")
        wrong = client.get("/admin/accounts", auth=("admin", "incorrect"))
        unicode_name = client.get("/admin/accounts", auth=("админ", "example-secret"))

    for response in (missing, wrong, unicode_name):
        assert response.status_code == 401
        assert response.headers["www-authenticate"].startswith("Basic")
        assert "example-secret" not in response.text


@pytest.mark.parametrize(
    ("path", "page"),
    [("/admin/", "Dashboard"), ("/admin/dashboard", "Dashboard"),
     ("/admin/accounts", "Accounts")],
)
def test_admin_entry_points_are_available_to_authenticated_admin(
    path: str, page: str, tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(tmp_path, admin_username="admin", admin_password="example-secret")
    )

    with TestClient(app) as client:
        response = client.get(path, auth=("admin", "example-secret"))

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert response.headers["cache-control"] == "no-store"
    assert page in response.text
    assert "/admin/dashboard" in response.text
    assert "/admin/accounts" in response.text
    assert "example-secret" not in response.text


def test_admin_is_unavailable_before_startup(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(tmp_path, admin_username="admin", admin_password="example-secret")
    )

    response = TestClient(app).get("/admin/accounts", auth=("admin", "example-secret"))

    assert response.status_code == 503
