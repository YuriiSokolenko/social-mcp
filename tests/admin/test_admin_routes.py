"""Web Admin routes are only reachable through an authenticated session.

Covers:
* admin routes reject anonymous access (303/401/503 depending on config);
* credentials/session secrets come from environment configuration and are never
  committed (tests use only throwaway values);
* secure cookie/session behaviour: signed session cookie with HttpOnly +
  SameSite=Lax, Secure only off in development;
* /health stays anonymous and suitable for container health checks;
* CSRF tokens guard state-changing requests;
* the dashboard/accounts pages never expose stored credentials.
"""

import re
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from social_mcp.app import create_app
from social_mcp.config import Settings
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

ADMIN_AUTH = ("admin", "example-secret")
ADMIN_SESSION_SECRET = "test-session-secret-not-for-production-use"

# Mirrors the session key used by social_mcp.admin.routes.
_SESSION_KEY_FIELD = "admin_session"


def _signed_cookie(secret: str, data: dict) -> str:
    """Produce a session cookie exactly like SessionMiddleware would."""

    from itsdangerous import URLSafeTimedSerializer

    serializer = URLSafeTimedSerializer(secret, salt="cookie-session")
    return serializer.dumps(data)


@pytest.fixture()
def admin_app(tmp_path: Path, make_settings: Callable[..., Settings]):
    """An authenticated admin application backed by a fresh database.

    The app is fully configured (credentials + session secret), and a session
    is established so protected routes can be exercised directly.
    """

    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )
    with TestClient(app) as client:
        # Establish a session via the login endpoint.
        client.post("/admin/login", auth=ADMIN_AUTH)
        yield app, client


def _csrf(client: TestClient) -> str:
    """Return a fresh CSRF token by logging in, returning the token value."""

    response = client.post("/admin/login", auth=ADMIN_AUTH)
    # The token is embedded in a hidden input in the login success page.
    match = re.search(r"value='([^']+)'", response.text)
    assert match is not None, "login response did not expose a CSRF token"
    return match.group(1)


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


# --- /health stays anonymous -------------------------------------------------


def test_health_does_not_require_admin_configuration(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """/health must work even when the admin UI is entirely unconfigured."""

    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_openapi_does_not_require_admin_configuration(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(make_settings(tmp_path))

    with TestClient(app) as client:
        response = client.get("/openapi.json")

    assert response.status_code == 200
    assert "/health" in response.json()["paths"]


# --- unauthenticated access is rejected -------------------------------------


@pytest.mark.parametrize("path", ["/admin/", "/admin/dashboard", "/admin/accounts"])
def test_admin_routes_require_an_active_session_when_configured(
    path: str,
    tmp_path: Path,
    make_settings: Callable[..., Settings],
) -> None:
    """With admin configured, anonymous access is redirected to login (303)."""

    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )

    with TestClient(app) as client:
        response = client.get(path, follow_redirects=False)
        health = client.get("/health")

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/login"
    assert health.status_code == 200
    assert health.json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/admin/", "/admin/dashboard", "/admin/accounts"])
def test_admin_routes_are_unavailable_without_configuration(
    path: str,
    tmp_path: Path,
    make_settings: Callable[..., Settings],
) -> None:
    """With no admin credentials or session secret, admin is 503 (never open)."""

    app = create_app(
        make_settings(
            tmp_path, admin_username=None, admin_password=None,
            admin_session_secret=None,
        )
    )

    with TestClient(app) as client:
        # Anonymous access and even supplied credentials are rejected.
        anonymous = client.get(path, follow_redirects=False)
        with_credentials = client.get(
            path, follow_redirects=False, auth=("admin", "example-secret")
        )

    assert anonymous.status_code == 503
    assert with_credentials.status_code == 503
    assert "example-secret" not in anonymous.text
    assert "example-secret" not in with_credentials.text


@pytest.mark.parametrize("config", [{}, {"admin_username": "admin"}])
def test_admin_credentials_without_session_secret_are_rejected(
    config: dict[str, str],
    tmp_path: Path,
    make_settings: Callable[..., Settings],
) -> None:
    """Credentials without a session secret cannot establish a session."""

    app = create_app(make_settings(tmp_path, admin_session_secret=None, **config))
    with TestClient(app) as client:
        login = client.post("/admin/login", auth=("admin", "example-secret"))

    assert login.status_code == 503


def test_session_without_secret_is_not_issuable_when_unconfigured(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """A forged session cookie must not grant access when admin is unconfigured."""

    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=None,
        )
    )

    with TestClient(app) as client:
        client.cookies.set("session", "admin_session=true")
        # No SessionMiddleware is registered without a session secret, so even a
        # forged session cookie is meaningless and admin routes are unavailable.
        response = client.get("/admin/dashboard", follow_redirects=False)

    assert response.status_code == 503


# --- login / logout and credential validation -------------------------------


def test_login_rejects_bad_credentials(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )

    with TestClient(app) as client:
        wrong = client.post("/admin/login", auth=("admin", "incorrect"))
        unknown_user = client.post("/admin/login", auth=("other", "example-secret"))

    for response in (wrong, unknown_user):
        assert response.status_code == 401
        assert response.headers["www-authenticate"].startswith("Basic")
        assert "example-secret" not in response.text


def test_login_rejects_missing_credentials(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )

    with TestClient(app) as client:
        response = client.post("/admin/login")

    assert response.status_code == 401


def test_login_accepts_form_fields_for_browser_auth(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """The browser login form submits username/password form fields."""

    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )

    with TestClient(app) as client:
        response = client.post(
            "/admin/login",
            data={"username": "admin", "password": "example-secret"},
        )

    assert response.status_code == 200
    assert client.get("/admin/dashboard").status_code == 200


def test_login_rejects_bad_form_credentials(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )

    with TestClient(app) as client:
        response = client.post(
            "/admin/login", data={"username": "admin", "password": "wrong"}
        )

    assert response.status_code == 401


def test_login_page_renders_a_form_that_submits_credentials(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )

    with TestClient(app) as client:
        response = client.get("/admin/login")

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert response.headers["cache-control"] == "no-store"
    # The form posts username/password fields to /admin/login.
    assert 'action="/admin/login"' in response.text
    assert 'name="username"' in response.text
    assert 'name="password"' in response.text
    assert 'method="post"' in response.text


def test_login_establishes_a_signed_session_cookie(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )

    with TestClient(app) as client:
        response = client.post("/admin/login", auth=ADMIN_AUTH)
        cookie = response.cookies.get("session")

    assert response.status_code == 200
    assert cookie is not None
    # The cookie is HttpOnly and SameSite=Lax (secure off in development).
    set_cookie = response.headers["set-cookie"].lower()
    assert "httponly" in set_cookie
    assert "samesite=lax" in set_cookie


def test_cookie_is_secure_in_production(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
            environment="production",
        )
    )

    with TestClient(app) as client:
        response = client.post("/admin/login", auth=ADMIN_AUTH)

    set_cookie = response.headers["set-cookie"].lower()
    assert "secure" in set_cookie
    assert "httponly" in set_cookie


def test_logout_clears_the_session(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.post("/admin/logout", follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/login"
    # After logout, protected routes redirect again.
    assert client.get("/admin/dashboard", follow_redirects=False).status_code == 303


def test_session_password_is_never_present_in_any_response(
    admin_app,
) -> None:
    _, client = admin_app

    for path in ("/admin/login", "/admin/dashboard", "/admin/accounts"):
        body = client.get(path).text
        assert "example-secret" not in body


# --- CSRF protection on state-changing requests -----------------------------


def test_state_changing_requests_require_a_csrf_token(
    admin_app,
) -> None:
    _, client = admin_app

    # Without a CSRF token, a POST is rejected.
    response = client.post("/admin/accounts/disconnect")
    assert response.status_code == 403

    # With a valid token from the session, it is accepted (handler is not yet
    # implemented, but the request must pass CSRF to reach it, not 403).
    token = _csrf(client)
    response = client.post(
        "/admin/accounts/disconnect", headers={"x-csrf-token": token}
    )
    assert response.status_code != 403


def test_csrf_token_must_match_the_session(
    admin_app,
) -> None:
    _, client = admin_app
    token_a = _csrf(client)
    # A second login rotates the token, invalidating the previous one.
    token_b = _csrf(client)

    response = client.post(
        "/admin/accounts/disconnect", headers={"x-csrf-token": token_a}
    )
    assert response.status_code == 403

    response = client.post(
        "/admin/accounts/disconnect", headers={"x-csrf-token": token_b}
    )
    assert response.status_code != 403


# --- authenticated access to the dashboard/accounts ---------------------------


@pytest.mark.parametrize(
    ("path", "page"),
    [("/admin/", "Dashboard"), ("/admin/dashboard", "Dashboard"),
     ("/admin/accounts", "Accounts")],
)
def test_authenticated_admin_can_reach_entry_points(
    path: str, page: str, admin_app
) -> None:
    _, client = admin_app

    response = client.get(path)

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
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )

    response = TestClient(app).get("/admin/accounts", auth=ADMIN_AUTH)

    assert response.status_code == 503


def test_dashboard_reports_service_and_storage_status(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.get("/admin/dashboard")

    assert response.status_code == 200
    body = response.text
    assert "Service: ok" in body
    assert "Storage: ok" in body
    assert "Token encryption: configured" in body


def test_dashboard_reports_disabled_token_encryption(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
            token_encryption_key=None,
        )
    )

    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        response = client.get("/admin/dashboard")

    assert response.status_code == 200
    assert "Token encryption: disabled" in response.text


def test_dashboard_reports_no_connected_accounts(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.get("/admin/dashboard")

    assert response.status_code == 200
    assert "Connected accounts: 0" in response.text
    assert "<table>" not in response.text


def test_dashboard_counts_connected_accounts(
    admin_app,
) -> None:
    app, client = admin_app
    for i in range(3):
        _save_account(app, _make_account(external_account_id=str(20000 + i)))

    response = client.get("/admin/dashboard")

    assert response.status_code == 200
    assert "Connected accounts: 3" in response.text


def test_dashboard_reports_unavailable_storage(
    admin_app,
) -> None:
    app, client = admin_app
    app.state.container.account_store.database_path = (
        app.state.container.account_store.database_path.parent / "gone" / "db.sqlite3"
    )

    response = client.get("/admin/dashboard")

    assert response.status_code == 200
    assert "Storage: unavailable" in response.text
    assert "Connected accounts: unknown" in response.text


def test_accounts_lists_no_connected_accounts(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.get("/admin/accounts")

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

    response = client.get("/admin/accounts")

    assert response.status_code == 200
    body = response.text
    assert "tiktok" in body
    assert "tiktok-user" in body
    assert "tiktok-1" in body
    assert "video.list, user.info" in body
    assert account.created_at.isoformat() in body
    assert account.updated_at.isoformat() in body
    assert b"fake-access-token-bytes" not in response.text.encode("utf-8")


def test_accounts_page_has_disabled_connect_threads_placeholder(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.get("/admin/accounts")

    assert response.status_code == 200
    assert "Connect Threads (coming soon)" in response.text
    assert '<button type="button" disabled>' in response.text
    assert "/admin/connect" not in response.text
    assert 'action="' not in response.text
    assert "oauth/authorize" not in response.text


def test_accounts_never_exposes_encrypted_token_bytes(
    admin_app,
) -> None:
    app, client = admin_app
    account = _make_account()
    stored = _save_account(app, account)

    body = client.get("/admin/accounts").text

    assert stored.access_token_encrypted.hex() not in body
    assert stored.access_token_encrypted.decode("latin-1", errors="ignore") not in body


def test_token_status_classifies_valid_tokens(
    admin_app,
) -> None:
    app, client = admin_app
    future = datetime.now(UTC).replace(year=datetime.now(UTC).year + 1)
    _save_account(app, _make_account(expires_at=future))

    body = client.get("/admin/accounts").text

    assert "valid" in body
    assert "expired" not in body


def test_token_status_classifies_expired_tokens(
    admin_app,
) -> None:
    app, client = admin_app
    past = datetime.now(UTC).replace(year=datetime.now(UTC).year - 1)
    _save_account(app, _make_account(expires_at=past))

    body = client.get("/admin/accounts").text

    assert "expired" in body
    assert "valid" not in body


def test_token_status_handles_tokens_without_expiry(
    admin_app,
) -> None:
    app, client = admin_app
    _save_account(app, _make_account(expires_at=None))

    body = client.get("/admin/accounts").text

    assert "no expiry" in body
    assert "expired" not in body


def test_dashboard_and_accounts_show_admin_navigation(
    admin_app,
) -> None:
    _, client = admin_app

    for path in ("/admin/dashboard", "/admin/accounts"):
        body = client.get(path).text
        assert "/admin/dashboard" in body
        assert "/admin/accounts" in body


def test_admin_routes_are_not_cacheable(
    admin_app,
) -> None:
    _, client = admin_app

    for path in ("/admin/dashboard", "/admin/accounts"):
        response = client.get(path)
        assert response.headers["cache-control"] == "no-store"


def test_dashboard_reflects_storage_failure_after_startup(
    admin_app,
) -> None:
    app, client = admin_app
    _save_account(app, _make_account())
    app.state.container.account_store.database_path.unlink()

    response = client.get("/admin/dashboard")

    assert response.status_code == 200
    assert "Storage: unavailable" in response.text


def test_accounts_handles_storage_failure_gracefully(
    admin_app,
) -> None:
    app, client = admin_app
    app.state.container.account_store.database_path.unlink()

    response = client.get("/admin/accounts")

    assert response.status_code == 200
    assert "No connected accounts." in response.text


# --- session secret configuration --------------------------------------------


def test_session_secret_is_never_committed_to_env_example() -> None:
    """The .env.example must not carry a real session secret value."""

    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    text = (root / ".env.example").read_text()
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.startswith("ADMIN_SESSION_SECRET") and "=" in stripped:
            value = stripped.split("=", 1)[1]
            assert value == "", f"ADMIN_SESSION_SECRET must be empty in .env.example: {line!r}"


# --- tamper resistance and file-based secret -------------------------------

def test_a_tampered_session_cookie_does_not_grant_access(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """A cookie signed with a different secret must not authenticate."""

    app = create_app(
        make_settings(
            tmp_path, admin_username="admin", admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )

    with TestClient(app) as client:
        # Establish a legit session, then replace the cookie with one signed
        # using a different secret. The signature must not verify, so the
        # session is treated as empty and the protected GET redirects to login.
        client.post("/admin/login", auth=ADMIN_AUTH)
        client.cookies.clear()
        client.cookies.set(
            "session",
            _signed_cookie("wrong-secret", {str(_SESSION_KEY_FIELD): True}),
        )

        response = client.get("/admin/dashboard", follow_redirects=False)

    # A cookie signed with the wrong secret fails verification: the session
    # is treated as empty, so the protected GET redirects to login.
    assert response.status_code == 303
    assert response.headers["location"] == "/admin/login"


def test_session_secret_can_be_provided_via_file(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """ADMIN_SESSION_SECRET_FILE yields a working, signed session cookie."""

    secret_file = tmp_path / "admin_session_secret"
    secret_file.write_text("file-based-session-secret", encoding="utf-8")

    app = create_app(
        make_settings(
            tmp_path, admin_username="admin", admin_password="example-secret",
            admin_session_secret=None, admin_session_secret_file=secret_file,
        )
    )

    with TestClient(app) as client:
        login = client.post("/admin/login", auth=ADMIN_AUTH)
        dashboard = client.get("/admin/dashboard")

    assert login.status_code == 200
    assert dashboard.status_code == 200
    assert "Service: ok" in dashboard.text


def test_session_cookie_carries_a_csrf_token_after_login(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    app = create_app(make_settings(tmp_path, admin_username="admin",
                                    admin_password="example-secret",
                                    admin_session_secret=ADMIN_SESSION_SECRET))

    with TestClient(app) as client:
        response = client.post("/admin/login", auth=ADMIN_AUTH)

    assert response.status_code == 200
    # The CSRF token is embedded in the login success page as a hidden input.
    match = re.search(r"value='([^']+)'", response.text)
    assert match is not None
    token = match.group(1)
    assert len(token) >= 16
