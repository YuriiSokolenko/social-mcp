# Social MCP

Open-source MCP server connecting AI agents directly to official social-network APIs without paid analytics middleware.

## Goal

```text
ChatGPT / Pi / Codex
        |
       MCP
        |
    Social MCP
        |
   Application Core
    /          \
Threads API   TikTok API

Web Admin ─────┘
```

The first version targets **Threads** and **TikTok**. Instagram can be added later.

## Principles

- Use official platform APIs.
- Keep the service self-hostable.
- Never store OAuth secrets or access tokens in Git.
- Separate read/analytics tools from write/publishing tools.
- Require explicit user intent before publishing, replying, deleting, reposting, or otherwise changing external state.
- Keep platform adapters independent.
- Manage social-account connections through the Web Admin rather than manual token copying.

## Development and releases

`dev` is the GitHub default branch and the integration branch for daily work. Start task branches from `dev`, open implementation pull requests into `dev`, and merge them only after CI and an independent review. Pull requests with `Closes #<issue-number>` close their linked issues when merged into the default branch.

`main` is reserved for future releases. Do not merge Pi task branches into `main` or copy routine development changes there. When releases begin, promote a verified `dev` state through a separate human-reviewed `dev` → `main` pull request, using a merge commit to preserve branch ancestry. Tag the release on `main` after its checks pass. Protect both branches from force pushes and deletion; require the applicable checks and review for merges.

Workflow details and branch protection requirements: [CI and agent workflow rules](docs/CI_RULES.md).

## Confirmed API scope (September 2026)

### Threads

Target the official Threads API and Meta OAuth.

Planned capabilities include connected profile, posts/replies, account/content insights, permitted search and mentions, publishing, replies, quote/repost operations, reply management and deletion.

Exact scopes must be requested only as needed and verified against current Meta requirements during implementation.

### TikTok

Use TikTok Login Kit/API for OAuth and the official Display and Content Posting APIs.

Read-side targets include profile/statistics and accessible video metadata/metrics. Publishing targets include draft upload and Direct Post when the application/account is eligible.

Public Direct Post must **not** be assumed. TikTok review/audit and the required publishing scope may be necessary. The adapter exposes only capabilities actually granted to the connected application.

## Architecture

```text
                         ChatGPT / Pi / Codex
                                  |
                                 MCP
                                  |
                         +------------------+
                         |    Social MCP    |
                         |     Python       |
                         +--------+---------+
                                  |
                         +--------v---------+
                         | Application Core |
                         +---+-----------+--+
                             |           |
                      Threads adapter  TikTok adapter
                             |           |
                        Threads API    TikTok API

Browser
   |
   v
+-------------------+
|     Web Admin     |
+---------+---------+
          |
       FastAPI
          |
  +-------+--------+
  | OAuth / Admin  |
  | Token storage  |
  | Status / Logs  |
  +-------+--------+
          |
        SQLite
```

Initial Python layout:

```text
src/social_mcp/
  server/
  admin/
  auth/
  platforms/
    threads/
    tiktok/
  tools/
    read/
    write/
  storage/
  models/
```

The MCP layer and Web Admin use the same application core. Platform adapters own platform-specific API behavior. OAuth/token persistence belongs to the auth/storage layers rather than MCP tools.

## Web Admin

The initial admin UI should provide:

- Dashboard with service and platform connection status;
- Accounts with **Connect/Reconnect Threads** and later **Connect/Reconnect TikTok**;
- granted permissions/capabilities;
- token expiry/refresh status without exposing token values;
- MCP status;
- operational logs suitable for troubleshooting.

OAuth starts from the Web Admin and returns to a server-side callback. Users should not normally copy access tokens manually.

The first version may serve a small admin UI from the same application/container. A separate frontend service is not required initially.

## HTTP layer

Use **FastAPI** for the Web Admin HTTP surface, OAuth callbacks and admin API.

The MCP protocol remains a separate interface over the same application core. FastAPI is not the business-logic layer.

## Storage

Use **SQLite** initially for local persistent state such as connected accounts, OAuth metadata and token lifecycle information.

OAuth access/refresh tokens must be protected at rest; the database must not contain plaintext tokens merely because it is local. Encryption keys/secrets remain outside the database and outside Git.

PostgreSQL is intentionally deferred until multi-user or operational requirements justify it.

## Authentication and secrets

Runtime configuration will include values such as:

```text
META_APP_ID
META_APP_SECRET
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
TOKEN_ENCRYPTION_KEY
```

Real credentials, encryption keys and OAuth tokens must never be committed. `.env.example` contains names and empty placeholders only; deployment secrets come from environment variables or an appropriate secrets mechanism. See [OAuth and token strategy](docs/oauth.md) for the end-to-end Threads/Meta OAuth flow, required scopes, token lifecycle, and safe local storage.

The Web Admin itself must be authenticated before the service is exposed beyond a trusted local network.

## Deployment target

Initial deployment is a **single Docker workload on the N150 Linux host** containing the Python application, MCP endpoint, FastAPI HTTP layer and Web Admin assets, with persistent SQLite storage mounted outside the disposable container filesystem.

Splitting components into separate services can be done later if needed.


## CI and local checks

CI runs for every push and pull request on a fresh GitHub-hosted runner. It runs
Ruff, pytest, Node workflow checks, and the runner autoscaler checks. A separate
Docker job builds the image, starts Compose with a unique project name and a
temporary encryption key, tests the running HTTP service, and removes its volume
and containers even when a check fails. No Meta or TikTok credentials are needed.

To run the same checks locally with Python 3.12, Node.js and Docker Compose:

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -e . pytest pytest-asyncio ruff
ruff check .
pytest
node --test tests/*.test.mjs
bash tests/test_runner_autoscaler.sh

export TOKEN_ENCRYPTION_KEY="$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
docker compose up --build --wait
port="$(docker compose port app 8000 | awk -F: '{print $NF}')"
CI_BASE_URL="http://127.0.0.1:${port}" python tests/test_ci_container.py
docker compose down --volumes --remove-orphans
```

See [Docker deployment on N150](docs/deploy.md) for production deployment, the persistent token storage strategy, and how secrets are kept out of the image and repository.


## Development phases

1. Define MCP runtime/language and stable Threads tool contract. **Done.**
2. Establish Python/FastAPI application skeleton, SQLite storage and minimal Web Admin shell.
3. Implement Threads OAuth initiated from Web Admin, callback handling, encrypted token persistence and token lifecycle.
4. Implement Threads read-only profile/content tools.
5. Implement Threads insights/search/replies tools.
6. Implement Threads publishing and reply-management tools.
7. Implement TikTok OAuth through Web Admin.
8. Implement TikTok profile/video read tools.
9. Implement TikTok draft upload.
10. Implement TikTok Direct Post after required API access/audit is available.
11. Docker deployment and end-to-end ChatGPT/Pi/Codex tests.
12. Add Instagram adapter if useful.

## Safety model

Read operations can run directly.

External writes—publishing, replying, reposting, deleting content or changing account state—must require explicit user intent before execution.

The Web Admin manages credentials/connections; it does not weaken the confirmation boundary for MCP write tools.

## Phase 1

The first functional milestone is **Threads through the Web Admin**:

```text
Admin login
   -> Connect Threads
   -> OAuth callback
   -> encrypted token storage
   -> connection/capability status
   -> MCP profile/posts
   -> insights/replies/search
   -> publishing
```

## Decisions

Architecture decisions are recorded under `docs/adr/`.

- ADR 0001: Python for the MCP server.

## Status

Architecture and Threads MCP tool contract are defined. No application credentials or platform secrets are stored in this repository.
