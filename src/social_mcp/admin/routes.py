"""Small authenticated Web Admin shell for the future dashboard and accounts UI."""

import html
import sqlite3
from collections.abc import Sequence
from datetime import UTC, datetime
from secrets import compare_digest
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from social_mcp.container import ApplicationContainer
from social_mcp.storage.models import ConnectedAccount

basic_auth = HTTPBasic(auto_error=False)


def get_admin_container(request: Request) -> ApplicationContainer:
    """Resolve the application container for a request that has passed admin auth."""

    container: ApplicationContainer | None = getattr(request.app.state, "container", None)
    if container is None:
        raise HTTPException(status_code=503, detail="Admin service is unavailable")
    return container


def require_admin(
    request: Request,
    credentials: Annotated[HTTPBasicCredentials | None, Depends(basic_auth)],
) -> None:
    """Keep all admin routes closed unless credentials are explicitly configured."""

    container = get_admin_container(request)
    username = container.settings.admin_username
    password = container.settings.admin_password
    if not username or password is None or not password.get_secret_value():
        raise HTTPException(status_code=503, detail="Admin authentication is not configured")
    if credentials is not None:
        valid_username = compare_digest(
            credentials.username.encode("utf-8"), username.encode("utf-8")
        )
        valid_password = compare_digest(
            credentials.password.encode("utf-8"), password.get_secret_value().encode("utf-8")
        )
        if valid_username and valid_password:
            return
    raise HTTPException(
        status_code=401,
        detail="Invalid admin credentials",
        headers={"WWW-Authenticate": 'Basic realm="Social MCP Admin"'},
    )


admin_router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
)

_NAV = "<nav><a href='/admin/dashboard'>Dashboard</a> " "<a href='/admin/accounts'>Accounts</a></nav>"


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
    """Render connected accounts as a table, never exposing token values."

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


@admin_router.get("/", response_class=HTMLResponse)
@admin_router.get("/dashboard", response_class=HTMLResponse)
def dashboard(
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


@admin_router.get("/accounts", response_class=HTMLResponse)
def accounts(
    container: Annotated[ApplicationContainer, Depends(get_admin_container)],
) -> HTMLResponse:
    """Render the connected accounts listing without exposing token values."""

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
