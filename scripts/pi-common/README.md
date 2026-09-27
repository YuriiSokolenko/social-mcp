# Pi common trusted helpers

This directory contains reusable **trusted CI control-plane primitives** shared by multiple Pi pipeline stages.

## Why this directory exists

Workflow YAML should describe orchestration: checkout trusted `dev`, call a stage, run the model when needed, publish the result, clean up. It should not contain copies of GitHub REST pagination, pipeline-state mutation, path-security rules, product validation, or other policy.

Keeping those rules here gives us one implementation to test and one place to explain why a rule exists.

## What belongs here

A module belongs here only when the same trusted rule is useful to more than one pipeline stage and has no agent-specific decision logic.

- `github-api.mjs` — authenticated repository API + complete pagination.
- `github-state.mjs` — compare-and-swap style label/state replacement.
- `state-machine.mjs` — canonical issue pipeline labels and legal transitions.
- `task-metadata.mjs` — canonical GitHub issue task metadata parser/writer.
- `queue-context.mjs` — shared read-only queue snapshot construction.
- `recovery-policy.mjs` — small deterministic recovery decisions.
- `control-plane-policy.mjs` — single security boundary for files Pi agents must never change/review/repair/auto-merge.
- `bash-timeout-policy.mjs` / `loop-guard-policy.mjs` — reusable model tool safety limits.
- `product-checks.mjs` — authoritative product-code deterministic checks used before publication/review.
- `pr-guard.mjs` — loads the complete PR state/file list and enforces the pre-model human/control-plane gate.
- `issue-context.mjs` — performs the Implementer's one fresh issue read and validates `open + pi:ready` before model work.
- `issue-worktree.mjs` — creates/resumes/cleans the Implementer's latest-`dev` worktree without treating saved work as a base branch.
- `issue-publication.mjs` — safely checkpoints and publishes verified issue work, upserts its PR, and hands the PR to Reviewer.

## What does NOT belong here

Dispatcher classification, Architect decomposition, Reviewer verdict parsing, repair strategy, merge selection, and Reconciler orchestration remain stage-specific. Do not turn this directory into a framework.

## Trust rule

These files are part of the CI control plane. Pi agents have no permission to modify them. They are protected by `control-plane-policy.mjs` through the `scripts/pi-*` boundary because this directory itself is under `scripts/pi-common/**`.

Prefer a small explicit helper with comments and tests over copying shell/API logic into multiple workflows.
