"""Authenticated Web Admin: dashboard and accounts UI behind session auth.

Authentication model
--------------------

The Web Admin uses HTTP Basic credentials to authenticate a login, but access
to every ``/admin`` route is gated on a signed session cookie rather than on
per-request credentials. This gives secure cookie/session behaviour:

* the session cookie is ``HttpOnly`` (no JavaScript access) and ``SameSite=Lax``,
  so a third-party site cannot ride the session;
* in production (``environment != "development"``) the cookie is also ``Secure``
  so it is only ever transmitted over HTTPS;
* the cookie is signed with ``ADMIN_SESSION_SECRET``, which is resolved from
  environment configuration and never committed.

A deployment that has no ``ADMIN_SESSION_SECRET`` (or no username/password)
cannot issue a session at all: every login attempt and every ``/admin``
request is rejected with ``503 Service Unavailable``. This prevents an
accidentally unprotected admin.

``/health`` lives outside the admin router and stays anonymous, so it remains
suitable for container health checks.
"""

import html
import sqlite3
from collections.abc import Sequence
from datetime import UTC, datetime
from hmac import compare_digest
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import SecretStr

from social_mcp.container import ApplicationContainer
from social_mcp.storage.models import ConnectedAccount

basic_auth = HTTPBasic(auto_error=False)

# Keys used inside the signed session store (Starlette SessionMiddleware).
_SESSION_KEY = "admin_session"
_CSRF_KEY = "admin_csrf"
# A session that has not been touched within this many seconds is treated as
# expired. Kept small to limit the window of a stolen cookie.
_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60


def get_admin_container(request: Request) -> ApplicationContainer:
    """Resolve the application container for an admin request."""

    container: ApplicationContainer | None = getattr(request.app.state, "container", None)
    if container is None:
        raise HTTPException(status_code=503, detail="Admin service is unavailable")
    return container


def _admin_credentials(container: ApplicationContainer) -> tuple[str, str] | None:
    """Return configured credentials or ``None`` when admin is not configured."""

    username = container.settings.admin_username
    password = container.settings.admin_password
    if not username or password is None:
        return None
    password_value = password.get_secret_value()
    if not password_value:
        return None
    return username, password_value


def _admin_session_secret(container: ApplicationContainer) -> SecretStr | None:
    """Return the configured session-signing secret or ``None``."""

    secret = container.settings.admin_session_secret
    if secret is None or not secret.get_secret_value():
        return None
    return secret


def _is_configured(container: ApplicationContainer) -> bool:
    """Whether the admin UI is fully configured to issue sessions.

    Admin is "configured" only when both credentials and a session secret are
    present. Every admin path fails to ``503`` when this is false, so the admin
    surface can never be reached anonymously.
    """

    if _admin_credentials(container) is None:
        return False
    return _admin_session_secret(container) is not None


def _generate_csrf_token() -> str:
    """Random CSRF token for a freshly authenticated session."""

    from secrets import token_urlsafe

    return token_urlsafe(32)


def _current_csrf(request: Request) -> str:
    """Return the CSRF token bound to the current session."""

    token = request.session.get(_CSRF_KEY)
    if not isinstance(token, str):
        # A session without a CSRF token is treated as unauthenticated.
        raise HTTPException(status_code=403, detail="No active session")
    return token


def _check_csrf(request: Request, token: str | None) -> None:
    """Constant-time check of the submitted CSRF token against the session token."""

    expected = _current_csrf(request)
    ok = token is not None and compare_digest(token, expected)
    if not ok:
        raise HTTPException(status_code=403, detail="Invalid CSRF token")


# Two routers are mounted in ``app.py``:
#   * ``public_router``  — login/logout, reachable without a session.
#   * ``admin_router``   — dashboard/accounts, guarded by ``admin_only``.
admin_router = APIRouter(prefix="/admin", tags=["admin"])
public_router = APIRouter(prefix="/admin", tags=["admin"])


@public_router.get("/login", response_class=HTMLResponse)
def login_page() -> HTMLResponse:
    """Render the login form (pre-authentication)."""

    body = (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>Social MCP \u2014 Admin login</title></head>"
        "<body><h1>Social MCP Admin</h1>"
        '<form method="post" action="/admin/login">'
        '<label>Username <input type="text" name="username" autocomplete="username" /></label> '
        '<label>Password <input type="password" name="password" '
        'autocomplete="current-password" /></label> '
        '<button type="submit">Log in</button></form>'
        "</body></html>"
    )
    return HTMLResponse(body, headers={"Cache-Control": "no-store"})


@public_router.post("/login")
def login(
    request: Request,
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
    credentials: Annotated[HTTPBasicCredentials | None, Depends(basic_auth)] = None,
    username: str | None = Form(None),
    password: str | None = Form(None),
) -> HTMLResponse:
    """Authenticate the user and start a signed session cookie.

    Credentials may be supplied either as HTTP Basic (for API clients such as
    curl) or as form fields (for browser logins). They are compared in constant
    time to avoid username enumeration via timing. On success a signed session
    cookie carrying a fresh CSRF token is issued; the password is never
    persisted or logged.
    """

    if not _is_configured(container):
        raise HTTPException(status_code=503, detail="Admin authentication is not configured")

    if credentials is not None:
        submitted_username = credentials.username
        submitted_password = credentials.password
    elif username is not None and password is not None:
        submitted_username = username
        submitted_password = password
    else:
        raise HTTPException(
            status_code=401,
            detail="Invalid admin credentials",
            headers={"WWW-Authenticate": 'Basic realm="Social MCP Admin"'},
        )

    expected_username, expected_password = _admin_credentials(container)
    valid_username = compare_digest(submitted_username.encode("utf-8"), expected_username.encode("utf-8"))
    valid_password = compare_digest(submitted_password.encode("utf-8"), expected_password.encode("utf-8"))
    if not (valid_username and valid_password):
        raise HTTPException(
            status_code=401,
            detail="Invalid admin credentials",
            headers={"WWW-Authenticate": 'Basic realm="Social MCP Admin"'},
        )

    request.session[_SESSION_KEY] = True
    request.session[_CSRF_KEY] = _generate_csrf_token()
    csrf_token = request.session[_CSRF_KEY]
    body = (
        "<!doctype html><html><head><meta charset='utf-8'></head>"
        "<body><p>Logged in.</p>"
        f"<a href='/admin/dashboard'>Continue to the dashboard</a>."
        f"<input type='hidden' value='{html.escape(csrf_token)}' />"
        "</body></html>"
    )
    return HTMLResponse(body, headers={"Cache-Control": "no-store"})


@public_router.post("/logout")
@public_router.get("/logout")
def logout(request: Request) -> RedirectResponse:
    """Clear the session and return to the login page."""

    request.session.clear()
    return RedirectResponse(url="/admin/login", status_code=303)


def admin_only(
    request: Request,
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
) -> None:
    """Dependency that blocks admin routes unless a valid session exists.

    Unauthenticated browser navigation (``GET``/``HEAD``) is redirected to the
    login page; all other methods receive ``401`` so non-browser clients can
    detect the missing session. State-changing methods (``POST``/``PUT``/
    ``PATCH``/``DELETE``) must also present a CSRF token in the
    ``x-csrf-token`` header matching the session.
    """

    if not _is_configured(container):
        raise HTTPException(status_code=503, detail="Admin authentication is not configured")
    if request.session.get(_SESSION_KEY) is not True:
        # Unauthenticated browser navigation (GET/HEAD) is redirected to the
        # login page; other methods receive 401 so non-browser clients detect
        # the missing session rather than being silently redirected.
        if request.method in {"GET", "HEAD"}:
            raise HTTPException(status_code=303, headers={"location": "/admin/login"})
        raise HTTPException(status_code=401, detail="Authentication required")
    if request.method in {"POST", "PUT", "PATCH", "DELETE", "PURGE"}:
        _check_csrf(request, request.headers.get("x-csrf-token"))


# Protected routes — every one is guarded by the ``admin_only`` dependency.
@admin_router.get("/", response_class=HTMLResponse, dependencies=[Depends(admin_only)])
@admin_router.get("/dashboard", response_class=HTMLResponse, dependencies=[Depends(admin_only)])
def dashboard(
    request: Request,
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
) -> HTMLResponse:
    """Render the Web Admin dashboard with service and storage status."""

    storage = _storage_ok(container)
    tokens_configured = container.token_cipher_or_none() is not None

    try:
        account_count: int | str = len(container.account_store.list_accounts())
    except sqlite3.Error:
        account_count = "unknown"

    main = (
        "<section><h2>Service status</h2><ul>"
        "<li>Service: ok</li>"
        f"<li>Storage: {html.escape(storage)}</li>"
        + (
            "<li>Token encryption: configured</li>"
            if tokens_configured
            else "<li>Token encryption: disabled</li>"
        )
        + f"<li>Connected accounts: {html.escape(str(account_count))}</li>"
        + "</ul></section>"
    )
    return _page("Dashboard", main)


@admin_router.get("/accounts", response_class=HTMLResponse, dependencies=[Depends(admin_only)])
def accounts(request: Request) -> HTMLResponse:
    """Render the connected accounts listing without exposing token values."""

    container = get_admin_container(request)
    try:
        stored_accounts = container.account_store.list_accounts()
    except sqlite3.Error:
        stored_accounts = []

    main = (
        "<section><h2>Connected accounts</h2>"
        '<button type="button" disabled>Connect Threads (coming soon)</button>'
        + _render_accounts(stored_accounts)
        + "</section>"
    )
    return _page("Accounts", main)


@admin_router.post("/accounts/disconnect", response_class=HTMLResponse, dependencies=[Depends(admin_only)])
def disconnect_account(request: Request) -> HTMLResponse:
    """Placeholder for account disconnection (gated by CSRF via ``admin_only``)."""

    body = (
        "<section><h2>Disconnect account</h2>"
        "<p>Account disconnection is not yet implemented.</p></section>"
    )
    return _page("Disconnect", body)


_NAV = "<nav><a href='/admin/dashboard'>Dashboard</a> " "<a href='/admin/accounts'>Accounts</a> " "<a href='/admin/logout'>Log out</a></nav>"


def _page(title: str, main: str) -> HTMLResponse:
    """Wrap page content in a minimal HTML document with admin navigation."""

    body = (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>Social MCP \u2014 {html.escape(title)}</title></head>"
        f"<body><h1>{html.escape(title)}</h1>{_NAV}<main>{main}</main></body></html>"
    )
    return HTMLResponse(body, headers={"Cache-Control": "no-store"})


def _storage_ok(container: ApplicationContainer) -> str:
    """Return ``ok`` or ``unavailable`` based on whether the store is reachable."""

    try:
        container.check()
    except (sqlite3.Error, OSError):
        return "unavailable"
    return "ok"


def _token_status(account: ConnectedAccount) -> str:
    """Classify an account's token without ever decrypting it."""

    expires_at = account.token_expires_at
    if expires_at is None:
        return "no expiry"
    return "expired" if expires_at <= datetime.now(UTC) else "valid"


def _render_accounts(accounts: Sequence[ConnectedAccount]) -> str:
    """Render the connected accounts table, never exposing token values.

    The token columns show only the status (valid/expired/no expiry); the
    encrypted token bytes themselves are never rendered.
    """

    if not accounts:
        return "<p>No connected accounts.</p>"

    rows = [
        "<tr>" + "".join(
            f"<td>{html.escape(cell)}</td>"
            for cell in (
                account.platform.value,
                account.username or "",
                account.external_account_id,
                ", ".join(account.scopes),
                _token_status(account),
                account.created_at.isoformat(),
                account.updated_at.isoformat(),
            )
        ) + "</tr>"
        for account in accounts
    ]

    return (
        "<table>"
        "<thead><tr>"
        "<th>Platform</th><th>Username</th><th>Account ID</th>"
        "<th>Scopes</th><th>Token</th><th>Connected</th><th>Updated</th>"
        "</tr></thead>"
        f"<tbody>{''.join(rows)}</tbody>"
        "</table>"
    )
