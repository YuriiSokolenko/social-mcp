"""Stdio entry point for the Social MCP server.

This is the transport suitable for local testing and direct agent integration
(ChatGPT, Pi, Codex via a local MCP client). The server reads configuration
through :func:`social_mcp.config.get_settings`, builds the application
container from it, and serves MCP over the process's stdin/stdout.

Usage::

    python -m social_mcp.server

The container is created lazily on first tool invocation so the process can
start even before the database is writable; account lookup failures surface as
normalized MCP errors rather than a crashed process.
"""

from __future__ import annotations

import asyncio
import logging

from social_mcp.config import Settings, get_settings
from social_mcp.container import (
    ApplicationContainer,
    ContainerUnavailableError,
    create_container,
)
from social_mcp.server.errors import McpError, authentication_required
from social_mcp.server.server import ThreadsAccountProvider, create_mcp_server
from social_mcp.storage.models import ConnectedAccount

logger = logging.getLogger("social-mcp")


def _build_accounts_provider(settings: Settings) -> tuple[ThreadsAccountProvider, ApplicationContainer]:
    """Create a container and an async provider for the connected Threads account.

    The provider resolves the account at call time from the persisted store so a
    freshly connected account is visible without restarting the server.
    """

    container = create_container(settings)
    container.start()

    from social_mcp.storage.models import SocialPlatform

    async def provider() -> ConnectedAccount | None:
        accounts = container.account_store.list_accounts()
        for account in accounts:
            if account.platform is SocialPlatform.THREADS:
                return account
        return None

    return provider, container


async def amain() -> None:
    settings = get_settings()
    provider, _container = _build_accounts_provider(settings)

    server = create_mcp_server(
        accounts_provider=provider,
        server_name=settings.app_name,
        server_version="0.1.0",
    )

    # stdio transport: recommended for local testing and native agent integration.
    await server.run_stdio_async()


def main() -> None:
    """Synchronous entry point used by the ``-m social_mcp.server`` invocation."""

    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(amain())
    except (ContainerUnavailableError, McpError) as exc:
        # A configuration problem is reported cleanly rather than as a stack
        # traceback; sensitive values are never included in the message.
        logger.error("Social MCP server failed to start: %s", exc)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
