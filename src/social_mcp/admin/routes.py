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
import logging
import sqlite3
from collections.abc import Sequence
from datetime import UTC, datetime
from hmac import compare_digest
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import SecretStr

from social_mcp.auth.oauth_state import OAuthStateError
from social_mcp.container import ApplicationContainer
from social_mcp.diagnostics import DiagnosticLevel
from social_mcp.platforms.threads import (
    ThreadsLoginAdapter,
    ThreadsOAuthError,
    ThreadsOAuthTransport,
    ThreadsTokenSuccessResponse,
)
from social_mcp.platforms.threads import token_response_to_account_state as _map_token_response
from social_mcp.platforms.threads.constants import (
    DEFAULT_CALLBACK_PATH,
    PLATFORM_THREADS,
    SCOPE_THREADS_BASIC,
)
from social_mcp.platforms.threads.oauth import ThreadsAccountState
from social_mcp.storage.models import ConnectedAccount

logger = logging.getLogger(__name__)

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


async def admin_only(
    request: Request,
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
) -> None:
    """Dependency that blocks admin routes unless a valid session exists.

    Unauthenticated browser navigation (``GET``/``HEAD``) is redirected to the
    login page; all other methods receive ``401`` so non-browser clients can
    detect the missing session. State-changing methods (``POST``/``PUT``/
    ``PATCH``/``DELETE``) must also present a CSRF token matching the session,
    taken from the ``x-csrf-token`` header (API clients) or a ``csrf_token``
    form field (browser form submissions).
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
        if token is None:
            # Browser form submissions cannot set custom headers; fall back to a
            # ``csrf_token`` hidden form field. Form parsing is cached by
            # Starlette so the route handler can still access it.
            token = (await request.form()).get("csrf_token")
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

    connect_button = _render_connect_threads_button(container, request)
    main = (
        "<section><h2>Connected accounts</h2>"
        + connect_button
        + _render_accounts(stored_accounts)
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


# ---------------------------------------------------------------------------
# Threads OAuth connect flow (issue #16)
# ---------------------------------------------------------------------------


class HttpxThreadsTransport:
    """HTTP transport that POSTs to the Meta/Threads token endpoint via httpx.

    This is the production transport boundary used by
    :class:`~social_mcp.platforms.threads.ThreadsLoginAdapter`. Tests inject a
    fake :class:`~social_mcp.platforms.threads.ThreadsOAuthTransport` instead.
    Only the token endpoint is reached; no other Meta API is called from here.
    """

    def __init__(self, *, timeout: float = 30.0) -> None:
        self._timeout = timeout

    async def post(self, url: str, data: dict[str, str]) -> dict[str, object]:
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, data=data, timeout=self._timeout)
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as exc:
            # Surface a safe, non-secret message: never include headers or body.
            raise ThreadsOAuthError(
                f"Threads token endpoint returned HTTP {exc.response.status_code}."
            ) from exc
        except httpx.HTTPError as exc:
            raise ThreadsOAuthError("Threads token endpoint could not be reached.") from exc
        except (ValueError, TypeError) as exc:
            # response.json() failed to parse a non-JSON body.
            raise ThreadsOAuthError("Threads token endpoint returned an invalid response.") from exc


def build_threads_adapter(transport: ThreadsOAuthTransport) -> ThreadsLoginAdapter:
    """Construct the Threads OAuth adapter with a given transport boundary."""

    return ThreadsLoginAdapter(transport=transport)


def _threads_configured(container: ApplicationContainer) -> bool:
    """Whether all dependencies for the Threads connect flow are present.

    Requires: Meta app credentials, the OAuth state secret (for CSRF state),
    the token encryption key (for encrypting stored tokens), and the redirect
    URI resolution (which always has a default). Returns ``False`` rather than
    raising so callers can report a safe 503 to the admin.
    """

    settings = container.settings
    if not settings.meta_app_id or not settings.meta_app_secret:
        return False
    if container.token_cipher_or_none() is None:
        return False
    return container.oauth_state_manager_or_none() is not None


def _resolve_threads_redirect_uri(settings) -> str:
    """Return the configured redirect URI, defaulting to the dev callback route."""

    configured = getattr(settings, "threads_redirect_uri", None)
    if configured and configured.strip():
        return configured
    return f"http://127.0.0.1:8000{DEFAULT_CALLBACK_PATH}"


def _resolve_threads_scopes(settings) -> list[str]:
    """Return the scopes to request, always including ``threads_basic``."""

    from social_mcp.platforms.threads import parse_scopes

    configured = getattr(settings, "threads_scopes", None)
    if configured and configured.strip():
        return parse_scopes(configured)
    return [SCOPE_THREADS_BASIC]


def _current_session_id(request: Request) -> str:
    """Return the CSRF token from the session, used as the OAuth state session id.

    The CSRF token is stable for the lifetime of the admin session and unique
    per session, which makes it a suitable ``session_id`` for binding an OAuth
    state value. Raises ``403`` if no session is active (no CSRF token).
    """

    return _current_csrf(request)


# OAuth callback path. ``DEFAULT_CALLBACK_PATH`` includes the ``/admin`` prefix
# (for the redirect URI sent to Meta); the route itself is relative to the
# ``admin_router`` prefix, so it drops the leading ``/admin``.
_THREADS_CALLBACK_PATH = DEFAULT_CALLBACK_PATH
# Drop the ``/admin`` prefix: the route is relative to the ``admin_router``
# prefix, so ``/oauth/callback/threads`` + prefix ``/admin`` = full path.
_THREADS_CALLBACK_ROUTE = DEFAULT_CALLBACK_PATH.removeprefix("/admin")


@admin_router.post("/connect/threads", response_class=HTMLResponse, dependencies=[Depends(admin_only)])
async def connect_threads(
    request: Request,
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
) -> RedirectResponse:
    """Start the Threads OAuth authorization flow from the protected Accounts page.

    Creates a signed, session-bound OAuth state, builds the Meta authorization
    URL with the configured scopes, and redirects the browser to Meta. The state
    is validated and consumed in the callback. No token material is exposed to
    the browser.

    Raises ``503`` when the Threads adapter is not fully configured (missing Meta
    credentials, encryption key, or OAuth state secret).
    """

    if not _threads_configured(container):
        logger.warning(
            "Threads connect flow not configured; a Connect Threads request was rejected."
        )
        raise HTTPException(status_code=503, detail="Threads connection is not configured")

    settings = container.settings
    oauth_manager = container.require_oauth_state_manager()
    session_id = _current_session_id(request)

    state = oauth_manager.create(session_id, platform=PLATFORM_THREADS)

    adapter = build_threads_adapter(HttpxThreadsTransport())
    auth_url = adapter.authorization_url(
        client_id=settings.meta_app_id,
        redirect_uri=_resolve_threads_redirect_uri(settings),
        scopes=_resolve_threads_scopes(settings),
        state=state,
    )
    return RedirectResponse(url=auth_url, status_code=303)


@admin_router.get(_THREADS_CALLBACK_ROUTE, response_class=HTMLResponse, dependencies=[Depends(admin_only)])
async def threads_oauth_callback(
    request: Request,
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
) -> HTMLResponse:
    """Handle the Meta OAuth callback for Threads account connection.

    The callback is a GET redirect target, so it is not subject to CSRF-token
    checking (it is a GET); the signed OAuth ``state`` parameter provides CSRF
    protection by binding the callback to the initiating admin session.

    On success the authorization code is exchanged server-side for an access
    token, the token is encrypted, and the account identity and granted scopes
    are persisted (replacing any existing connection for the same account,
    which is how reconnect works).
    """

    if not _threads_configured(container):
        logger.warning(
            "Threads OAuth callback received but the adapter is not configured.")
        return _connection_error_page("Threads connection is not configured.")

    settings = container.settings
    oauth_manager = container.require_oauth_state_manager()
    cipher = container.require_token_cipher()

    # Canceled authorization: Meta redirects with an error instead of a code.
    error = request.query_params.get("error")
    if error:
        return _connection_error_page("Authorization was cancelled.")

    code = request.query_params.get("code", "")
    state_value = request.query_params.get("state", "")
    # Meta appends ``#_`` to the redirect URI; strip it defensively from the code
    # in case it is ever carried into the query string.
    code = code.removesuffix("#_").strip()

    if not code or not state_value:
        return _connection_error_page(
            "Missing authorization code or state. The connection was not completed."
        )

    session_id = _current_session_id(request)
    try:
        oauth_manager.consume(state_value, session_id=session_id)
    except OAuthStateError as exc:
        logger.warning("Threads OAuth state validation failed: %s", exc)
        return _connection_error_page(str(exc))

    redirect_uri = _resolve_threads_redirect_uri(settings)
    adapter = build_threads_adapter(HttpxThreadsTransport())
    try:
        token_response = await adapter.exchange_code_for_token(
            client_id=settings.meta_app_id,
            client_secret=settings.meta_app_secret,
            code=code,
            redirect_uri=redirect_uri,
        )
    except ThreadsOAuthError as exc:
        logger.warning("Threads token exchange failed: %s", exc)
        _record_connection_attempt(request, exc)
        return _connection_error_page(str(exc))

    encrypted_token = cipher.encrypt(token_response.access_token)
    scopes = _resolve_threads_scopes(settings)
    account_state = _token_response_to_account_state(
        token_response, encrypted_token, scopes
    )

    try:
        stored = container.account_store.save(account_state.to_connected_account())
    except sqlite3.Error as exc:
        logger.error("Failed to persist Threads account: %s", exc)
        return _connection_error_page("The connection was established but could not be saved.")

    logger.info("Threads account %s connected.", stored.external_account_id)
    return _connection_success_page(stored)


def _token_response_to_account_state(
    token_response: ThreadsTokenSuccessResponse,
    encrypted_token: bytes,
    scopes: list[str],
) -> ThreadsAccountState:
    """Map the token response to an account state, preferring response scopes.

    Uses the granted scopes from the token response when present; otherwise falls
    back to the requested scopes (Meta does not always return scopes in the
    short-lived token response). Encryption is performed by the caller.
    """

    return _map_token_response(
        token_response, access_token_encrypted=encrypted_token, scopes=scopes
    )


def _render_connect_threads_button(
    container: ApplicationContainer, request: Request
) -> str:
    """Render the Connect Threads button, or a notice when not configured.

    The form submits the session CSRF token as a ``csrf_token`` hidden field so
    that the ``admin_only`` CSRF check passes for browser form submissions.
    """

    if not _threads_configured(container):
        return (
            '<p>Configure META_APP_ID, META_APP_SECRET, TOKEN_ENCRYPTION_KEY and '
            'OAUTH_STATE_SECRET to connect Threads.</p>'
        )
    csrf_token = request.session.get(_CSRF_KEY)
    if not isinstance(csrf_token, str):
        # admin_only already verified the session; a missing CSRF token here is
        # unexpected, so fall back to a fresh one (the form will still be
        # submitted and the session-bound state will be validated in the callback).
        csrf_token = _generate_csrf_token()
    return (
        '<form method="post" action="/admin/connect/threads">'
        f'<input type="hidden" name="csrf_token" value="{html.escape(csrf_token)}" />'
        '<button type="submit">Connect Threads</button></form>'
    )


def _connection_error_page(message: str) -> HTMLResponse:
    """Render a safe error page for a failed Threads connection.

    Only the provided message is shown; no token, header, or secret value is
    ever rendered. The message is escaped for safe HTML.
    """

    body = (
        "<section><h2>Threads connection</h2>"
        f'<p class="error">{html.escape(message)}</p>'
        '<p><a href="/admin/accounts">Back to accounts</a></p></section>'
    )
    return _page("Threads connection", body)


def _connection_success_page(stored: ConnectedAccount) -> HTMLResponse:
    """Render a success page after a Threads account is connected or reconnected."""

    body = (
        "<section><h2>Threads connection</h2>"
        '<p>Your Threads account was connected successfully.</p>'
        f'<p>Account: {html.escape(stored.username or stored.external_account_id)}</p>'
        '<p><a href="/admin/accounts">View connected accounts</a></p></section>'
    )
    return _page("Threads connection", body)


def _record_connection_attempt(request: Request, error: Exception) -> None:
    """Record a failed Threads connection attempt in the diagnostic log.

    Only a safe, non-secret summary is recorded; no token, header, or secret is
    ever logged.
    """

    correlation_id = getattr(request.state, "correlation_id", None)
    try:
        request.app.state.container.diagnostics.record(
            level=DiagnosticLevel.ERROR,
            source="threads-oauth",
            message=f"Threads connection failed: {error}",
            correlation_id=correlation_id,
            platform=PLATFORM_THREADS,
            endpoint=_THREADS_CALLBACK_PATH,
            status_code=400,
        )
    except Exception as exc:  # noqa: BLE001
        # Diagnostics are best-effort; never let logging break the callback.
        logger.debug("Diagnostic recording failed: %s", exc)


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
