"""Small authenticated Web Admin shell for the future dashboard and accounts UI."""

from secrets import compare_digest
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from social_mcp.container import ApplicationContainer

basic_auth = HTTPBasic(auto_error=False)


def require_admin(
    request: Request,
    credentials: Annotated[HTTPBasicCredentials | None, Depends(basic_auth)],
) -> None:
    """Keep all admin routes closed unless credentials are explicitly configured."""

    container: ApplicationContainer | None = getattr(request.app.state, "container", None)
    if container is None:
        raise HTTPException(status_code=503, detail="Admin service is unavailable")
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


@admin_router.get("/", response_class=HTMLResponse)
@admin_router.get("/dashboard", response_class=HTMLResponse)
def dashboard() -> HTMLResponse:
    """Entry point for the dashboard implemented in issue #13."""

    return HTMLResponse(
        "<h1>Social MCP Admin</h1><nav><a href='/admin/dashboard'>Dashboard</a> "
        "<a href='/admin/accounts'>Accounts</a></nav><main>Dashboard coming soon.</main>",
        headers={"Cache-Control": "no-store"},
    )


@admin_router.get("/accounts", response_class=HTMLResponse)
def accounts() -> HTMLResponse:
    """Entry point for the account listing implemented in issue #13."""

    return HTMLResponse(
        "<h1>Accounts</h1><nav><a href='/admin/dashboard'>Dashboard</a> "
        "<a href='/admin/accounts'>Accounts</a></nav><main>Accounts coming soon.</main>",
        headers={"Cache-Control": "no-store"},
    )
