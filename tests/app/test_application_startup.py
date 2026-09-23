"""Tests for application startup wiring and the health endpoint.

The transport layer must stay thin: dependencies come from the container and
startup is what creates the account database. No real credentials or platform
APIs are involved.
"""

import sqlite3
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from social_mcp.app import create_app, get_container
from social_mcp.config import Settings
from social_mcp.container import (
    ApplicationContainer,
    ContainerUnavailableError,
    DatabaseUnavailableError,
)


@pytest.fixture()
def make_request():
    """Build a bare request bound to ``app``, as a route handler receives one."""

    def build(app: FastAPI) -> Request:
        return Request({"type": "http", "app": app})

    return build


def test_startup_creates_the_configured_database(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    database_path = tmp_path / "startup" / "social-mcp.db"
    app = create_app(make_settings(tmp_path, database_url=f"sqlite:///{database_path}"))

    with TestClient(app):
        assert database_path.exists()
        assert app.state.container.account_store.list_accounts() == []


def test_startup_wires_settings_into_the_container(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    settings = make_settings(tmp_path)
    app = create_app(settings)

    with TestClient(app):
        container = app.state.container

    assert isinstance(container, ApplicationContainer)
    assert container.settings is settings
    assert container.account_store.database_path == settings.database_path


def test_creating_an_app_has_no_filesystem_side_effects(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    database_path = tmp_path / "lazy" / "social-mcp.db"

    create_app(make_settings(tmp_path, database_url=f"sqlite:///{database_path}"))

    assert not database_path.exists()
    assert not database_path.parent.exists()


def test_startup_reports_an_unusable_database_location(tmp_path: Path) -> None:
    blocker = tmp_path / "blocked"
    blocker.write_text("not a directory")
    app = create_app(
        Settings(_env_file=None, database_url=f"sqlite:///{blocker / 'accounts.db'}")
    )

    with pytest.raises(DatabaseUnavailableError), TestClient(app):
        pass


def test_health_reports_a_healthy_store(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(make_settings(tmp_path))

    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_route_stays_registered(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(make_settings(tmp_path))

    assert "/health" in app.openapi()["paths"]


def test_health_reports_unhealthy_when_the_store_is_unreachable(
    tmp_path: Path, make_settings: Callable[..., Settings], caplog
) -> None:
    app = create_app(make_settings(tmp_path))

    with TestClient(app) as client:
        app.state.container.account_store.database_path = tmp_path / "gone" / "accounts.db"

        with caplog.at_level("ERROR"):
            response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "unhealthy"}
    assert "Account storage is unavailable" in caplog.text


def test_health_reports_unhealthy_before_startup(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(make_settings(tmp_path))

    # No context manager: the lifespan never ran, so no container was wired.
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "unhealthy"}


def test_health_reports_unhealthy_when_the_store_query_fails(
    tmp_path: Path, make_settings: Callable[..., Settings], caplog
) -> None:
    app = create_app(make_settings(tmp_path))

    with TestClient(app) as client:
        app.state.container.account_store.check = _broken_check

        response = client.get("/health")

    assert response.json() == {"status": "unhealthy"}
    assert "Account storage is unavailable" in caplog.text


def test_get_container_fails_before_startup(
    tmp_path: Path, make_settings: Callable[..., Settings], make_request
) -> None:
    app = create_app(make_settings(tmp_path))

    with pytest.raises(ContainerUnavailableError):
        get_container(make_request(app))


def test_get_container_returns_the_wired_dependencies(
    tmp_path: Path, make_settings: Callable[..., Settings], make_request
) -> None:
    app = create_app(make_settings(tmp_path))

    with TestClient(app):
        container = get_container(make_request(app))

    assert container is app.state.container


def _broken_check() -> None:
    raise sqlite3.OperationalError("unable to open database file")
