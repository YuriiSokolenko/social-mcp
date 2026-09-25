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

from social_mcp.admin.routes import admin_router
from social_mcp.config import Settings, get_settings
from social_mcp.container import (
    ApplicationContainer,
    ContainerUnavailableError,
    create_container,
)

logger = logging.getLogger(__name__)

system_router = APIRouter(tags=["system"])


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
    app.include_router(system_router)
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
