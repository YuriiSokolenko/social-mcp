"""Normalized MCP error categories for the Social MCP server.

Error categories mirror the tool contract
(``docs/threads-tool-contract.md`` Common response/error model) so an MCP
client can branch on a stable, safe category instead of parsing platform
responses. Tools raise :class:`McpError` for any failure they anticipate; the
handler wrapper converts it into a single ``is_error=True`` result carrying the
category and a human-readable message.

Secrets-token rules: error messages never include access tokens, refresh tokens,
client secrets, encryption keys or authorization headers.
"""

from __future__ import annotations

from dataclasses import dataclass

from mcp.server.mcpserver.exceptions import ToolError

# Stable, client-facing error categories. These are strings (not enums) so they
# survive JSON serialization and remain stable across minor versions.
AUTHENTICATION_REQUIRED = "authentication_required"
PERMISSION_REQUIRED = "permission_required"
CAPABILITY_UNAVAILABLE = "capability_unavailable"
INVALID_REQUEST = "invalid_request"
NOT_FOUND = "not_found"
RATE_LIMITED = "rate_limited"
PLATFORM_ERROR = "platform_error"
TEMPORARY_FAILURE = "temporary_failure"

#: Every category an MCP tool may surface to a client.
SUPPORTED_CATEGORIES: frozenset[str] = frozenset(
    {
        AUTHENTICATION_REQUIRED,
        PERMISSION_REQUIRED,
        CAPABILITY_UNAVAILABLE,
        INVALID_REQUEST,
        NOT_FOUND,
        RATE_LIMITED,
        PLATFORM_ERROR,
        TEMPORARY_FAILURE,
    }
)


@dataclass(frozen=True)
class McpError(ToolError):
    """An anticipated tool failure with a normalized, client-facing category.

    Raising this from a tool lets the MCP server return ``is_error=True`` with a
    structured message instead of treating the call as a crash. The category is
    one of :data:`SUPPORTED_CATEGORIES`; the message is safe to return to the
    client and must never contain secrets.
    """

    category: str
    message: str

    def __post_init__(self) -> None:
        if self.category not in SUPPORTED_CATEGORIES:
            raise ValueError(
                f"Unknown MCP error category: {self.category!r}. "
                f"Use one of {sorted(SUPPORTED_CATEGORIES)}."
            )

    def __str__(self) -> str:
        return f"[{self.category}] {self.message}"


def error_response(category: str, message: str) -> str:
    """Format an error as a stable ``[category] message`` string for tool results."""

    if category not in SUPPORTED_CATEGORIES:
        raise ValueError(
            f"Unknown MCP error category: {category!r}. "
            f"Use one of {sorted(SUPPORTED_CATEGORIES)}."
        )
    if not message:
        raise ValueError("An error message is required.")
    return f"[{category}] {message}"


def authentication_required(message: str) -> McpError:
    """A connected account is required before the tool can run."""

    return McpError(category=AUTHENTICATION_REQUIRED, message=message)


def capability_unavailable(message: str) -> McpError:
    """The requested capability is not available for the connected account."""

    return McpError(category=CAPABILITY_UNAVAILABLE, message=message)


def permission_required(message: str) -> McpError:
    """The account is connected but a required permission/scope is missing."""

    return McpError(category=PERMISSION_REQUIRED, message=message)


def invalid_request(message: str) -> McpError:
    """The request arguments are invalid."""

    return McpError(category=INVALID_REQUEST, message=message)
