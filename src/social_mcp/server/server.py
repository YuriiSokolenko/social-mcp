"""The Social MCP server interface.

The MCP layer is a thin transport: it registers tools that delegate to shared
application logic and surface normalized errors. The only tool registered here
for this task is ``threads_capabilities``; profile/posts tools come later.

Capabilities are resolved from a connected account provided by the host through
:func:`create_mcp_server`. The host (FastAPI, a future Web Admin, or the stdio
entry point) owns the application container and supplies the connected Threads
account. No capability is reported unless the connected account's granted scopes
authorize it; the resolver never assumes permissions from code presence.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from mcp.server.mcpserver import MCPServer
from pydantic import TypeAdapter

from social_mcp.server.capabilities import (
    PLATFORM_THREADS,
    ThreadsCapabilities,
    resolve_threads_capabilities,
)
from social_mcp.server.errors import (
    McpError,
    authentication_required,
)
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

#: A provider that returns the connected account, or ``None`` when no account is
#: connected. Resolving at call time (rather than startup) means a freshly
#: connected account is visible without restarting the server.
ThreadsAccountProvider = Callable[[], Awaitable[ConnectedAccount | None]]

_CAPABILITIES_TOOL_NAME = "threads_capabilities"

# Adapters for converting Pydantic models to plain dicts the MCP layer returns as
# structured content, and for validating them back in tests.
_capabilities_adapter = TypeAdapter(ThreadsCapabilities)


def _find_connected_account(accounts: list[ConnectedAccount]) -> ConnectedAccount | None:
    """Return the first connected Threads account, or ``None``."""

    for account in accounts:
        if account.platform is SocialPlatform.THREADS:
            return account
    return None


def create_mcp_server(
    accounts_provider: ThreadsAccountProvider,
    *,
    server_name: str = "social-mcp",
    server_version: str = "0.1.0",
) -> MCPServer:
    """Build the Social MCP server with its tools registered.

    Args:
        accounts_provider: An async callable returning the connected Threads
            account, or ``None`` when no Threads account is connected.
        server_name: The MCP server name advertised at initialization.
        server_version: The MCP server version advertised at initialization.

    Returns:
        An :class:`~mcp.server.mcpserver.MCPServer` with ``threads_capabilities``
        registered. The server is transport-agnostic; call
        :meth:`~mcp.server.mcpserver.MCPServer.run` with the desired transport.

    Raises:
        McpError: only from within a tool execution; never from construction.
    """

    server = MCPServer(
        name=server_name,
        version=server_version,
        instructions=(
            "Social MCP exposes read and write tools for official social-network "
            "APIs. Tools report real configured/granted capabilities only; no "
            "capability is assumed from code presence."
        ),
    )

    @server.tool(
        name=_CAPABILITIES_TOOL_NAME,
        description=(
            "Return the Threads capabilities currently available to the "
            "connected account, based on configured and granted scopes. "
            "Reports only capabilities actually available; nothing is "
            "assumed from code presence."
        ),
        title="Threads Capabilities",
        annotations={
            "read_only_hint": True,
            "open_world_hint": False,
        },
        structured_output=True,
    )
    async def threads_capabilities() -> dict[str, Any]:
        account = await accounts_provider()
        resolved = resolve_threads_capabilities(
            _find_connected_account([account]) if account is not None else None
        )

        if not resolved.connected:
            # No account is connected: the capability set already states this,
            # but a normalized error lets clients branch without inspecting it.
            raise authentication_required(
                "No Threads account is connected. Connect one through the Web Admin."
            )

        # ``platform`` is always reported; ``connected`` is True here; each
        # capability carries its own availability flag.
        return _capabilities_adapter.dump_python(resolved)

    return server
