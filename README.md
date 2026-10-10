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

Current automation lifecycle, ownership, CI gates, recovery, and branch safety: **[Workflow and CI maintainer guide](docs/CI_RULES.md)**. N150 worker deployment and capacity: [runner/autoscaler operations](infra/github-runner-autoscaler/README.md). Dated investigations under `docs/llm-research/`, `docs/agent-harness/experiments/`, and `docs/releases/` are historical, not live runbooks.

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

Current Python layout:

```text
src/social_mcp/
  app.py          # FastAPI app: /health, Web Admin routers, session middleware
  config.py       # environment settings (pydantic-settings)
  container.py    # application container shared by HTTP and MCP entry points
  server/         # MCP server (stdio entry point: python -m social_mcp.server), tools, errors, capabilities
  admin/          # Web Admin routes: login, dashboard, accounts, logs, Threads connect/callback
  auth/           # OAuth state signing, token encryption
  platforms/      # shared HTTP reliability and error mapping
    threads/      # Threads OAuth + read API adapter
    tiktok/       # TikTok OAuth/capability contract (no Web Admin flow yet)
  storage/        # SQLite connected-account store and models
  diagnostics/    # request-id log filter and smoke helpers
```

The MCP layer and Web Admin use the same application container. Platform adapters own platform-specific API behavior. OAuth/token persistence belongs to the auth/storage layers rather than MCP tools.

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

Runtime configuration (see `src/social_mcp/config.py` and `.env.example`) includes:

```text
TOKEN_ENCRYPTION_KEY       # required at startup (or TOKEN_ENCRYPTION_KEY_FILE)
ADMIN_USERNAME
ADMIN_PASSWORD
ADMIN_SESSION_SECRET       # or ADMIN_SESSION_SECRET_FILE
OAUTH_STATE_SECRET         # or OAUTH_STATE_SECRET_FILE
META_APP_ID
META_APP_SECRET
THREADS_REDIRECT_URI       # optional; defaults to the development callback
THREADS_SCOPES             # optional; threads_basic is always included
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
DATABASE_URL
```

Real credentials, encryption keys and OAuth tokens must never be committed. `.env.example` contains names and empty placeholders only; deployment secrets come from environment variables or an appropriate secrets mechanism. See [OAuth and token strategy](docs/oauth.md) for the end-to-end Threads/Meta OAuth flow, required scopes, token lifecycle, and safe local storage.

The Web Admin itself must be authenticated before the service is exposed beyond a trusted local network.

## Deployment target

Initial deployment is a **single Docker workload on the N150 Linux host** containing the Python application, FastAPI HTTP layer and Web Admin, with persistent SQLite storage mounted outside the disposable container filesystem. The MCP server currently uses the **stdio** transport (`python -m social_mcp.server`); there is no HTTP MCP endpoint yet.

Splitting components into separate services can be done later if needed.


## CI and local checks

`ci.yml` runs on pull requests targeting `dev`, on pushes to `dev`, and on manual dispatch, using N150 self-hosted `general` runners (same-repository PRs only). No Meta or TikTok credentials are needed. Its jobs are split along the [harness extraction boundary](docs/agent-harness/EXTRACTION.md), so either half can be removed without editing the other.

### Product checks

The `test` job runs Ruff and pytest. The `docker` job builds the image, starts Compose with a unique project name and a temporary encryption key, tests the running HTTP service, and removes its volume and containers even when a check fails.

To run the same checks locally with Python 3.12 and Docker Compose:

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -e . pytest==9.1.1 pytest-asyncio==1.4.0 ruff==0.17.0 PyYAML==6.0.3
ruff check .
pytest

export TOKEN_ENCRYPTION_KEY="$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
docker compose up --build --wait
port="$(docker compose port app 8000 | awk -F: '{print $NF}')"
CI_BASE_URL="http://127.0.0.1:${port}" python tests/test_ci_container.py
docker compose down --volumes --remove-orphans
```

See [Docker deployment on N150](docs/deploy.md) for production deployment, the persistent token storage strategy, and how secrets are kept out of the image and repository.

### Agent harness checks

The `harness` job runs the Node control-plane contract tests, the harness Python checks and the runner-autoscaler checks without installing the product package. The `harness-images` job builds and smoke-tests the runner images. A completed same-repository PR CI run wakes Merge Gate through `ci-terminal-wake.yml` on the dedicated `control` runner, and Merge Gate merges only a PR whose current HEAD has green PR CI. A green `dev` CI run wakes Merge Gate for the next eligible reviewed PR; a red run stops that merge sequence. Pi product agents run their own pre-publication product checks, but CI on the actual merged `dev` commit is the integration truth. See [Workflow and CI](docs/CI_RULES.md).

```bash
node --test tests/*.test.mjs
pytest --noconftest -p no:cacheprovider tests/test_run_check_sandbox_exec.py tests/n150_docker_upgrade tests/workflow_smoke tests/ci/test_workflow_integrity.py
bash tests/test_runner_autoscaler.sh
```

CI additionally installs `typebox` into a temporary prefix and runs `tests/ci/pi-implementer-typebox-schema-contract.test.mjs` with `PI_TYPEBOX_PACKAGE_ROOT` pointing at it; see the `harness` job in `.github/workflows/ci.yml`.

## Development phases

1. Define MCP runtime/language and stable Threads tool contract. **Done.**
2. Establish Python/FastAPI application skeleton, SQLite storage and minimal Web Admin shell. **Done.**
3. Implement Threads OAuth initiated from Web Admin, callback handling, encrypted token persistence and token lifecycle. **Done except token lifecycle (#17).**
4. Implement Threads read-only profile/content tools. **Done (#3).**
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

Implemented today: authenticated Web Admin (login, dashboard, accounts, logs, disconnect), Threads OAuth connect/callback with signed state and encrypted token storage, and the MCP read tools `threads_capabilities`, `threads_get_profile`, `threads_list_posts` and `threads_get_post`. Token refresh, Threads insights/replies/search/publishing and all TikTok operations are not implemented yet; [PROJECT_MAP](docs/architecture/PROJECT_MAP.md) tracks status per issue. No application credentials or platform secrets are stored in this repository.
