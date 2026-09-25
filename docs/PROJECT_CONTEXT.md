# Project Context for Agents

Read this document before planning, implementing, reviewing, or dispatching work in this repository. It describes the product goal and the boundaries that should guide decisions. Consult `README.md` for the fuller product and architecture plan, `docs/threads-tool-contract.md` for the Threads MCP contract, and `docs/CI_RULES.md` for the current CI and agent workflow. A GitHub issue supplies the acceptance criteria for a particular change.

## Why this project exists

Social MCP is a self-hostable service that gives AI assistants a direct, controlled connection to social networks through their official APIs. Its intended clients include ChatGPT, Pi, and Codex. The project aims to let a person inspect accounts, posts, replies, and available insights, and eventually perform explicitly requested publishing and account actions, without depending on a paid analytics middleware service or copying social-network tokens into agent prompts.

## Product scope

- **Threads first:** connect a Threads account through Meta OAuth; expose authorized profile, content, replies, insights, and other permitted read capabilities; later support publishing and reply management where granted.
- **TikTok next:** connect through TikTok Login Kit; expose permitted profile, video, and statistics data; add draft upload and Direct Post only when the application and account have the required access and any necessary review.
- **Instagram later:** consider an independent adapter when the initial platforms are working and the product needs it.
- **Web Admin:** authenticate the administrator, connect or reconnect accounts, display granted capabilities and token status without revealing secrets, and show service status and useful logs.
- **MCP interface:** provide AI clients with separate read and write tools backed by the same application core as Web Admin.

These are product targets, not a claim that every capability is implemented or approved by the platforms. Check current code, tests, issues, and granted API permissions before describing a capability as available.

## Architecture and operation

The service uses Python, FastAPI for the HTTP/admin surface, an MCP interface for AI clients, platform-specific adapters for external APIs, and SQLite for initial persistent state. Transport and admin handlers should call shared application logic; OAuth and token handling belong in the authentication/storage layers. The initial deployment target is one Docker workload on the N150 host, with persistent data outside the disposable container filesystem.

The repository also contains a GitHub Actions workflow for implementation and an independent PR review. The Pi implementer changes code and writes tests; the workflow runs deterministic checks and owns commits, branches, PRs, and labels. The Pi reviewer evaluates the PR without editing code. Runner capacity and issue state are described in `docs/CI_RULES.md`; do not infer product capability from a passing CI job.

`dev` is the GitHub default and day-to-day integration branch: Pi issue branches start there and reviewed implementation PRs merge there. `main` is held for future releases; a release promotion is a separate CI-checked, human-reviewed PR from `dev` to `main` merged with a merge commit. Do not send routine task PRs to `main`.

## Non-negotiable product rules

1. Use official platform APIs and expose only operations authorized for the connected account and application.
2. Never commit, reveal, or log OAuth tokens, client secrets, encryption keys, cookies, or authorization headers.
3. Keep persisted tokens encrypted at rest, with the encryption key outside the database and Git.
4. Require explicit user intent for external writes: publishing, replying, reposting, deleting, or changing account state. A connected account alone does not authorize such actions.
5. Keep platform adapters independent and keep the MCP and HTTP layers thin.
6. Use mocked API boundaries in automated tests; tests must not publish content or call production social-network APIs.
7. Treat GitHub issues as the request for a specific change. This document guides interpretation but does not add unrequested scope to an issue.

## How agents should use this document

- **Implementer:** read it before the issue; preserve the product boundaries while implementing the issue and its tests.
- **Reviewer:** read it before reviewing the issue and diff; use it to identify product, architecture, and security regressions.
- **Dispatcher:** read it before classifying eligible issues for implementation or decomposition; use task descriptions and issue state for priority and eligibility, and do not reinterpret the roadmap as permission to launch unrequested work.
- **Architect:** read it before breaking an explicitly queued broad issue into independently reviewable tasks, then return them to the dispatcher with dependencies.
- **Triage:** read it before deciding whether an open issue is complete and clear enough to enter the dispatcher queue; when it is not, explain the gap in a comment rather than guessing at the missing scope.

If this document disagrees with current executable code or a platform's granted capabilities, investigate and report the discrepancy. If a product decision changes, update this document and the more detailed source documents together.
