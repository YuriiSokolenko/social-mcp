"""The Social MCP server interface.

This package owns the MCP transport and tool registration. It keeps the transport
thin and delegates capability resolution to :mod:`social_mcp.server.capabilities`
(application core) and account lookup to the host via an async provider.
"""

from social_mcp.server.capabilities import (
    PLATFORM_THREADS,
    ThreadsCapabilities,
    resolve_threads_capabilities,
)
from social_mcp.server.errors import (
    AUTHENTICATION_REQUIRED,
    CAPABILITY_UNAVAILABLE,
    INVALID_REQUEST,
    McpError,
    NOT_FOUND,
    PERMISSION_REQUIRED,
    PLATFORM_ERROR,
    RATE_LIMITED,
    SUPPORTED_CATEGORIES,
    TEMPORARY_FAILURE,
    authentication_required,
    capability_unavailable,
    error_response,
    invalid_request,
    permission_required,
)
from social_mcp.server.server import create_mcp_server

__all__ = [
    # capabilities
    "PLATFORM_THREADS",
    "ThreadsCapabilities",
    "resolve_threads_capabilities",
    # errors
    "AUTHENTICATION_REQUIRED",
    "CAPABILITY_UNAVAILABLE",
    "INVALID_REQUEST",
    "McpError",
    "NOT_FOUND",
    "PERMISSION_REQUIRED",
    "PLATFORM_ERROR",
    "RATE_LIMITED",
    "SUPPORTED_CATEGORIES",
    "TEMPORARY_FAILURE",
    "authentication_required",
    "capability_unavailable",
    "error_response",
    "invalid_request",
    "permission_required",
    # server
    "create_mcp_server",
]
