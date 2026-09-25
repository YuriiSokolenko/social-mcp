"""FastAPI transport for the Social MCP service.

Startup owns infrastructure: the application container is built from
configuration when the app starts and shared with request handlers through
``app.state``. Keep this layer thin and resolve dependencies with
:func:`get_container` instead of constructing them per request.
"""

import logging
import sqlite3
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request, Response
from starlette.middleware.sessions import SessionMiddleware

from social_mcp.admin.routes import admin_router, public_router
from social_mcp.config import Settings, get_settings
from social_mcp.container import (
    ApplicationContainer,
    ContainerUnavailableError,
    create_container,
)

logger = logging.getLogger(__name__)


system_router = APIRouter(tags=["system"])

# Session cookie lifetime.
_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60


def _session_secret_or_none(settings: Settings) -> str | None:
    """Return a usable session-signing secret, or ``None`` when unset.

    An explicit ``ADMIN_SESSION_SECRET`` takes precedence; otherwise the file
    pointed to by ``ADMIN_SESSION_SECRET_FILE`` (if any) is read. The value is
    never logged or persisted beyond the in-memory settings instance.
    """

    secret = settings.admin_session_secret
    if secret is not None and secret.get_secret_value():
        return secret.get_secret_value()
    raw = settings.admin_session_secret_file
    if raw is not None:
        try:
            value = raw.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return value or None
    return None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Create the configured dependencies, including the account database."""

    container = create_container(app.state.settings)
    container.start()
    app.state.container = container
    yield


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the application with its dependencies wired from configuration.

    Building the application has no side effects: the account database is
    created when the app starts, and dependencies reach handlers through
    :func:`get_container`.
    """

    app_settings = settings if settings is not None else get_settings()

    app = FastAPI(
        title=app_settings.app_name,
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = app_settings
    app.state.container = None

    # Session middleware must wrap the app so every /admin route shares the
    # signed session cookie. The secret signs (and integrity-protects) the
    # session cookie; it is never the user's admin password.
    session_secret = _session_secret_or_none(app_settings)
    if session_secret is None:
        logger.warning(
            "ADMIN_SESSION_SECRET is missing or invalid; the Web Admin will refuse "
            "all logins and /admin requests until it is configured."
        )
    else:
        app.add_middleware(
            SessionMiddleware,
            secret_key=session_secret,
            max_age=_SESSION_MAX_AGE_SECONDS,
            https_only=app_settings.environment != "development",
            same_site="lax",
        )

    app.include_router(system_router)
    app.include_router(public_router)
    app.include_router(admin_router)
    return app


def get_container(request: Request) -> ApplicationContainer:
    """Return the wired container for a request.

    Raises:
        ContainerUnavailableError: when a request is served before startup has
            finished, rather than handing out half-wired dependencies.
    """

    container = getattr(request.app.state, "container", None)
    if container is None:
        raise ContainerUnavailableError()
    return container


@system_router.get("/health")
async def health(request: Request, response: Response) -> dict[str, str]:
    """Report application status: the account store must be reachable."""

    try:
        get_container(request).check()
    except ContainerUnavailableError:
        logger.error("Application startup did not complete")
        response.status_code = 503
        return {"status": "unhealthy"}
    except (sqlite3.Error, OSError):
        logger.exception("Account storage is unavailable")
        response.status_code = 503
        return {"status": "unhealthy"}

    return {"status": "ok"}


app = create_app()
