"""Platform adapters for official social-network APIs.

Each sub-package owns the platform-specific behaviour (OAuth, API shapes and
capability mapping) for one social platform. The Web Admin and MCP layers call
shared application logic rather than these adapters directly; the adapters define
the stable contracts those layers depend on.
"""
