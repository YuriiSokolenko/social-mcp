# OAuth and token strategy

This document describes how Social MCP connects a Threads account through the
official Meta OAuth flow, and how the resulting tokens are kept safe at rest.
The current implementation covers configuration only; the
callback route, state validation and code exchange, and token lifecycle are
tracked in issues [#15](https://github.com/social-mcp/social-mcp/issues/15)
(state validation and callback handling), [#16](https://github.com/social-mcp/social-mcp/issues/16)
(token exchange), and [#17](https://github.com/social-mcp/social-mcp/issues/17)
(token lifecycle), respectively.

Verified against the official Meta/Threads documentation as of September 2026.
Meta may evolve endpoint paths, versions and scopes, so re-verify against
`developers.facebook.com/docs/threads` before relying on a specific value in
production.

## Configuration

All Meta/Threads values are read from environment variables and resolved in
`src/social_mcp/config.py` (`Settings`). They are never sent to the browser and
never baked into the image.

| Variable              | Purpose                                                  | Where it comes from                         |
| --------------------- | -------------------------------------------------------- | ------------------------------------------- |
| `META_APP_ID`         | The Threads App ID used as `client_id` in the OAuth flow. | Meta for Developers App Dashboard > Basic > Threads App ID. |
| `META_APP_SECRET`     | The Threads App Secret used as `client_secret` in the token exchange. | Meta for Developers App Dashboard > Basic > Threads App secret. |
| `TOKEN_ENCRYPTION_KEY`| Fernet key that encrypts every OAuth token at rest.     | Generated once per deployment; see [Safe local storage](#safe-local-storage). |
| `OAUTH_STATE_SECRET`  | Secret that signs the per-flow `state` parameter (issue #15). | Generated per deployment; never committed. |

`META_APP_ID` and `META_APP_SECRET` are documented as empty placeholders in
`.env.example` and supplied from the runtime environment or a secret manager.
`TOKEN_ENCRYPTION_KEY` is **required at startup**: `compose.yaml` refuses to
start without it (`${TOKEN_ENCRYPTION_KEY:?...}`), so tokens can never be
written unprotected.

## The OAuth authorization-code flow

Social MCP uses the standard authorization-code flow. The Web Admin initiates
it from the protected Accounts page, the browser takes the user to Meta, and
Meta redirects back to a server-side callback where the code is exchanged for a
token. Users never copy tokens by hand.

### 1. Build the authorization URL

Send the user's browser to the authorization window:

```text
https://threads.com/oauth/authorize
  ?client_id=<META_APP_ID>
  &redirect_uri=<THREADS_REDIRECT_URI>
  &scope=<THREADS_SCOPES>
  &response_type=code
  &state=<STATE>
```

| Parameter      | Notes                                                                 |
| -------------- | --------------------------------------------------------------------- |
| `client_id`    | `META_APP_ID`.                                                        |
| `redirect_uri` | Must exactly match one of the app's registered valid OAuth URIs. The default development callback is `http://127.0.0.1:8000/admin/oauth/callback/threads` (added to the App Dashboard list). |
| `scope`        | Comma-separated list of permissions. `threads_basic` is **required** and cannot be removed. |
| `response_type`| Set to `code`.                                                        |
| `state`        | A strong, unpredictable value bound to the initiating admin session. See [issue #15](https://github.com/social-mcp/social-mcp/issues/15) for the state implementation. Protects against CSRF. |

### 2. Required minimum scopes

`threads_basic` is **always required** and cannot be removed. Only request the
additional scopes the application actually needs; Meta grants them per user at
authorization time and they can be revoked later.

| Scope                       | Purpose                              | In scope of this issue? |
| --------------------------- | ------------------------------------ | ----------------------- |
| `threads_basic`             | Required. Read the connected profile.| Yes (required)        |
| `threads_read_replies`      | Read replies to the user's posts.    | No (read tools, later) |
| `threads_content_publish`   | Publish, reply to, and delete posts.| No (write tools, later)|
| `threads_manage_replies`    | Moderate/manage replies.             | No (moderation, later) |
| `threads_manage_insights`   | Read account/content insights.       | No (insights, later)   |
| `threads_delete`            | Delete posts.                        | No (later)             |
| `threads_keyword_search`    | Keyword search.                      | No (later)             |
| `threads_location_tagging`  | Location tagging on posts.           | No (later)             |
| `threads_manage_mentions`   | Manage mentions.                     | No (later)             |
| `threads_profile_discovery` | Profile discovery/search.            | No (later)             |

A sensible default for read-only profile use is `threads_basic`. Publishing and
reply management add `threads_content_publish` and the reply scopes. The full,
current set evolves with the API, so always re-check
`developers.facebook.com/docs/permissions` before requesting scopes.

### 3. Handle the callback

After the user allows (or denies) permission, Meta redirects to the registered
`redirect_uri` (handled in issue #15).

- **Success:** the redirect carries a `code` parameter. Note that Meta appends
  `#_` to the redirect URI; this fragment is **not** part of the code and must
  be stripped. An authorization code is valid for **1 hour** and can only be
  used **once**.

  ```text
  http://127.0.0.1:8000/admin/oauth/callback/threads?code=AQBx-hBsH3...#_
  ```

- **Cancellation:** the redirect carries an error instead of a code. Fail
  gracefully with an appropriate message.

  ```text
  ?error=access_denied
  &error_reason=user_denied
  &error_description=The+user+denied+your+request
  ```

The callback **must first validate the `state`** value (issue #15) before
exchanging the code. A mismatched or expired state is rejected and the code is
discarded, so a forged or replayed callback cannot proceed to a token exchange.

### 4. Exchange the code for a short-lived token

The code is exchanged server-side (issue #16) with a `POST` request that
**includes the App Secret**, so this step must never happen in the browser or
an image layer:

```text
POST https://graph.threads.com/oauth/access_token
Content-Type: application/x-www-form-urlencoded

client_id=<META_APP_ID>
&client_secret=<META_APP_SECRET>
&grant_type=authorization_code
&redirect_uri=<THREADS_REDIRECT_URI>   # must match the one sent to authorize
&code=<AUTHORIZATION_CODE>
```

Success returns the short-lived user access token, its type, and the Threads
user id:

```json
{
  "access_token": "THQVJ...",
  "token_type": "bearer",
  "user_id": 17841405793187218
}
```

A rejected request (e.g. a code that was already used or not found) returns an
error payload rather than a token. The `access_token` is then encrypted with
`TOKEN_ENCRYPTION_KEY` and persisted; the plaintext code and short-lived token
are never stored.

### 5. Long-lived token lifecycle

Short-lived tokens are valid for only **1 hour**. Social MCP exchanges the
short-lived token for a **long-lived token** immediately after a successful code
exchange, then refreshes it on a schedule (issue #17). Long-lived tokens are
valid for **60 days** and are refreshed server-side.

**Exchange a short-lived token for a long-lived token:**

```text
GET https://graph.threads.com/access_token?
  grant_type=th_exchange_token
  &client_secret=<META_APP_SECRET>
  &access_token=<SHORT_LIVED_ACCESS_TOKEN>
```

Response:

```json
{
  "access_token": "<LONG_LIVED_USER_ACCESS_TOKEN>",
  "token_type": "bearer",
  "expires_in": 5183944   // ~60 days, in seconds
}
```

**Refresh a long-lived token** (`GET /refresh_access_token`) before it expires.
Refreshing re-issues a token valid for another 60 days from the refresh date:

```text
GET https://graph.threads.com/refresh_access_token?
  grant_type=th_refresh_token
  &access_token=<LONG_LIVED_ACCESS_TOKEN>
```

```json
{
  "access_token": "<LONG_LIVED_USER_ACCESS_TOKEN>",
  "token_type": "bearer",
  "expires_in": 5183944
}
```

Refresh rules:

- A long-lived token can be refreshed while it is **at least 24 hours old**
  and **not yet expired**. Refresh early (well before expiry) to tolerate
  clock skew and downtime.
- Each refresh re-extends the token to 60 days from the refresh date.
- A token that has **not been refreshed within 60 days** expires and can no
  longer be refreshed; the user must reconnect the account.
- For **private** profiles, granted permissions are valid for 90 days from the
  last authorization.
- Refreshes require the `access_token` only (not the App Secret) and must be
  made server-side.
- Expired short-lived tokens **cannot** be exchanged for a long-lived token;
  reconnect the account to obtain a fresh short-lived token.

The token lifecycle implementation (atomic encrypted updates of the stored
access/refresh token and `expires_at`, reconnect-on-failure, and safe admin
status reporting) belongs to issue #17.

## Safe local storage

OAuth tokens are persisted to the SQLite account store (`social-mcp.db`) as
encrypted blobs, never in plaintext. The strategy has two independent parts:
the encryption key and the encrypted data, each kept out of Git by a different
mechanism.

- **Encrypted at rest.** Every access token and refresh token is encrypted with
  Fernet (`cryptography.fernet`) using `TOKEN_ENCRYPTION_KEY`. The encrypted
  bytes live in the `access_token_encrypted` / `refresh_token_encrypted` columns
  of the `connected_accounts` table; the plaintext token is never written to
  disk. The encryption boundary lives in `src/social_mcp/auth/token_cipher.py`
  and is wired through `src/social_mcp/container.py`.
- **Key outside the database.** `TOKEN_ENCRYPTION_KEY` is supplied at runtime
  from the host environment or a file (`TOKEN_ENCRYPTION_KEY_FILE`) and is
  **never** stored in the database or the image. Rotating the key before any
  account is stored makes encrypted values unrecoverable, so back up the key
  separately and securely.
- **Data outside the code.** The SQLite database itself is a persistent volume
  (`social-mcp-data` mounted at `/data` in `compose.yaml`), separated from the
  disposable container filesystem. Upgrading the image does not touch it. Back
  up the volume (not the container) to back up accounts and encrypted tokens.
- **Distinct secrets per concern.** `TOKEN_ENCRYPTION_KEY` (token encryption),
  `OAUTH_STATE_SECRET` (OAuth state signing, issue #15), and
  `ADMIN_SESSION_SECRET` (Web Admin session cookies) each have a distinct
  purpose and must never be reused across concerns or committed to Git.

## Secrets kept out of Git

The repository never contains OAuth tokens, client secrets, or encryption keys.
Concretely:

- `.env.example` lists variable names with **empty** placeholder values only.
- `.gitignore` excludes `.env`, `secrets/`, `*.db`, and all Python and runtime
  artifacts; `.dockerignore` excludes the same so nothing secret reaches the
  image.
- `compose.yaml` requires `TOKEN_ENCRYPTION_KEY` at startup and interpolates it
  from the host rather than baking it into the image.
- The Web Admin refuses all logins and `/admin` access unless
  `ADMIN_SESSION_SECRET` is also present, so a missing secret fails closed.

Generate a per-deployment key once and keep it out of Git:

```bash
export TOKEN_ENCRYPTION_KEY="$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
```

## What is already done and what comes next

| Concern                         | Status        | Tracked by |
| ------------------------------- | ------------- | ---------- |
| Meta app config and OAuth docs  | Documented here (issue #2) | #2 |
| OAuth `state` minting/validation | Implemented   | #15 |
| Callback handling and state validation | Pending    | #15 |
| Token exchange (code exchange) | Pending    | #16 |
| Token persistence (encrypted) and lifecycle | Pending | #17 |

This issue is documentation and configuration only. The callback route and
state validation are tracked in [#15](https://github.com/social-mcp/social-mcp/issues/15),
token exchange in [#16](https://github.com/social-mcp/social-mcp/issues/16), and encrypted
persistence and refresh behavior in [#17](https://github.com/social-mcp/social-mcp/issues/17),
which follow the boundaries documented here.
