"""The admin shell is closed by default and never exposes stored credentials."""

from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from social_mcp.app import create_app
from social_mcp.config import Settings
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

ADMIN_AUTH = ("admin", "example-secret")


@pytest.fixture()
def admin_app(tmp_path: Path, make_settings: Callable[..., Settings]):
    """An authenticated admin application backed by a fresh database."""

    app = create_app(
        make_settings(tmp_path, admin_username="admin", admin_password="example-secret")
    )
    with TestClient(app) as client:
        yield app, client


def _save_account(app, account: ConnectedAccount) -> ConnectedAccount:
    """Persist an account into the running app's store for testing."""
    return app.state.container.account_store.save(account)



def _make_account(
    *,
    platform: SocialPlatform = SocialPlatform.THREADS,
    external_account_id: str = "10001",
    username: str | None = "tester",
    scopes: list[str] | None = None,
    expires_at: datetime | None = None,
) -> ConnectedAccount:
    now = datetime(2030, 1, 1, 12, 0, 30, tzinfo=UTC)
    return ConnectedAccount(
        platform=platform,
        external_account_id=external_account_id,
        username=username,
        scopes=scopes if scopes is not None else ["threads_basic"],
        access_token_encrypted=b"fake-access-token-bytes",
        refresh_token_encrypted=None,
        token_expires_at=expires_at,
        created_at=now,
        updated_at=now,
    )


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


def test_dashboard_reports_service_and_storage_status(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.get("/admin/dashboard", auth=ADMIN_AUTH)

    assert response.status_code == 200
    body = response.text
    assert "Service: ok" in body
    assert "Storage: ok" in body
    assert "Token encryption: configured" in body


def test_dashboard_reports_disabled_token_encryption(
    tmp_path: Path, make_settings: Callable[..., Settings],
) -> None:
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin", admin_password="example-secret",
            token_encryption_key=None,
        )
    )

    with TestClient(app) as client:
        response = client.get("/admin/dashboard", auth=ADMIN_AUTH)

    assert response.status_code == 200
    assert "Token encryption: disabled" in response.text


def test_dashboard_reports_no_connected_accounts(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.get("/admin/dashboard", auth=ADMIN_AUTH)

    assert response.status_code == 200
    assert "Connected accounts: 0" in response.text
    # No account table is rendered when there are no accounts.
    assert "<table>" not in response.text


def test_dashboard_counts_connected_accounts(
    admin_app,
) -> None:
    app, client = admin_app
    for i in range(3):
        _save_account(app, _make_account(external_account_id=str(20000 + i)))

    response = client.get("/admin/dashboard", auth=ADMIN_AUTH)

    assert response.status_code == 200
    assert "Connected accounts: 3" in response.text


def test_dashboard_reports_unavailable_storage(
    admin_app,
) -> None:
    app, client = admin_app
    # Point the store at a path whose parent does not exist after deletion.
    app.state.container.account_store.database_path = (
        app.state.container.account_store.database_path.parent / "gone" / "db.sqlite3"
    )

    response = client.get("/admin/dashboard", auth=ADMIN_AUTH)

    assert response.status_code == 200
    assert "Storage: unavailable" in response.text
    assert "Connected accounts: unknown" in response.text


def test_accounts_lists_no_connected_accounts(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.get("/admin/accounts", auth=ADMIN_AUTH)

    assert response.status_code == 200
    assert "No connected accounts." in response.text


def test_accounts_lists_connected_accounts_without_tokens(
    admin_app,
) -> None:
    app, client = admin_app
    account = _make_account(
        platform=SocialPlatform.TIKTOK,
        external_account_id="tiktok-1",
        username="tiktok-user",
        scopes=["video.list", "user.info"],
    )
    _save_account(app, account)

    response = client.get("/admin/accounts", auth=ADMIN_AUTH)

    assert response.status_code == 200
    body = response.text
    assert "tiktok" in body
    assert "tiktok-user" in body
    assert "tiktok-1" in body
    assert "video.list, user.info" in body
    assert account.created_at.isoformat() in body
    assert account.updated_at.isoformat() in body
    # Token values must never appear in the rendered page.
    assert b"fake-access-token-bytes" not in response.text.encode("utf-8")


def test_accounts_page_has_disabled_connect_threads_placeholder(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.get("/admin/accounts", auth=ADMIN_AUTH)

    assert response.status_code == 200
    assert "Connect Threads (coming soon)" in response.text
    # The placeholder is a disabled button, not a link, so it cannot
    # navigate anywhere or fake a connection.
    assert '<button type="button" disabled>' in response.text
    # No OAuth/connect endpoint exists to invoke from the accounts page.
    assert "/admin/connect" not in response.text
    assert 'action="' not in response.text
    assert "oauth/authorize" not in response.text


def test_accounts_never_exposes_encrypted_token_bytes(
    admin_app,
) -> None:
    app, client = admin_app
    account = _make_account()
    stored = _save_account(app, account)

    body = client.get("/admin/accounts", auth=ADMIN_AUTH).text

    # Neither the raw encrypted bytes nor the plaintext appear in the page.
    assert stored.access_token_encrypted.hex() not in body
    assert stored.access_token_encrypted.decode("latin-1", errors="ignore") not in body


def test_token_status_classifies_valid_tokens(
    admin_app,
) -> None:
    app, client = admin_app
    future = datetime.now(UTC).replace(year=datetime.now(UTC).year + 1)
    _save_account(app, _make_account(expires_at=future))

    body = client.get("/admin/accounts", auth=ADMIN_AUTH).text

    assert "valid" in body
    assert "expired" not in body


def test_token_status_classifies_expired_tokens(
    admin_app,
) -> None:
    app, client = admin_app
    past = datetime.now(UTC).replace(year=datetime.now(UTC).year - 1)
    _save_account(app, _make_account(expires_at=past))

    body = client.get("/admin/accounts", auth=ADMIN_AUTH).text

    assert "expired" in body
    assert "valid" not in body


def test_token_status_handles_tokens_without_expiry(
    admin_app,
) -> None:
    app, client = admin_app
    _save_account(app, _make_account(expires_at=None))

    body = client.get("/admin/accounts", auth=ADMIN_AUTH).text

    assert "no expiry" in body
    assert "expired" not in body


def test_dashboard_and_accounts_show_admin_navigation(
    admin_app,
) -> None:
    _, client = admin_app

    for path in ("/admin/dashboard", "/admin/accounts"):
        body = client.get(path, auth=ADMIN_AUTH).text
        assert "/admin/dashboard" in body
        assert "/admin/accounts" in body


def test_admin_routes_are_not_cacheable(
    admin_app,
) -> None:
    _, client = admin_app

    for path in ("/admin/dashboard", "/admin/accounts"):
        response = client.get(path, auth=ADMIN_AUTH)
        assert response.headers["cache-control"] == "no-store"


def test_admin_password_is_not_leaked_in_any_response(
    admin_app,
) -> None:
    _, client = admin_app

    for path in ("/admin/dashboard", "/admin/accounts"):
        body = client.get(path, auth=ADMIN_AUTH).text
        assert "example-secret" not in body


def test_dashboard_reflects_storage_failure_after_startup(
    admin_app,
) -> None:
    app, client = admin_app
    _save_account(app, _make_account())
    # Simulate a database removal that the read-only check would reject.
    app.state.container.account_store.database_path.unlink()

    response = client.get("/admin/dashboard", auth=ADMIN_AUTH)

    assert response.status_code == 200
    assert "Storage: unavailable" in response.text


def test_accounts_handles_storage_failure_gracefully(
    admin_app,
) -> None:
    app, client = admin_app
    app.state.container.account_store.database_path.unlink()

    response = client.get("/admin/accounts", auth=ADMIN_AUTH)

    assert response.status_code == 200
    # On storage failure the accounts page must not crash; it shows no accounts.
    assert "No connected accounts." in response.text
