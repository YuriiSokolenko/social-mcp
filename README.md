# Social MCP

Open-source MCP server for connecting AI agents directly to social-network APIs without a paid analytics middleware.

## Goal

Provide a small self-hosted bridge:

```text
ChatGPT / Pi / Codex
        |
       MCP
        |
    Social MCP
     /      \
Threads API  TikTok API
```

The first version targets **Threads** and **TikTok**. Instagram can be added later.

## Principles

- Use official platform APIs.
- Keep the MCP server self-hostable.
- Never store OAuth secrets or access tokens in Git.
- Separate read/analytics tools from write/publishing tools.
- Require explicit confirmation before publishing, replying, deleting, or otherwise changing external state.
- Keep platform adapters independent so additional social networks can be added later.

## MVP

### Threads

Initial target capabilities:

- authenticate with Meta OAuth;
- read the connected profile;
- read posts;
- read replies where permitted;
- read available insights;
- create text posts;
- create media posts where supported;
- reply to posts;
- expose these operations as MCP tools.

### TikTok

Initial target capabilities:

- authenticate with TikTok OAuth;
- read profile information;
- list accessible videos;
- read available video/profile metrics;
- investigate Content Posting API permissions and expose publishing only when the application/account is eligible;
- expose supported operations as MCP tools.

TikTok publishing must not be assumed to be available until the application's API access and permissions are verified.

## Proposed architecture

```text
src/
  server
  auth/
  platforms/
    threads/
    tiktok/
  tools/
  storage/
```

The MCP layer should expose a stable interface while each platform adapter handles its own API, permissions, pagination, rate limits and token refresh.

## Authentication and secrets

Local/runtime configuration will contain values such as:

```text
META_APP_ID
META_APP_SECRET
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
```

Real credentials and OAuth tokens must be excluded from the repository. A later `.env.example` will contain names/placeholders only.

For deployment, secrets should come from environment variables or a secrets mechanism rather than source control.

## Deployment target

The server should run comfortably as a small Docker service on a local Linux machine such as the existing N150 host.

Remote access, if needed, should be added separately from the MCP implementation and protected with authentication.

## Development phases

1. Verify current official Threads and TikTok API requirements and permissions.
2. Choose the MCP runtime/language and define the tool contract.
3. Implement Threads OAuth and read-only tools.
4. Implement Threads publishing tools.
5. Implement TikTok OAuth and read-only tools.
6. Add TikTok publishing only if approved API capabilities allow it.
7. Add token persistence/refresh and Docker deployment.
8. Connect ChatGPT/Pi/Codex and run end-to-end tests.
9. Add Instagram as a separate adapter if useful.

## Safety model

Read operations can run directly.

External write operations such as publishing a post, replying, deleting content, or changing account state should require explicit user intent before execution.

## Status

Initial architecture defined. No application credentials or platform secrets are stored in this repository.
