# Docker deployment on N150

This document describes how to run Social MCP as a single Docker workload on the
N150 Linux host. The service is packaged as one container that contains the
FastAPI HTTP layer, the MCP endpoint, and the Web Admin. Persistent data and all
secrets live outside the disposable container filesystem.

## Prerequisites

- Docker Engine with Compose V2.24 or later on the N150 host
- A strong, unique token encryption key (generated once per deployment)
- (Later) Meta and TikTok OAuth credentials, when connecting accounts

## Repository layout

```text
Dockerfile          # multi-stage build: builder + minimal runtime, non-root user
compose.yaml        # single app service, persistent volume, healthcheck, restart policy
.env.example        # template for non-secret runtime values
```

## Step 1 — Generate the token encryption key

The key protects every OAuth token at rest. It must never be committed to Git
or baked into the image. Generate a strong random key and export it from the
host or your secret manager before starting the service:

```bash
export TOKEN_ENCRYPTION_KEY="$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
```

An alternative is to keep the key in a file outside Git and point the
application at it with `TOKEN_ENCRYPTION_KEY_FILE`:

```bash
mkdir -p secrets
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" \
  > secrets/token_encryption_key
# Then set TOKEN_ENCRYPTION_KEY_FILE=secrets/token_encryption_key (or mount it).
```

Verify the file is ignored by Git:

```bash
git check-ignore secrets/token_encryption_key   # prints the path when ignored
```

The repository `.gitignore` excludes `.env`, `secrets/`, `*.db`, and all
Python/runtime artifacts. Rotate the key before storing any account; tokens
encrypted with a key cannot be decrypted with a different one.

## Step 2 — Configure non-secret values

Copy the env template and adjust as needed. None of these values are secret:

```bash
cp .env.example .env
# Edit .env: set APP_NAME, ENVIRONMENT, DATABASE_URL as required.
```

If your deployment stores the database on the host instead of a named volume,
set `DATABASE_URL` accordingly, for example:

```text
DATABASE_URL=sqlite:////srv/social-mcp/data/social-mcp.db
```

OAuth credentials (`META_APP_ID`, `META_APP_SECRET`, `TIKTOK_CLIENT_KEY`,
`TIKTOK_CLIENT_SECRET`) are also placed in `.env`. They are configuration
identifiers rather than long-lived secrets, but keep `.env` out of Git regardless.

## Step 3 — Start the service

```bash
docker compose up --build -d
```

Verify health and readiness:

```bash
docker compose ps            # container should reach "healthy"
docker compose logs --follow
```

The HTTP layer is published on the host at `http://127.0.0.1:8000` by default.
The `/health` endpoint reports `ok` only when the SQLite account store is
reachable, so a healthy status means the persistent data is mounted correctly.

The initial Web Admin entry points are `/admin/dashboard` and `/admin/accounts`.
They remain unavailable until `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and
`ADMIN_SESSION_SECRET` are all set in the runtime environment or the untracked
`.env` file. When any of these is missing, every `/admin` request (including
login) is rejected with `503 Service Unavailable`, so the admin surface can
never be exposed accidentally.

The admin authenticates with HTTP Basic credentials, but access to every
`/admin` route is gated on a signed session cookie rather than on per-request
credentials. The cookie is `HttpOnly` and `SameSite=Lax`, and is `Secure`
(only sent over HTTPS) unless `ENVIRONMENT=development`. `ADMIN_SESSION_SECRET`
signs that cookie; it must never be committed. `/health` does not require admin
credentials and remains suitable for container health checks.

### Local development

For local development on localhost, set the three values in `.env` (or export
them) with throwaway values:

```bash
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD="example-secret"
export ADMIN_SESSION_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(64))')"
export ENVIRONMENT=development
```

In development mode the session cookie is not marked `Secure` so it can be
used over plain HTTP on localhost. Log in at `http://127.0.0.1:8000/admin/login`
with the credentials above; authenticated navigation is then available at
`/admin/dashboard` and `/admin/accounts`. Keep the service bound to localhost
and use HTTPS (and a non-development `ENVIRONMENT`) before exposing it remotely.

For a deployment, source a strong random `ADMIN_SESSION_SECRET` from your
secret manager instead of committing it. A file-based alternative is supported
via `ADMIN_SESSION_SECRET_FILE`, pointing at a file (for example
`secrets/admin_session_secret`) that holds the secret; verify the file is
ignored by Git:

## Persistent token storage strategy

```text
host: social-mcp-data (named volume)
        └── /data/social-mcp.db          # SQLite account store
              ├── connected_accounts     # one row per connected account
              │      ├── access_token_encrypted   (Fernet-encrypted blob)
              │      ├── refresh_token_encrypted  (Fernet-encrypted blob, nullable)
              │      ├── token_expires_at
              │      └── ...metadata (platform, scopes, timestamps)
```

- **Where it lives:** the `social-mcp-data` named volume, mounted at `/data`
  inside the container. It is created by Docker and survives
  `docker compose down` (use `--volumes` to remove it).
- **What is stored:** only the SQLite database file. OAuth access tokens and
  refresh tokens are stored as encrypted blobs; the encryption key is supplied
  through the `TOKEN_ENCRYPTION_KEY` environment variable (interpolated by
  Compose from the host) or `TOKEN_ENCRYPTION_KEY_FILE`, never written to the
  database or the image.
- **Back up the volume** (not the container) to back up connected accounts and
  encrypted tokens. Back up the encryption key separately and securely —
  without it, encrypted tokens are unrecoverable.

## Secrets kept out of the image and repository

| Secret                  | Source                                  | Delivery                         |
| ----------------------- | --------------------------------------- | -------------------------------- |
| `TOKEN_ENCRYPTION_KEY`  | host env / secret manager               | `TOKEN_ENCRYPTION_KEY` env var (Compose interpolation) |
| `ADMIN_SESSION_SECRET`  | host env / secret manager               | `ADMIN_SESSION_SECRET` / `ADMIN_SESSION_SECRET_FILE` env var |
| OAuth client secrets    | `.env` / host secret manager            | environment variables            |
| OAuth tokens at rest    | encrypted in `social-mcp.db`            | never in Git or the image        |

`compose.yaml` requires `TOKEN_ENCRYPTION_KEY` at startup with
`${TOKEN_ENCRYPTION_KEY:?TOKEN_ENCRYPTION_KEY is required}`, so a missing key
fails the container rather than leaving tokens unprotected. The Web Admin
refuses all logins and `/admin` access unless `ADMIN_SESSION_SECRET` is also
present, so a missing secret fails closed rather than leaving the admin open.
No real credential, token, or key is committed.

## Health checks

`compose.yaml` defines a `healthcheck` that calls `/health`. The check runs
only after the account store is initialized, so `healthy` means the
application and its persistent data are both ready. Docker uses this signal
for restarts and readiness:

```yaml
healthcheck:
  test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health').read()"]
  interval: 5s
  timeout: 3s
  retries: 12
  start_period: 5s
```

## Updates and rebuilds

Because the volume is separate from the image, upgrading the container does
not lose account or token data:

```bash
docker compose pull        # if using a remote image
docker compose up -d --build
```

## Cleanup

```bash
docker compose down                       # stop containers, keep data
docker compose down --volumes             # also remove the persistent volume (data loss)
docker compose down --volumes --remove-orphans
```

## CI verification

The GitHub Actions `docker` job builds the image, starts Compose with an
ephemeral encryption key exported in the environment, polls `/health`, runs
`tests/test_ci_container.py` against the live endpoint, and tears down the
environment with `--volumes` in an `always()` step. No live social credentials
are required.
