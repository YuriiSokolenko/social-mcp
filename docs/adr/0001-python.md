# ADR 0001: Python for the MCP server

- Status: Accepted
- Date: 2026-09-23

## Context

Social MCP is primarily an I/O-bound integration service. Its core work is MCP tool handling, OAuth/token management, HTTP calls to Threads/TikTok APIs, validation, and JSON responses. Heavy computation is not part of the initial server.

The project may later add social analytics and media/text processing, where the Python ecosystem is useful.

## Decision

Use Python as the implementation language.

Initial stack:

- Python 3.12+
- official MCP Python SDK / FastMCP API
- Pydantic for typed models and validation
- httpx for asynchronous HTTP
- pytest for tests
- Docker for deployment

Do not introduce FastAPI or another web framework until a concrete requirement (for example an OAuth callback endpoint) justifies it.

## Consequences

The first implementation can remain small and async. Platform adapters stay independent from MCP tool definitions. Type hints and Pydantic provide explicit API contracts. Deployment remains suitable for the N150 Linux host.

If remote HTTP transport or OAuth callbacks later need a dedicated web layer, it can be added without changing the platform adapter interfaces.
