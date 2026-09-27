# CI architecture

The control plane intentionally uses a simple contract:

1. An implementation agent finishes an issue and publishes a PR.
2. Merge Gate validates only that the PR belongs to the expected issue/repository, is not a draft, and does not modify protected control-plane files.
3. Merge Gate squash-merges the PR into `dev`.
4. The normal `push` CI runs on the resulting merged `dev` commit.
5. Green CI means the merged result is accepted. A red CI is handled as a post-merge failure; it must not be converted into a pre-merge state machine.

## Complexity guard

Do not reintroduce pre-merge exact-pair orchestration.

In particular, the merge decision must not depend on a captured dev SHA, `integration_base_sha`, `repair_base_sha`, synthetic dev+PR merge commits, SHA/base-bound status contexts, or a pre-merge CI/review/repair chain.

A PR head SHA may still be supplied to GitHub's merge API as normal optimistic concurrency protection. That is not pipeline state.

Prefer GitHub's own merge operation and the ordinary CI run on `dev` over custom synchronization/state. If a new requirement appears, first try to express it as a post-merge `dev` CI check or a simple issue/PR state instead of adding another orchestration layer.
