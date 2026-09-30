# Pi common trusted helpers

This directory contains reusable **trusted CI control-plane primitives** shared by multiple Pi pipeline stages.

## Why this directory exists

Workflow YAML should describe orchestration: checkout trusted `dev`, call a stage, run the model when needed, publish the result, clean up. It should not contain copies of GitHub REST pagination, pipeline-state mutation, path-security rules, product validation, or other policy.

Keeping those rules here gives us one implementation to test and one place to explain why a rule exists.

## What belongs here

A module belongs here only when the same trusted rule is useful to more than one pipeline stage and has no agent-specific decision logic.

- `github-api.mjs` — authenticated repository API + complete pagination + bounded HTTP requests + tiny shared issue/PR/label/comment/workflow-dispatch/workflow-run/ref primitives; this is the only place that should spell those repeated REST routes.
- `process.mjs` — one bounded synchronous subprocess runner for trusted control-plane helpers.
- `git.mjs` — one bounded Git adapter; authentication is carried in child-process environment configuration, never command-line arguments.
- `github-state.mjs` — compare-and-swap style label/state replacement.
- `state-machine.mjs` — canonical issue pipeline labels and legal transitions.
- `task-metadata.mjs` — canonical GitHub issue task metadata parser/writer.
- `queue-context.mjs` — shared read-only queue snapshot construction.
- `recovery-policy.mjs` — small deterministic recovery decisions.
- `control-plane-policy.mjs` — single security boundary for files Pi agents must never change/review/repair/auto-merge.
- `agent-change-policy.mjs` — lists every path an agent session actually touched (committed, staged, unstaged, and untracked), so control-plane checks see real working-tree changes, not just `HEAD` diffs.
- `finalize-product-tree.mjs` — integrates latest `dev` into the agent's branch, rejects agent changes to control-plane paths via `agent-change-policy.mjs`, and runs the authoritative product checks; shared by the Implementer and PR Fix terminal tools as `validateFinalProductTree()`.
- `bash-timeout-policy.mjs` / `progress-controller.mjs` — reusable model safety state: bounded orientation, complexity declaration, repeat/turn protection, response budgets, single-use startup actions, and the productive-progress state machine (`EVIDENCE_ALLOWED` / `ACTION_REQUIRED`).
- `product-checks.mjs` — authoritative product-code deterministic checks used before publication/review.
- `run-check.mjs` — backend-neutral focused verification (`python_compile`, `ruff`, `pytest`, named `profile`) behind a closed structured contract: worktree-contained paths, no command strings, hard timeout with process-tree kill, allow-listed environment, network/filesystem sandbox, bounded diagnostics + actual stdout/stderr tails. Linux uses bubblewrap and macOS uses `sandbox-exec`; unsupported hosts fail closed. A runner that cannot execute a check (sandbox or tool missing, sandbox setup refused, unsupported platform) returns `status: infra_error` with a structured `infrastructure` block (`component`: `sandbox`|`check_command`, `code`), never `fail`: it is not a verdict on the change and has no shell fallback. `sandboxPreflight()` runs a no-op through the same sandbox; the Pi runtime calls it at `session_start` for stages that expose `run_check` and aborts the stage before any agent turn if it fails (`PI_RUN_CHECK_PREFLIGHT` log line). Non-authoritative: `product-checks.mjs` still validates finally. Both use `ruff-spec.mjs` to pin the repository's `pyproject.toml`.
- `pr-guard.mjs` — loads the complete PR state/file list and enforces the pre-model human/control-plane gate.
- `issue-context.mjs` — performs the Implementer's one fresh issue read and validates `open + pi:ready` before model work.
- `issue-worktree.mjs` — creates/resumes/cleans the Implementer's latest-`dev` worktree without treating saved work as a base branch.
- `issue-publication.mjs` — safely checkpoints and publishes verified issue work, upserts its PR, and hands the PR to Reviewer.
- `pr-labels.mjs` — canonical pure helpers for clearing/applying the small `review:*` verdict family.
- `review-state.mjs` — owns stale/human/HEAD rechecks, review verdict publication, comments, and Reviewer handoff dispatches.
- `repair-publication.mjs` — owns safe PR Fix publication and the single handoff back to a fresh Reviewer.
- `automation-control.mjs` — owns RUNNING/DRAINING/PAUSED variable mutation; RUNNING wakes only Dispatcher, never Reconciler.
- `workflow-dispatch.mjs` — tiny workflow-facing adapter for no-input workflow wakes; it keeps authenticated REST and the trusted `dev` ref out of YAML.
- `terminal-tool.mjs` / `result-jsonl.mjs` — one machine-checkable terminal-tool contract plus tolerant Pi JSONL reading; free-text result markers are not pipeline state.
- `stage-config.mjs` — single source of per-agent runtime defaults and prompt builders (first contract read, turn/repeat limits, complexity mode, bash timeout, fixed token budget, result tool, stage prompt).
- `repo-search.mjs` — exact literal path/content discovery in the current tracked worktree.
- `zoekt-search.mjs` — optional read-only Zoekt client for fast indexed `dev` content/path/symbol discovery. The runtime exposes `indexed_repo_search` only when `PI_ZOEKT_URL` is configured; `PI_ZOEKT_REPOSITORY` can scope a shared index and `PI_ZOEKT_TIMEOUT_MS` controls the bounded request timeout.
- `pi-run-stage.mjs` loads the pinned `pi-repomap` git extension only for Architect. Implementer uses LSP, indexed/current-worktree search, Orbit, and exact reads instead. `.pi/repomap.json` fixes the Architect map budget, while `.pi/cache/` is runtime-only and gitignored.

## What does NOT belong here

Dispatcher classification, Architect decomposition, Reviewer verdict parsing, repair strategy, merge selection, and Reconciler orchestration remain stage-specific. `scripts/pi-run-stage.mjs` is the one thin model runner that wires the shared runtime plus the stage result tool; keep YAML and stage scripts out of extension wiring.

## Trust rule

These files are part of the CI control plane. Pi agents have no permission to modify them. They are protected by `control-plane-policy.mjs` through the `scripts/pi-*` boundary because this directory itself is under `scripts/pi-common/**`.

Prefer a small explicit helper with comments and tests over copying shell/API logic into multiple workflows.

## Project policy

Project-specific values (default branch, labels, workflow names, branch naming, control-plane paths, check commands, environment steps) are **not** spelled in these modules. They come from `.agent-harness.json` through `project-config.mjs`. See `docs/agent-harness/README.md`; `docs/agent-harness/layers.json` classifies every script and `tests/harness-boundary.test.mjs` enforces it.
