"""The Social MCP server interface.

Thin transport: tools delegate to shared application logic and surface normalized
errors. Registered tools: ``threads_capabilities``, ``threads_get_profile``,
``threads_list_posts``, ``threads_get_post``. Read tools issue only ``GET``
requests to the Threads Graph API (never mutate state). Capabilities are
resolved from the connected account; no capability is assumed from code
presence.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from mcp.server.mcpserver import MCPServer
from pydantic import TypeAdapter

from social_mcp.auth.token_cipher import TokenCipher
from social_mcp.platforms.threads.api import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MIN_LIMIT,
    ThreadsApiClient,
    ThreadsApiTransport,
    ThreadsPost,
    ThreadsPostList,
    ThreadsProfile,
)
from social_mcp.server.capabilities import (
    SCOPE_BASIC,
    SCOPE_CONTENT,
    ThreadsCapabilities,
    is_scope_sufficient,
    resolve_threads_capabilities,
)
from social_mcp.server.errors import (
    McpError,
    authentication_required,
    capability_unavailable,
    permission_required,
)
from social_mcp.storage.models import ConnectedAccount, SocialPlatform

ThreadsAccountProvider = Callable[[], Awaitable[ConnectedAccount | None]]

_CAPABILITIES_TOOL_NAME = "threads_capabilities"

_capabilities_adapter = TypeAdapter(ThreadsCapabilities)
_profile_adapter = TypeAdapter(ThreadsProfile)
_post_adapter = TypeAdapter(ThreadsPost)
_post_list_adapter = TypeAdapter(ThreadsPostList)


def _find_connected_account(accounts: list[ConnectedAccount]) -> ConnectedAccount | None:
    """Return the first connected Threads account, or ``None``."""
    for account in accounts:
        if account.platform is SocialPlatform.THREADS:
            return account
    return None


def _decrypt_access_token(account: ConnectedAccount, token_cipher: TokenCipher | None) -> str:
    """Decrypt the connected account's access token.

    The cipher is optional so the server stays constructible without one (the
    capabilities tool never needs it). When decryption is required but
    unavailable/malformed, a ``capability_unavailable`` normalized error is
    raised rather than degrading to plaintext token handling.
    """
    if token_cipher is None:
        raise capability_unavailable(
            "Token decryption is unavailable; the connected account cannot be read."
        )
    try:
        return token_cipher.decrypt(account.access_token_encrypted)
    except ValueError as exc:
        raise capability_unavailable(
            "The connected account's token could not be decrypted; reconnect it through the Web Admin."
        ) from exc


def _map_platform_error(exc: BaseException) -> McpError:
    """Normalize platform/HTTP/OAuth failures into a stable McpError."""
    from social_mcp.platforms.mapping import to_mcp_error

    return to_mcp_error(exc)


def create_mcp_server(
    accounts_provider: ThreadsAccountProvider,
    *,
    token_cipher: TokenCipher | None = None,
    threads_api_transport: ThreadsApiTransport | None = None,
    server_name: str = "social-mcp",
    server_version: str = "0.1.0",
) -> MCPServer:
    """Build the Social MCP server with its tools registered.

    Args:
        accounts_provider: Async callable returning the connected Threads
            account, or ``None`` when none is connected.
        token_cipher: Optional TokenCipher used to decrypt tokens for read tools.
            When ``None``, read tools surface ``capability_unavailable``.
        threads_api_transport: Optional injectable API transport for tests. When
            ``None`` (production), read tools use the default HTTP transport.
        server_name: The MCP server name advertised at initialization.
        server_version: The MCP server version advertised at initialization.

    Returns:
        An MCPServer with the read tools and capacity tool registered.
    """
    server = MCPServer(
        name=server_name,
        version=server_version,
        instructions=(
            "Social MCP exposes read and write tools for official social-network "
            "APIs. Tools report real configured/granted capabilities only; no "
            "capability is assumed from code presence. Read tools never mutate "
            "platform state."
        ),
    )

    @server.tool(
        name=_CAPABILITIES_TOOL_NAME,
        description=(
            "Return Threads capabilities available to the connected account, "
            "based on configured and granted scopes."
        ),
        title="Threads Capabilities",
        annotations={"read_only_hint": True, "open_world_hint": False},
        structured_output=True,
    )
    async def threads_capabilities() -> dict[str, Any]:
        try:
            account = await accounts_provider()
        except McpError:
            raise
        except BaseException as exc:  # noqa: BLE001
            raise _map_platform_error(exc)
        resolved = resolve_threads_capabilities(
            _find_connected_account([account]) if account is not None else None
        )
        if not resolved.connected:
            raise authentication_required(
                "No Threads account is connected. Connect one through the Web Admin."
            )
        return _capabilities_adapter.dump_python(resolved)

    @server.tool(
        name="threads_get_profile",
        description=(
            "Return the connected Threads profile (platform user ID, username "
            "and available profile fields). Read-only; never mutates state."
        ),
        title="Threads Profile",
        annotations={"read_only_hint": True, "open_world_hint": False},
        structured_output=True,
    )
    async def threads_get_profile() -> dict[str, Any]:
        try:
            account = await accounts_provider()
        except McpError:
            raise
        except BaseException as exc:  # noqa: BLE001
            raise _map_platform_error(exc)
        if account is None:
            raise authentication_required(
                "No Threads account is connected. Connect one through the Web Admin."
            )
        if not is_scope_sufficient(account, [SCOPE_BASIC]):
            raise permission_required(
                "The connected account lacks the 'threads_basic' scope required to read a profile."
            )
        token = _decrypt_access_token(account, token_cipher)
        try:
            async with ThreadsApiClient(token, transport=threads_api_transport) as client:
                profile = await client.get_profile()
        except McpError:
            raise
        except BaseException as exc:  # noqa: BLE001
            raise _map_platform_error(exc)
        return _profile_adapter.dump_python(profile)

    @server.tool(
        name="threads_list_posts",
        description=(
            "List posts belonging to the connected account. Read-only; never "
            "mutates state. Bounded page size and explicit pagination cursor."
        ),
        title="Threads Posts",
        annotations={"read_only_hint": True, "open_world_hint": False},
        structured_output=True,
    )
    async def threads_list_posts(
        limit: int = DEFAULT_LIMIT,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        try:
            account = await accounts_provider()
        except McpError:
            raise
        except BaseException as exc:  # noqa: BLE001
            raise _map_platform_error(exc)
        if account is None:
            raise authentication_required(
                "No Threads account is connected. Connect one through the Web Admin."
            )
        if not is_scope_sufficient(account, [SCOPE_CONTENT]):
            raise permission_required(
                "The connected account lacks the 'threads_content' scope required to list posts."
            )
        if limit is None:
            limit = DEFAULT_LIMIT
        if isinstance(limit, bool) or not isinstance(limit, int):
            raise McpError(
                category="invalid_request",
                message=f"limit must be an integer, got {type(limit).__name__}",
            )
        if limit < MIN_LIMIT:
            limit = MIN_LIMIT
        elif limit > MAX_LIMIT:
            limit = MAX_LIMIT
        if cursor is not None and not (isinstance(cursor, str) and cursor):
            raise McpError(
                category="invalid_request",
                message="cursor must be a non-empty string when provided",
            )
        token = _decrypt_access_token(account, token_cipher)
        try:
            async with ThreadsApiClient(token, transport=threads_api_transport) as client:
                post_list = await client.list_posts(limit=limit, cursor=cursor)
        except McpError:
            raise
        except BaseException as exc:  # noqa: BLE001
            raise _map_platform_error(exc)
        return _post_list_adapter.dump_python(post_list)

    @server.tool(
        name="threads_get_post",
        description=(
            "Return one accessible Threads post by platform ID. Read-only; never mutates state."
        ),
        title="Threads Post",
        annotations={"read_only_hint": True, "open_world_hint": False},
        structured_output=True,
    )
    async def threads_get_post(post_id: str) -> dict[str, Any]:
        try:
            account = await accounts_provider()
        except McpError:
            raise
        except BaseException as exc:  # noqa: BLE001
            raise _map_platform_error(exc)
        if account is None:
            raise authentication_required(
                "No Threads account is connected. Connect one through the Web Admin."
            )
        if not is_scope_sufficient(account, [SCOPE_CONTENT]):
            raise permission_required(
                "The connected account lacks the 'threads_content' scope required to read posts."
            )
        if not isinstance(post_id, str) or not post_id:
            raise McpError(category="invalid_request", message="post_id must be a non-empty string")
        token = _decrypt_access_token(account, token_cipher)
        try:
            async with ThreadsApiClient(token, transport=threads_api_transport) as client:
                post = await client.get_post(post_id)
        except McpError:
            raise
        except BaseException as exc:  # noqa: BLE001
            raise _map_platform_error(exc)
        return _post_adapter.dump_python(post)

    return server
