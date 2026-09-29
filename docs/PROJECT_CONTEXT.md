# Project Context

This is **on-demand product context**, not a mandatory startup document for every agent turn. The GitHub issue defines the requested change. Read this file only when product scope, architecture, security, or platform intent is relevant to a concrete decision. CI behavior belongs in `docs/CI_RULES.md`; detailed product/API contracts belong in their dedicated documents.

## Product goal

Social MCP is a self-hostable service that connects AI assistants to official social-network APIs without paid analytics middleware or copying platform tokens into prompts.

Target direction:
- Threads first: OAuth, authorized profile/content/replies/insights, then permitted write operations.
- TikTok next: Login Kit, permitted profile/video/statistics, then publishing capabilities only when granted.
- Instagram later if product needs justify another adapter.
- Web Admin manages account connections, capability/token status, service status, and operational diagnostics without revealing secrets.
- MCP exposes separate read/write tools backed by the same application core.

These are targets, not proof that a capability is currently implemented or platform-approved. Current code, tests, issues, and granted permissions are authoritative for current capability.

## Architecture

The service uses Python, FastAPI for HTTP/admin, MCP for AI clients, platform-specific adapters, and SQLite for initial persistence. Keep transport/admin layers thin, shared application logic central, and OAuth/token handling in auth/storage boundaries. Initial deployment is one Docker workload with persistent data outside the disposable container.

`dev` is the default development/integration branch. `main` is reserved for future human-reviewed releases.

## Product invariants

1. Use official platform APIs and expose only authorized capabilities.
2. Never commit, reveal, or log OAuth tokens, client secrets, encryption keys, cookies, or authorization headers.
3. Persist tokens encrypted at rest with keys outside the database and Git.
4. Require explicit user intent for external writes such as publishing, replying, reposting, deleting, or account-state changes.
5. Keep platform adapters independent and MCP/HTTP layers thin.
6. Mock external API boundaries in automated tests; never publish content or call production social APIs from tests.
7. The issue defines requested scope. Product context constrains implementation; it does not authorize extra roadmap work.

## When to consult more context

Use `README.md` for the broader product/architecture overview, `docs/architecture/PROJECT_MAP.md` for the current text architecture/component map, `docs/threads-tool-contract.md` for the Threads MCP contract, `docs/oauth.md` for OAuth/token behavior, and `docs/CI_RULES.md` for pipeline/control-plane rules.

Agents should load only the documents relevant to the decision at hand. Dispatcher/Triage normally need issue/queue data, not product architecture. Implementer/Reviewer/Repair need product context only when the changed behavior touches those boundaries. Architect needs it only when decomposition depends on product or architectural constraints.

If documentation conflicts with executable behavior or granted platform capability, do not silently assume the document is current; resolve or report the discrepancy.

When a change adds/removes a high-level component, changes architectural ownership, or materially changes a relationship shown in `docs/architecture/PROJECT_MAP.md`, update that text map in the same PR. Ordinary local implementation changes do not require map churn.
