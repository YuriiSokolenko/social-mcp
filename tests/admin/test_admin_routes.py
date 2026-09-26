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

# --- Threads OAuth connect-flow test fixtures and helpers (issue #16) -------

SAMPLE_TOKEN_RESPONSE: dict = {
    "access_token": "fake-threads-access-token-not-a-credential",
    "token_type": "bearer",
    "user_id": 123456789,
}


def _csrf(client: TestClient) -> str:
    """Return a fresh CSRF token by re-logging in."""

    response = client.post("/admin/login", auth=ADMIN_AUTH)
    match = re.search(r"value='([^']+)'", response.text)
    assert match is not None, "login response did not expose a CSRF token"
    return match.group(1)


def _create_state(app, csrf_token: str) -> str:
    """Create an OAuth state value via the app's OAuthStateManager."""

    oauth_manager = app.state.container.require_oauth_state_manager()
    return oauth_manager.create(csrf_token, platform="threads")


class _FakeThreadsTransport:
    """Fake transport that records calls and returns a configurable response."""

    def __init__(self, response: dict[str, object] | None = None) -> None:
        self._response: dict[str, object] = response or {}
        self.calls: list[tuple[str, dict[str, str]]] = []

    @property
    def response(self) -> dict[str, object]:
        return self._response

    @response.setter
    def response(self, value: dict[str, object]) -> None:
        self._response = value

    async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
        self.calls.append((url, dict(data)))
        return self._response


@pytest.fixture()
def configured_admin_app(tmp_path: Path, make_settings: Callable[..., Settings]):
    """An authenticated admin app with Threads/Meta fully configured."""

    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
            meta_app_id="test-app-id",
            meta_app_secret="test-app-secret",
            oauth_state_secret="test-oauth-state-secret-not-for-production",
        )
    )
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        yield app, client


@pytest.fixture()
def mock_threads_transport(monkeypatch):
    """Replace HttpxThreadsTransport with a fake; returns the fake instance."""

    fake = _FakeThreadsTransport(SAMPLE_TOKEN_RESPONSE)

    class _FakeClass:
        def __init__(self, *args, **kwargs):
            pass

        async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
            return await fake.post(url, data)

    monkeypatch.setattr(
        "social_mcp.admin.routes.HttpxThreadsTransport", _FakeClass
    )
    return fake

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


def test_accounts_page_shows_connect_button_when_configured(
    configured_admin_app,
) -> None:
    _, client = configured_admin_app

    response = client.get("/admin/accounts")

    assert response.status_code == 200
    assert "Connect Threads (coming soon)" not in response.text
    # The button is a real form that posts to the connect route.
    assert '<form' in response.text
    assert 'action="/admin/connect/threads"' in response.text
    assert '<button type="submit">Connect Threads</button>' in response.text
    # A CSRF token is embedded as a hidden field.
    assert 'name="csrf_token"' in response.text
    assert "oauth/authorize" not in response.text


def test_accounts_page_shows_config_notice_when_not_configured(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.get("/admin/accounts")

    assert response.status_code == 200
    assert "Connect Threads (coming soon)" not in response.text
    assert "Configure META_APP_ID" in response.text
    assert 'action="/admin/connect/threads"' not in response.text


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


# --- Threads OAuth connect flow (issue #16) --------------------------------


def test_connect_threads_starts_oauth_flow(
    configured_admin_app,
) -> None:
    _, client = configured_admin_app
    csrf_token = _csrf(client)

    response = client.post(
        "/admin/connect/threads",
        data={"csrf_token": csrf_token},
        follow_redirects=False,
    )

    assert response.status_code == 303
    location = response.headers["location"]
    assert "threads.com/oauth/authorize" in location
    assert "client_id=test-app-id" in location
    assert "response_type=code" in location
    assert "redirect_uri=" in location
    # The auth URL carries the scope and a signed state, but never a token.
    assert "scope=" in location
    assert "state=" in location
    assert "access_token" not in location
    assert "client_secret" not in location


def test_connect_threads_requires_csrf(configured_admin_app) -> None:
    _, client = configured_admin_app

    response = client.post("/admin/connect/threads")

    assert response.status_code == 403
    assert "access_token" not in response.text


def test_connect_threads_rejects_invalid_csrf(configured_admin_app) -> None:
    _, client = configured_admin_app

    response = client.post(
        "/admin/connect/threads",
        data={"csrf_token": "wrong-token"},
    )

    assert response.status_code == 403


def test_connect_threads_not_configured_returns_503(admin_app) -> None:
    _, client = admin_app
    csrf_token = _csrf(client)

    response = client.post(
        "/admin/connect/threads",
        data={"csrf_token": csrf_token},
    )

    # When the adapter is not configured (no Meta credentials / secrets), the
    # connect route reports a safe 503 rather than starting a half-flow.
    assert response.status_code == 503


def test_connect_threads_auth_url_contains_required_scopes(
    configured_admin_app,
) -> None:
    _, client = configured_admin_app
    csrf_token = _csrf(client)

    response = client.post(
        "/admin/connect/threads",
        data={"csrf_token": csrf_token},
        follow_redirects=False,
    )

    location = response.headers["location"]
    # threads_basic is always required.
    assert "threads_basic" in location


def test_connect_threads_state_is_session_bound(
    configured_admin_app,
) -> None:
    app, client = configured_admin_app
    csrf_token = _csrf(client)

    response = client.post(
        "/admin/connect/threads",
        data={"csrf_token": csrf_token},
        follow_redirects=False,
    )
    location = response.headers["location"]

    # The state value in the redirect URL is signed and bound to the session.
    state_match = re.search(r"state=([^&]+)", location)
    assert state_match is not None
    state_value = state_match.group(1)

    # A state minted for a different session_id must not validate against this
    # session (the OAuthStateManager enforces session binding).
    other_state = app.state.container.require_oauth_state_manager().create(
        "different-session-id", platform="threads"
    )
    consumed_different = False
    consumed_same = False
    try:
        app.state.container.require_oauth_state_manager().consume(
            state_value, session_id=csrf_token
        )
        consumed_same = True
    except Exception:  # noqa: BLE001
        consumed_same = False
    try:
        app.state.container.require_oauth_state_manager().consume(
            other_state, session_id=csrf_token
        )
        consumed_different = True
    except Exception:  # noqa: BLE001
        consumed_different = False
    assert consumed_same, "state bound to the current session should be consumable"
    assert not consumed_different, "state bound to a different session should be rejected"


def test_connect_threads_redirect_uri_matches_callback(
    configured_admin_app,
) -> None:
    _, client = configured_admin_app
    csrf_token = _csrf(client)

    response = client.post(
        "/admin/connect/threads",
        data={"csrf_token": csrf_token},
        follow_redirects=False,
    )
    location = response.headers["location"]

    # The redirect_uri in the auth URL must point at the callback route.
    # The value is URL-encoded in the query string, so decode it.
    from urllib.parse import parse_qs, urlsplit

    params = parse_qs(urlsplit(location).query)
    redirect_uri = params["redirect_uri"][0]
    assert "/admin/oauth/callback/threads" in redirect_uri


def test_callback_exchanges_code_and_persists_account(
    configured_admin_app,
    monkeypatch,
    mock_threads_transport,
) -> None:
    app, client = configured_admin_app
    csrf_token = _csrf(client)
    state = _create_state(app, csrf_token)

    response = client.get(
        f"/admin/oauth/callback/threads?code=fake-auth-code&state={state}",
        follow_redirects=False,
    )

    assert response.status_code == 200
    assert "connected successfully" in response.text
    # The access token is never shown in the UI.
    assert "fake-threads-access-token" not in response.text

    # The transport was called to exchange the code.
    assert len(mock_threads_transport.calls) == 1
    url, form = mock_threads_transport.calls[0]
    assert url == "https://graph.threads.com/oauth/access_token"
    assert form["grant_type"] == "authorization_code"
    assert form["code"] == "fake-auth-code"
    assert form["client_id"] == "test-app-id"
    assert form["client_secret"] == "test-app-secret"
    assert "/admin/oauth/callback/threads" in form["redirect_uri"]

    # The account was persisted with encrypted (not plaintext) tokens.
    accounts = app.state.container.account_store.list_accounts()
    assert len(accounts) == 1
    assert accounts[0].external_account_id == "123456789"
    assert accounts[0].platform is SocialPlatform.THREADS
    assert accounts[0].scopes == ["threads_basic"]
    assert accounts[0].token_expires_at is not None
    encrypted = accounts[0].access_token_encrypted
    assert encrypted != b"fake-threads-access-token"
    assert b"fake-threads-access-token" not in encrypted
    raw_db = app.state.container.account_store.database_path.read_bytes()
    assert b"fake-threads-access-token" not in raw_db


def test_callback_strips_trailing_fragment_from_code(
    configured_admin_app,
    monkeypatch,
    mock_threads_transport,
) -> None:
    app, client = configured_admin_app
    csrf_token = _csrf(client)
    state = _create_state(app, csrf_token)

    # Meta appends ``#_`` to the redirect URI. In a browser the ``#`` starts a
    # fragment and is never sent to the server, so the code arrives clean.
    # If a code value somehow carries a ``#_`` suffix (e.g. via a proxy that
    # does not strip fragments), the callback strips it defensively.
    response = client.get(
        f"/admin/oauth/callback/threads?code=fake-code%23_&state={state}",
        follow_redirects=False,
    )

    assert response.status_code == 200
    assert len(mock_threads_transport.calls) == 1
    _, form = mock_threads_transport.calls[0]
    assert form["code"] == "fake-code"


def test_callback_handles_canceled_authorization(
    configured_admin_app,
    mock_threads_transport,
) -> None:
    _, client = configured_admin_app

    response = client.get(
        "/admin/oauth/callback/threads?error=access_denied"
        "&error_reason=user_denied",
        follow_redirects=False,
    )

    assert response.status_code == 200
    assert "cancelled" in response.text.lower()
    assert len(mock_threads_transport.calls) == 0
    assert "access_token" not in response.text


def test_callback_rejects_invalid_state(
    configured_admin_app,
    mock_threads_transport,
) -> None:
    _, client = configured_admin_app

    response = client.get(
        "/admin/oauth/callback/threads?code=fake-code&state=invalid-state",
        follow_redirects=False,
    )

    assert response.status_code == 200
    assert "error" in response.text.lower() or "not" in response.text.lower()
    assert len(mock_threads_transport.calls) == 0
    assert "access_token" not in response.text


def test_callback_requires_code_and_state(
    configured_admin_app,
    mock_threads_transport,
) -> None:
    _, client = configured_admin_app

    # Missing both code and state.
    response = client.get(
        "/admin/oauth/callback/threads",
        follow_redirects=False,
    )
    assert response.status_code == 200
    assert "error" in response.text.lower() or "not" in response.text.lower()
    assert len(mock_threads_transport.calls) == 0


def test_callback_handles_error_from_meta(
    configured_admin_app,
    monkeypatch,
) -> None:
    _, client = configured_admin_app
    csrf_token = _csrf(client)
    state = _create_state(app=configured_admin_app[0], csrf_token=csrf_token)

    error_response = {
        "error_type": "OAuthException",
        "code": 400,
        "error_message": "Matching code was not found or was already used",
    }
    fake = _FakeThreadsTransport(error_response)

    class _FakeClass:
        def __init__(self, *args, **kwargs):
            pass

        async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
            return await fake.post(url, data)

    monkeypatch.setattr(
        "social_mcp.admin.routes.HttpxThreadsTransport", _FakeClass
    )

    response = client.get(
        f"/admin/oauth/callback/threads?code=fake-code&state={state}",
        follow_redirects=False,
    )

    assert response.status_code == 200
    assert "error" in response.text.lower() or "failed" in response.text.lower()
    assert len(fake.calls) == 1
    # The error message is shown safely without revealing secrets.
    assert "client_secret" not in response.text
    assert "test-app-secret" not in response.text


def test_callback_handles_http_error_from_transport(
    configured_admin_app,
    monkeypatch,
) -> None:
    _, client = configured_admin_app
    csrf_token = _csrf(client)
    state = _create_state(app=configured_admin_app[0], csrf_token=csrf_token)

    class _ErrorTransport:
        def __init__(self, *args, **kwargs):
            pass

        async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
            from social_mcp.platforms.threads import ThreadsOAuthError

            raise ThreadsOAuthError("Threads token endpoint returned HTTP 500.")

    monkeypatch.setattr(
        "social_mcp.admin.routes.HttpxThreadsTransport", _ErrorTransport
    )

    response = client.get(
        f"/admin/oauth/callback/threads?code=fake-code&state={state}",
        follow_redirects=False,
    )

    assert response.status_code == 200
    assert "error" in response.text.lower() or "failed" in response.text.lower()
    assert "500" not in response.text or "HTTP 500" in response.text
    # No credentials are leaked.
    assert "test-app-secret" not in response.text


def test_callback_persists_scopes_and_expiry(
    configured_admin_app,
    monkeypatch,
    mock_threads_transport,
) -> None:
    app, client = configured_admin_app
    csrf_token = _csrf(client)
    state = _create_state(app, csrf_token)

    response = client.get(
        f"/admin/oauth/callback/threads?code=fake-code&state={state}",
        follow_redirects=False,
    )

    assert response.status_code == 200
    accounts = app.state.container.account_store.list_accounts()
    assert len(accounts) == 1
    stored = accounts[0]
    # Granted scopes are stored (threads_basic is always requested by default).
    assert "threads_basic" in stored.scopes
    # Expiry metadata is stored.
    assert stored.token_expires_at is not None


def test_reconnect_replaces_existing_connection(
    configured_admin_app,
    monkeypatch,
    mock_threads_transport,
) -> None:
    app, client = configured_admin_app

    # First connection.
    csrf_token = _csrf(client)
    state = _create_state(app, csrf_token)
    response = client.get(
        f"/admin/oauth/callback/threads?code=fake-code&state={state}",
        follow_redirects=False,
    )
    assert response.status_code == 200
    accounts = app.state.container.account_store.list_accounts()
    assert len(accounts) == 1
    first = accounts[0]

    # Reconnect: a second callback with a new state for the same account.
    csrf_token2 = _csrf(client)
    state2 = _create_state(app, csrf_token2)
    response2 = client.get(
        f"/admin/oauth/callback/threads?code=fake-code-2&state={state2}",
        follow_redirects=False,
    )
    assert response2.status_code == 200
    accounts = app.state.container.account_store.list_accounts()
    # Still one account (the same user_id), so no duplicate.
    assert len(accounts) == 1
    # The connection was updated, not duplicated.
    assert accounts[0].updated_at >= first.updated_at


def test_reconnect_with_new_token_replaces_encrypted_value(
    configured_admin_app,
    monkeypatch,
) -> None:
    app, client = configured_admin_app

    # First connection with one token.
    first_response = dict(SAMPLE_TOKEN_RESPONSE)
    first_fake = _FakeThreadsTransport(first_response)

    # Second connection with a different token.
    second_response = {
        "access_token": "different-fake-token-not-a-credential",
        "token_type": "bearer",
        "user_id": 123456789,
    }
    second_fake = _FakeThreadsTransport(second_response)
    fakes = [first_fake, second_fake]

    class _SequenceClass:
        calls: list[int] = [0]  # noqa: RUF012

        def __init__(self, *args, **kwargs):
            pass

        async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
            fake = fakes[self.calls[0]]
            self.calls[0] += 1
            return await fake.post(url, data)

    monkeypatch.setattr(
        "social_mcp.admin.routes.HttpxThreadsTransport", _SequenceClass
    )

    csrf_token = _csrf(client)
    state = _create_state(app, csrf_token)
    client.get(
        f"/admin/oauth/callback/threads?code=code1&state={state}",
        follow_redirects=False,
    )
    first_accounts = app.state.container.account_store.list_accounts()
    first_token = first_accounts[0].access_token_encrypted
    assert b"different-fake-token" not in first_token

    csrf_token2 = _csrf(client)
    state2 = _create_state(app, csrf_token2)
    client.get(
        f"/admin/oauth/callback/threads?code=code2&state={state2}",
        follow_redirects=False,
    )
    second_accounts = app.state.container.account_store.list_accounts()
    assert len(second_accounts) == 1
    second_token = second_accounts[0].access_token_encrypted
    # The encrypted token was replaced, not appended.
    assert second_token != first_token
    assert b"different-fake-token" not in second_token
    # Neither plaintext token is in the database file.
    raw_db = app.state.container.account_store.database_path.read_bytes()
    assert b"fake-threads-access-token" not in raw_db
    assert b"different-fake-token" not in raw_db


def test_callback_no_manual_token_copy_paste(
    configured_admin_app,
    mock_threads_transport,
) -> None:
    app, client = configured_admin_app
    csrf_token = _csrf(client)
    state = _create_state(app, csrf_token)

    response = client.get(
        f"/admin/oauth/callback/threads?code=fake-code&state={state}",
        follow_redirects=False,
    )

    assert response.status_code == 200
    # The entire flow (code exchange, token persistence) happens server-side
    # without the user seeing or copying any token value.
    body = response.text
    assert "fake-threads-access-token" not in body
    assert "test-app-secret" not in body
    assert "test-app-id" not in body
    # The success page doesn't contain a token input field.
    assert "<input" not in body or "token" not in body.lower()


def test_connect_flow_state_is_one_shot(
    configured_admin_app,
    monkeypatch,
    mock_threads_transport,
) -> None:
    app, client = configured_admin_app
    csrf_token = _csrf(client)
    state = _create_state(app, csrf_token)

    # First callback succeeds.
    first = client.get(
        f"/admin/oauth/callback/threads?code=fake-code&state={state}",
        follow_redirects=False,
    )
    assert first.status_code == 200
    assert "successfully" in first.text

    # Reusing the same state must be rejected (one-shot CSRF protection).
    second = client.get(
        f"/admin/oauth/callback/threads?code=fake-code&state={state}",
        follow_redirects=False,
    )
    assert second.status_code == 200
    assert "already been used" in second.text or "error" in second.text.lower()
    # The transport is not called for the replay.
    assert len(mock_threads_transport.calls) == 1


def test_connect_flow_shows_account_in_accounts_page(
    configured_admin_app,
    monkeypatch,
    mock_threads_transport,
) -> None:
    app, client = configured_admin_app
    csrf_token = _csrf(client)
    state = _create_state(app, csrf_token)

    client.get(
        f"/admin/oauth/callback/threads?code=fake-code&state={state}",
        follow_redirects=False,
    )

    # The accounts page now shows the connected Threads account.
    response = client.get("/admin/accounts")
    assert response.status_code == 200
    assert "threads" in response.text
    assert "123456789" in response.text
    # No token material on the page.
    assert "fake-threads-access-token" not in response.text


def test_callback_not_configured_shows_error(
    admin_app,
) -> None:
    _, client = admin_app

    response = client.get(
        "/admin/oauth/callback/threads?code=fake-code&state=fake-state",
        follow_redirects=False,
    )

    assert response.status_code == 200
    assert "not configured" in response.text.lower() or "error" in response.text.lower()


def test_dashboard_shows_token_encryption_status(configured_admin_app) -> None:
    _, client = configured_admin_app

    response = client.get("/admin/dashboard")

    assert response.status_code == 200
    assert "Token encryption: configured" in response.text


def test_callback_callback_path_matches_docs(configured_admin_app) -> None:
    _, client = configured_admin_app
    csrf_token = _csrf(client)
    state = _create_state(configured_admin_app[0], csrf_token)

    response = client.get(
        f"/admin/oauth/callback/threads?code=fake-code&state={state}",
        follow_redirects=False,
    )

    # The callback route is at /admin/oauth/callback/threads (matches docs/oauth.md).
    assert response.status_code == 200
