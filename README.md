# Social MCP

Open-source MCP server connecting AI agents directly to official social-network APIs without a paid analytics middleware.

## Goal

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
- Require explicit user intent before publishing, replying, deleting, reposting, or otherwise changing external state.
- Keep platform adapters independent.

## Confirmed API scope (September 2026)

### Threads

Target the official Threads API and Meta OAuth.

Planned capabilities:

- connected profile;
- posts and replies;
- account/content insights;
- keyword search where permitted;
- mentions where permitted;
- text publishing;
- image/video/carousel publishing;
- replies;
- quote/repost operations where supported;
- reply management;
- deletion where permitted.

Expected permissions include the relevant Threads scopes such as basic access, content publishing, replies and insights. Exact scopes must be requested only as needed and verified against current Meta requirements during implementation.

### TikTok

Use TikTok Login Kit/API for OAuth and the official Display and Content Posting APIs.

Read-side targets:

- profile;
- profile statistics;
- accessible/public videos;
- available video metadata and metrics.

Publishing targets:

- draft upload when permitted;
- Direct Post when the app/account is eligible.

Public Direct Post must **not** be assumed. TikTok application review/audit and the required publishing scope may be necessary. An unaudited client may have visibility and usage restrictions. The adapter must expose only capabilities actually granted to the connected application.

## Proposed architecture

```text
src/
  server/
  auth/
  platforms/
    threads/
    tiktok/
  tools/
    read/
    write/
  storage/
```

The MCP layer exposes a stable tool interface. Platform adapters own API-specific OAuth, permissions, pagination, rate limits, token refresh and error mapping.

## Authentication and secrets

Runtime configuration will eventually include values such as:

```text
META_APP_ID
META_APP_SECRET
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
```

Real credentials and OAuth tokens must never be committed. A later `.env.example` will contain names/placeholders only. Deployment secrets should come from environment variables or an appropriate secrets mechanism.

## Deployment target

The service should run as a small Docker workload on Linux, with the N150 host as the initial deployment target.

Remote exposure is separate from the MCP implementation and must be authenticated.

## Development phases

1. Define MCP runtime/language and stable tool contract.
2. Threads OAuth and token lifecycle.
3. Threads read-only profile/content tools.
4. Threads insights/search/replies tools.
5. Threads publishing and reply-management tools.
6. TikTok OAuth and token lifecycle.
7. TikTok profile/video read tools.
8. TikTok draft upload.
9. TikTok Direct Post after required API access/audit is available.
10. Persistent token storage, Docker deployment and end-to-end ChatGPT/Pi/Codex tests.
11. Add Instagram adapter if useful.

## Safety model

Read operations can run directly.

External writes—publishing, replying, reposting, deleting content or changing account state—must require explicit user intent before execution.

## Phase 1

The first implementation milestone is **Threads**: OAuth → read profile/posts → insights/replies/search → publishing.

## Status

API capabilities reviewed for the initial design. No application credentials or platform secrets are stored in this repository.
