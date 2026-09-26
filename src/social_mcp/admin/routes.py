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
from secrets import token_urlsafe
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import SecretStr

from social_mcp.admin.oauth import (
    SESSION_ID_KEY,
    _tiktok_client_configured,
    build_tiktok_connect_service,
    get_tiktok_adapter,
    redirect_to_accounts,
)
from social_mcp.auth.oauth_state import OAuthStateError
from social_mcp.container import (
    ApplicationContainer,
    OAuthStateUnavailableError,
    TokenCipherUnavailableError,
)
from social_mcp.diagnostics import DiagnosticLevel, current_request_id
from social_mcp.platforms.tiktok import (
    TikTokLoginKitAdapter,
    resolve_tiktok_capabilities,
)
from social_mcp.platforms.tiktok.oauth import TikTokOAuthError
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

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

    return token_urlsafe(32)


def _generate_session_id() -> str:
    """Random, unguessable identifier for an admin session.

    Stored in the signed session cookie and used to bind OAuth ``state`` values
    to the session that started the flow. It is never a credential and is
    never logged in full; only its presence matters for state binding.
    """

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
    request.session[SESSION_ID_KEY] = _generate_session_id()
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


async def admin_only(
    request: Request,
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
) -> None:
    """Dependency that blocks admin routes unless a valid session exists.

    Unauthenticated browser navigation (``GET``/``HEAD``) is redirected to the
    login page; all other methods receive ``401`` so non-browser clients can
    detect the missing session. State-changing methods (``POST``/``PUT``/
    ``PATCH``/``DELETE``) must also present a CSRF token matching the session,
    sent either in the ``x-csrf-token`` header (API/CLI clients) or as a
    ``csrf_token`` form field (browser forms, so no JavaScript is required).
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
        token = request.headers.get("x-csrf-token")
        if not token:
            # Fall back to a form field so browser-based admin forms (which
            # cannot set custom headers) still submit a CSRF token.
            form = await request.form()
            token = form.get("csrf_token")
        _check_csrf(request, token)


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

    tiktok_account = next(
        (a for a in stored_accounts if a.platform is SocialPlatform.TIKTOK), None
    )
    csrf_token = request.session.get(_CSRF_KEY, "")
    status = request.query_params.get("tiktok")

    main = (
        "<section><h2>Connected accounts</h2>"
        + _render_tiktok_connect(tiktok_account, csrf_token, _tiktok_client_configured(container))
        + '<button type="button" disabled>Connect Threads (coming soon)</button>'
        + _render_status(status)
        + _render_accounts(stored_accounts, show_capabilities_for=tiktok_account)
        + "</section>"
    )
    return _page("Accounts", main)


@admin_router.get("/logs", response_class=HTMLResponse, dependencies=[Depends(admin_only)])
def logs(request: Request) -> HTMLResponse:
    """Render the recent operational diagnostics, with sensitive data redacted."""

    container = get_admin_container(request)
    events = container.diagnostics.recent(limit=200)

    main = "<section><h2>Operational logs</h2>"
    if not events:
        main += "<p>No recent diagnostic events.</p>"
    else:
        rows = [_render_log_row(event) for event in events]
        main += (
            "<table><thead><tr>"
            "<th>Time (UTC)</th><th>Level</th><th>Source</th><th>Correlation</th>"
            "<th>Platform</th><th>Endpoint</th><th>Status</th><th>Message</th><th>Detail</th>"
            "</tr></thead><tbody>" + "".join(rows) + "</tbody></table>"
        )
    main += "<form method='post' action='/admin/logs/clear'>"
    main += "<button type='submit'>Clear logs</button></form></section>"
    return _page("Logs", main)


@admin_router.post("/logs/clear", response_class=HTMLResponse, dependencies=[Depends(admin_only)])
def clear_logs(request: Request) -> HTMLResponse:
    """Clear the bounded diagnostic store (gated by CSRF via ``admin_only``)."""

    container = get_admin_container(request)
    container.diagnostics.clear()
    return _page("Logs", "<section><h2>Operational logs</h2><p>Logs cleared.</p></section>")


@admin_router.post("/accounts/disconnect", response_class=HTMLResponse, dependencies=[Depends(admin_only)])
def disconnect_account(request: Request) -> HTMLResponse:
    """Placeholder for account disconnection (gated by CSRF via ``admin_only``)."""

    body = (
        "<section><h2>Disconnect account</h2>"
        "<p>Account disconnection is not yet implemented.</p></section>"
    )
    return _page("Disconnect", body)


# --- TikTok OAuth: connect / reconnect / callback (issue #79) ----------------

@admin_router.post("/connect/tiktok", dependencies=[Depends(admin_only)])
async def connect_tiktok(
    request: Request,
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
    adapter: Annotated[TikTokLoginKitAdapter, Depends(get_tiktok_adapter)],
) -> RedirectResponse:
    """Initiate a TikTok Login Kit connection and redirect to TikTok for consent.

    The browser form submits a CSRF token (form field), which ``admin_only``
    checks before this handler runs. State is minted for the current admin
    session so it cannot be replayed from a different session.
    """

    if not _tiktok_client_configured(container):
        _record(container, DiagnosticLevel.ERROR,
                "TikTok OAuth initiation refused: client not configured")
        raise HTTPException(status_code=503, detail="TikTok authentication is not configured")

    try:
        service = build_tiktok_connect_service(container, adapter)
        auth_url = service.build_authorization_url(request)
    except TikTokOAuthError as exc:
        _record_error(container, exc, "TikTok OAuth flow could not be started")
        raise HTTPException(status_code=503, detail="Unable to start the TikTok connection") from exc
    except (TokenCipherUnavailableError, OAuthStateUnavailableError) as exc:
        _record_error(container, exc, "TikTok OAuth flow could not be started")
        raise HTTPException(status_code=503, detail="Unable to start the TikTok connection") from exc

    _record(container, DiagnosticLevel.INFO, "TikTok OAuth flow initiated")
    return RedirectResponse(url=auth_url, status_code=303)


@admin_router.post("/reconnect/tiktok", dependencies=[Depends(admin_only)])
async def reconnect_tiktok(
    request: Request,
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
    adapter: Annotated[TikTokLoginKitAdapter, Depends(get_tiktok_adapter)],
) -> RedirectResponse:
    """Reconnect an already-connected TikTok account.

    Reconnect re-authorizes through TikTok so the granted scopes and token expiry
    are refreshed. The store upserts by ``(platform, external_account_id)``,
    so authorizing the same account updates it and authorizing a different one
    adds a new row.
    """

    if not _tiktok_client_configured(container):
        _record(container, DiagnosticLevel.ERROR,
                "TikTok OAuth reconnect refused: client not configured")
        raise HTTPException(status_code=503, detail="TikTok authentication is not configured")

    try:
        service = build_tiktok_connect_service(container, adapter)
        auth_url = service.build_authorization_url(request)
    except TikTokOAuthError as exc:
        _record_error(container, exc, "TikTok OAuth reconnect could not be started")
        raise HTTPException(status_code=503, detail="Unable to start the TikTok reconnection") from exc
    except (TokenCipherUnavailableError, OAuthStateUnavailableError) as exc:
        _record_error(container, exc, "TikTok OAuth reconnect could not be started")
        raise HTTPException(status_code=503, detail="Unable to start the TikTok reconnection") from exc

    _record(container, DiagnosticLevel.INFO, "TikTok OAuth reconnect initiated")
    return RedirectResponse(url=auth_url, status_code=303)


@admin_router.get("/oauth/callback/tiktok", dependencies=[Depends(admin_only)])
async def tiktok_oauth_callback(
    request: Request,
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
    adapter: Annotated[TikTokLoginKitAdapter, Depends(get_tiktok_adapter)],
) -> RedirectResponse:
    """Handle the TikTok Login Kit authorization-code callback.

    TikTok redirects the browser here with ``code`` and ``state``. The state is
    consumed (validated for signature, expiry, session binding and one-shot use)
    before the code is exchanged server-side for tokens. Tokens are encrypted at
    rest with the configured :class:`TokenCipher` and the account upserted.

    Errors are recorded and the browser is sent back to the accounts page with a
    fixed ``?tiktok=error`` flag; no token, secret or platform error detail is
    reflected to the client.
    """

    code = request.query_params.get("code")
    state = request.query_params.get("state")
    if not code or not state:
        _record(container, DiagnosticLevel.ERROR,
                "TikTok OAuth callback received an incomplete response")
        return redirect_to_accounts("error")

    try:
        existing = any(
            a.platform is SocialPlatform.TIKTOK for a in container.account_store.list_accounts()
        )
        service = build_tiktok_connect_service(container, adapter)
        await service.complete_callback(request, code, state)
    except OAuthStateError as exc:
        _record_error(container, exc, "TikTok OAuth state rejected")
        return redirect_to_accounts("error")
    except (TikTokOAuthError, ValueError) as exc:
        _record_error(container, exc, "TikTok OAuth token exchange failed")
        return redirect_to_accounts("error")
    except (TokenCipherUnavailableError, OAuthStateUnavailableError) as exc:
        _record_error(container, exc, "TikTok OAuth persistence dependencies unavailable")
        return redirect_to_accounts("error")
    except sqlite3.Error as exc:
        # ``list_accounts`` (above) or ``complete_callback`` -> ``save`` can fail
        # if the store is unavailable. A failure before state consumption leaves
        # the state valid (retryable); a failure after consumption is handled
        # gracefully here rather than surfacing a 500. Matches the ``accounts``
        # and ``dashboard`` routes, which also guard ``list_accounts``.
        _record_error(container, exc, "TikTok OAuth callback storage error")
        return redirect_to_accounts("error")

    _record(
        container, DiagnosticLevel.INFO,
        "TikTok account reconnected" if existing else "TikTok account connected",
    )
    return redirect_to_accounts("reconnected" if existing else "connected")


# --- rendering helpers --------------------------------------------------------


def _render_tiktok_connect(
    tiktok_account: ConnectedAccount | None,
    csrf_token: str,
    configured: bool,
) -> str:
    """Render the Connect / Reconnect form for TikTok.

    A browser form posts the CSRF token as a hidden field (no JavaScript needed).
    When TikTok client credentials are not configured the buttons are disabled
    and a note is shown instead, so the admin surface stays usable.
    """

    if not configured:
        return (
            "<p>TikTok is not configured. Set TIKTOK_CLIENT_KEY and "
            "TIKTOK_CLIENT_SECRET to connect an account.</p>"
        )

    action = "/admin/connect/tiktok" if tiktok_account is None else "/admin/reconnect/tiktok"
    label = "Connect TikTok" if tiktok_account is None else "Reconnect TikTok"
    return (
        f'<form method="post" action="{action}">'
        f'<input type="hidden" name="csrf_token" value="{html.escape(csrf_token, quote=True)}" />'
        f'<button type="submit">{label}</button></form>'
    )


def _render_status(status: str | None) -> str:
    """Render a non-secret status banner from a fixed set of server flags."""

    messages = {
        "connected": "TikTok account connected.",
        "reconnected": "TikTok account reconnected.",
        "error": "TikTok connection failed. See logs for details.",
    }
    message = messages.get(status or "")
    if not message:
        return ""
    return f'<p role="status">{html.escape(message)}</p>'


def _record(
    container: ApplicationContainer,
    level: DiagnosticLevel,
    message: str,
) -> None:
    """Record a diagnostic event with the current request correlation id."""

    container.diagnostics.record(
        level, source="tiktok_oauth", message=message, correlation_id=current_request_id()
    )


def _record_error(
    container: ApplicationContainer, error: BaseException, message: str
) -> None:
    """Record an exception as an error diagnostic event (no full traceback).

    Only the exception type and its (non-secret) message are captured, matching
    the project's existing diagnostic policy; no full traceback or credential
    is ever stored.
    """

    container.diagnostics.record(
        DiagnosticLevel.ERROR, source="tiktok_oauth", message=message,
        correlation_id=current_request_id(),
        detail=f"{type(error).__name__}: {error}",
    )


_TIKTOK_ROW_ID = "_tiktok_capabilities"



def _render_accounts(
    accounts: Sequence[ConnectedAccount],
    *,
    show_capabilities_for: ConnectedAccount | None = None,
) -> str:
    """Render the connected accounts table, never exposing token values.

    The token columns show only the status (valid/expired/no expiry); the
    encrypted token bytes themselves are never rendered. When
    ``show_capabilities_for`` is a TikTok account, its granted capabilities
    (profile/video/statistics) are surfaced below the table -- only the scopes
    actually granted unlock a capability.
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

    table = (
        "<table>"
        "<thead><tr>"
        "<th>Platform</th><th>Username</th><th>Account ID</th>"
        "<th>Scopes</th><th>Token</th><th>Connected</th><th>Updated</th>"
        "</tr></thead>"
        f"<tbody>{''.join(rows)}</tbody>"
        "</table>"
    )

    if show_capabilities_for is not None and show_capabilities_for.platform is SocialPlatform.TIKTOK:
        table += _render_tiktok_capabilities(show_capabilities_for)

    return table


def _render_tiktok_capabilities(account: ConnectedAccount) -> str:
    """Render the read capabilities granted to a connected TikTok account."""

    resolved = resolve_tiktok_capabilities(account)
    items = "".join(
        f"<li>{html.escape(name)}: {html.escape('available' if cap.available else 'unavailable' + (f' ({cap.reason})' if cap.reason else ''))}</li>"
        for name, cap in resolved.capabilities.items()
    )
    return (
        f'<section id="{_TIKTOK_ROW_ID}"><h3>TikTok capabilities</h3>'
        f'<p>Platform: {html.escape(resolved.platform)} ('
        f'{len(resolved.available)}/{len(resolved.capabilities)} available)</p>'
        f"<ul>{items}</ul></section>"
    )


_NAV = ("<nav><a href='/admin/dashboard'>Dashboard</a> "
         "<a href='/admin/accounts'>Accounts</a> "
         "<a href='/admin/logs'>Logs</a> "
         "<a href='/admin/logout'>Log out</a></nav>")


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


_LEVELS = {DiagnosticLevel.ERROR, DiagnosticLevel.CRITICAL}


def _render_log_row(event: object) -> str:
    """Render one diagnostic event as a table row, escaping all string fields.

    The fields rendered here are already redacted by the :class:`Redactor`
    before they reach the log; this function only escapes for safe HTML and
    classifies the severity for a ``class`` attribute. No token, header or
    secret value is ever rendered.
    """

    # DiagnosticEvent is a dataclass; read attributes defensively to keep this
    # rendering logic decoupled from the model's exact field order.
    timestamp = getattr(event, "timestamp", None)
    level = getattr(event, "level", DiagnosticLevel.INFO)
    source = getattr(event, "source", "")
    correlation_id = getattr(event, "correlation_id", None)
    platform = getattr(event, "platform", None)
    endpoint = getattr(event, "endpoint", None)
    status_code = getattr(event, "status_code", None)
    message = getattr(event, "message", "")
    detail = getattr(event, "detail", None)

    def _esc(value: object) -> str:
        if value is None:
            return ""
        return html.escape(str(value))

    cells = (
        _esc(timestamp.isoformat() if hasattr(timestamp, "isoformat") else timestamp),
        _esc(level),
        _esc(source),
        _esc(correlation_id),
        _esc(platform),
        _esc(endpoint),
        _esc(status_code),
        _esc(message),
        _esc(detail),
    )
    row_class = " class='error'" if level in _LEVELS else ""
    return "<tr" + row_class + ">" + "".join(f"<td>{cell}</td>" for cell in cells) + "</tr>"
