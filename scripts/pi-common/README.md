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
- `github-state.mjs` — compare-and-swap style label/state replacement; `transitionIssueState()` is the one fresh-read → validate → replace path for stage issue transitions.
- `state-machine.mjs` — canonical issue pipeline labels and legal transitions.
- `task-metadata.mjs` — canonical GitHub issue task metadata parser/writer.
- `queue-context.mjs` — shared read-only queue snapshot construction.
- `recovery-policy.mjs` — small deterministic recovery decisions.
- `control-plane-policy.mjs` — single security boundary for files Pi agents must never change/review/repair/auto-merge.
- `agent-change-policy.mjs` — lists every path an agent session actually touched (committed, staged, unstaged, and untracked), so control-plane checks see real working-tree changes, not just `HEAD` diffs.
- `finalize-product-tree.mjs` — integrates latest `dev` into the agent's branch, rejects agent changes to control-plane paths via `agent-change-policy.mjs`, and runs the authoritative product checks. `integrateLatestDev()` is used by the Implementer and PR Fix terminal tools (and the mini-swe backend); `validateFinalProductTree()` runs inside PR Fix's `submit_repair` and, for Implementer, after the backend exits via `stage-validation-recovery.mjs`.
- `bash-timeout-policy.mjs` / `progress-controller.mjs` — reusable model safety state: bounded orientation, complexity declaration, repeat/turn protection, response budgets, single-use startup actions, and the productive-progress state machine (`EVIDENCE_ALLOWED` / `ACTION_REQUIRED`).
- `product-checks.mjs` — authoritative product-code deterministic checks used before publication/review.
- `run-check.mjs` — backend-neutral focused verification (`python_compile`, `ruff`, `pytest`, named `profile`) behind a closed structured contract: worktree-contained paths, no command strings, hard timeout, allow-listed environment, network/filesystem sandbox, bounded diagnostics and output tails. Relative and in-worktree absolute paths normalize to the same worktree-relative targets before execution (pytest node selectors are preserved). The Docker remapping boundary uses the same lexical normalization rule and revalidates existence and symlink containment against its staged tree. Invalid model targets return `status: invalid`, including targets rejected by staged validation; they are recoverable input errors without infrastructure-blocker guidance. Linux sends only structured check fields to the trusted Docker executor; that service builds a fixed command and starts the dedicated read-only sandbox image. macOS retains `sandbox-exec`; unsupported hosts fail closed. A runner that cannot execute a check returns `status: infra_error` with structured infrastructure details, never `fail`, and there is no shell fallback. `sandboxPreflight()` exercises the selected backend before the Pi runtime exposes `run_check` (`PI_RUN_CHECK_PREFLIGHT`). `product-checks.mjs` remains authoritative, and both use `ruff-spec.mjs` for the repository's Ruff policy.
- `pr-guard.mjs` — loads the complete PR state/file list and enforces the pre-model human/control-plane gate; `closingIssueNumber()` is the single PR → issue linkage rule used by Merge Gate and post-merge finalization.
- `issue-context.mjs` — performs the Implementer's one fresh issue read and validates `open + pi:ready` before model work.
- `issue-worktree.mjs` — creates/resumes/cleans the Implementer's latest-`dev` worktree without treating saved work as a base branch.
- `issue-publication.mjs` — safely checkpoints and publishes verified issue work, upserts its PR, and hands the PR to Reviewer.
- `accepted-mutation-scope.mjs` — Implementer-only intent/provenance guard. Publishable paths must be accepted before their first mutation; temporary scratch paths must be removed/restored before publication and may be re-accepted only after that cleanup. A restored baseline path with no trusted receipt is intentionally cleanup-only (delete it or restore it to `dev`); it cannot be retroactively authorized on resume. PR Fix does not use this Implementer receipt gate and continues to validate the repaired PR through the normal final product checks.
- `pr-labels.mjs` — canonical pure helpers for clearing/applying the small `review:*` verdict family.
- `review-state.mjs` — owns stale/human/HEAD rechecks, review verdict publication, comments, and Reviewer handoff dispatches.
- `repair-publication.mjs` — owns safe PR Fix publication and the single handoff back to a fresh Reviewer.
- `automation-control.mjs` — owns RUNNING/DRAINING/PAUSED variable mutation; RUNNING wakes only Dispatcher, never Reconciler.
- `workflow-dispatch.mjs` — tiny workflow-facing adapter for no-input workflow wakes; it keeps authenticated REST and the trusted `dev` ref out of YAML.
- `terminal-tool.mjs` / `result-jsonl.mjs` — one machine-checkable terminal-tool contract plus tolerant Pi JSONL reading; free-text result markers are not pipeline state.
- `restored-work.mjs` — shared Implementer resume predicate, kept self-contained for the pinned Pi coding adapter's source injection via `toString()` during Docker build.
- `provider-wire-policy.mjs` — pure provider-boundary payload decisions for both Main and coding child (thinking flag, serializable tool_choice/zero-tool safety, provider error status and retry classification); does not own hooks or mutable session state.
- `stage-config.mjs` — single source of per-agent runtime defaults and prompt builders (shared + role contract injection into the initial prompt, turn/repeat limits, complexity mode, bash timeout, fixed token budget, result tool, stage prompt).
- `stage-run-contract.mjs` — backend-neutral `StageRunSpec`/`StageRunResult` shapes passed between `pi-run-stage.mjs` and a backend.
- `pi-stage-backend.mjs` / `mini-swe-stage-backend.mjs` — the two stage backends (Pi and the experimental, implementer-only mini-swe).
- `stage-validation-recovery.mjs` — runs the Implementer backend, then the authoritative final checks, with exactly one focused validation-repair attempt on failure.
- `implementer-result.mjs` — shared Implementer outcome (`changed` / `already_satisfied` / `blocked`) artifact reader/writer.
- `validation-ledger.mjs` — append-only record of every focused `run_check` and final check; the only source for rendered "Validation" text.
- `prepare-environment.mjs` — runs a stage's fixed-argv toolchain steps from `.agent-harness.json` `environment`.
- `run-check-docker-backend.mjs` — the Linux Docker sandbox backend used by `run-check.mjs`.
- `mutation-target.mjs` / `mutation-snapshot.mjs` — worktree/`.git`/symlink containment for every agent mutation, plus before/after snapshots for rollback and no-op detection.
- `worktree-recovery.mjs` — deterministic single-file untracked deletion or HEAD restore, containment checks, mutation ledger and immediate file-set validation. Recovery records are excluded from verification evidence.
- `safe-edit.mjs` / `structural-edit.mjs` — the `safe_edit` (line/range) and `structural_edit` (single ast-grep match) mutation tools.
- `semantic-loop-guard.mjs` — Implementer repeated-strategy/observation/no-op/state-revisit detection (`PI_LOOP_GUARD_*`).
- `session-state.mjs` — runtime record of completed one-shot control transitions (LSP startup, subagent enablement, preparation).
- `repo-search.mjs` — exact literal path/content discovery in the current tracked worktree.
- `zoekt-search.mjs` — optional read-only Zoekt client for fast indexed `dev` content/path/symbol discovery. The runtime exposes `indexed_repo_search` only when `PI_ZOEKT_URL` is configured; `PI_ZOEKT_REPOSITORY` can scope a shared index and `PI_ZOEKT_TIMEOUT_MS` controls the bounded request timeout.
- `candidate-revision.mjs` — resolves the candidate base once and computes the candidate revision shared by receipt, final checks and publication.
- `terminal-receipt.mjs` — writes/reads/invalidates the run/issue/attempt-bound terminal receipt (a consistency binding, not an authentication token).
- `terminal-session-binding.mjs` — single-flight binding of the Implementer's terminal session for the pinned `pi-subagents` foreground adapter.
- `terminal-recovery-controller.mjs` — selects the one bounded deterministic recovery action for an unmet terminal obligation, or blocks.
- `coding-session-input.mjs` — pure validation/normalization of `begin_coding_session` arguments and tool-call envelopes; owns the shared Unicode handoff limit and exact diagnostic text, not child-launch/correction state.
- `coding-session-capability.mjs` / `coding-session-outcome.mjs` / `coding-session-validation.mjs` — coding-session fork sidecars: capabilities the fork could not use, normalization of the fork's terminal outcome (a failed delegation is never upgraded by a leftover receipt), and behavioral (pytest) validation coverage shared between parent and fork.
- `implementation-planner.mjs` / `planner-orbit.mjs` / `planner-request-budget.mjs` — read-only Planner: evidence gate and task construction, the safety-bounded pre-request Orbit seed, and session-local response-ceiling provenance.
- `runtime-budget-telemetry.mjs` — pure response-budget precedence/output-ceiling checks and Planner/Coding Session/turn-start log-record formatting; the Pi extension alone owns provider hooks, console emission and mutable budget policy.
- `runtime-tool-guidance.mjs` — pure Main profile-hidden messages and stage/tool-surface-specific action hints; the runtime supplies authoritative live state and controls when to send steers.
- `main-tool-profile.mjs` / `main-prompt-observability.mjs` / `runtime-steering.mjs` — Implementer Main outbound tool-schema profile (not an authorization boundary), prompt-composition telemetry (`PI_MAIN_PROMPT`), and compaction of replaceable runtime action steers at the provider boundary.
- `structured-subagent.mjs` — runs text/structured `pi-subagents` children (including `context: 'fork'`) and records descendant usage.
- `mutation-journal.mjs` / `worktree-baseline.mjs` — bounded durable mutation journal for undo/checkpoints, and the run-start worktree baseline that proves which unjournaled paths the stage may clean up (#438).
- `runtime-failure.mjs` — classifies `PI_RUNTIME_FAILURE_FILE` records into model-abort vs infrastructure failure classes (diagnostic provenance only).
- `diagnostics-artifact.mjs` — sanitized, best-effort JSONL diagnostics appended for the `pi-diagnostics-*` artifact.
- `model-trace-proxy.mjs` — local OpenAI-compatible forwarding proxy that records model exchanges for the `pi-model-trace-*` artifact and provider tool-contract/usage evidence.
- `usage-ledger.mjs` — shared `PI_METRIC` usage accounting for job summaries and the usage CSV.
- `package-root-check.mjs` — duplicate Python package-root detection used by `product-checks.mjs` (the `package_roots` final check) and `run-check.mjs`, driven by `.agent-harness.json` `checks.packageRoots`.
- `pi-run-stage.mjs` loads the pinned `pi-repomap` git extension only for Architect. Implementer uses LSP, indexed/current-worktree search, Orbit, and exact reads instead. `.pi/repomap.json` fixes the Architect map budget, while `.pi/cache/` is runtime-only and gitignored.

## What does NOT belong here

Dispatcher classification, Architect decomposition, Reviewer verdict parsing, repair strategy, merge selection, and Reconciler orchestration remain stage-specific. `scripts/pi-run-stage.mjs` is the one thin model runner that wires the shared runtime plus the stage result tool; keep YAML and stage scripts out of extension wiring.

## Trust rule

These files are part of the CI control plane. Pi agents have no permission to modify them. They are protected by `control-plane-policy.mjs` through the `scripts/pi-*` boundary because this directory itself is under `scripts/pi-common/**`.

Prefer a small explicit helper with comments and tests over copying shell/API logic into multiple workflows.

## Project policy

Project-specific values (default branch, labels, workflow names, branch naming, control-plane paths, check commands, environment steps) are **not** spelled in these modules. They come from `.agent-harness.json` through `project-config.mjs`. See `docs/agent-harness/README.md`; `docs/agent-harness/layers.json` classifies every script and `tests/harness-boundary.test.mjs` enforces it.
