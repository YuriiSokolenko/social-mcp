"""Platform adapters for official social-network APIs.

Each sub-package owns the platform-specific behaviour (OAuth, API shapes and
capability mapping) for one social platform. The Web Admin and MCP layers call
shared application logic rather than these adapters directly; the adapters define
the stable contracts those layers depend on.

:mod:`social_mcp.platforms.mapping` normalizes platform/HTTP/OAuth failures into
the stable MCP error categories shared by the MCP tool layer and the Web Admin,
keeping provider details in adapter boundaries and redacting secrets.
"""
