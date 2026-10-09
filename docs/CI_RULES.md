# Workflow and CI: maintainer guide

This is the **canonical operational overview** for issue-to-PR automation, CI, review, and merge on `dev`. It replaces the former parallel pipeline overview, architecture rules, and hand-drawn Pi lifecycle diagrams. Read the implementation, not this document, when a detail changes.

## Authority and navigation

- **Project policy:** [`.agent-harness.json`](../.agent-harness.json) (branch, labels, workflow names, protected paths, fixed-argv checks). The strict loader is [`scripts/pi-common/project-config.mjs`](../scripts/pi-common/project-config.mjs).
- **Orchestration:** [`.github/workflows/`](../.github/workflows/) and role entry points under [`scripts/`](../scripts/). YAML owns triggers, permissions, runner selection, and handoff; trusted scripts own validation, GitHub API writes, and state changes.
- **Pipeline state:** [`state-machine.mjs`](../scripts/pi-common/state-machine.mjs), [`review-state.mjs`](../scripts/pi-common/review-state.mjs), and [`pi-auto-merge.mjs`](../scripts/pi-auto-merge.mjs).
- **Model contracts:** [`agents/AGENTS.md`](../agents/AGENTS.md) plus the corresponding role's `agents/<role>/AGENTS.md`. These are executable prompt overlays, **not** additional workflow manuals. `agents/merger/AGENTS.md` is reference-only; Merge Gate has no model.
- **Runner deployment and recovery:** [N150 runner/autoscaler README](../infra/github-runner-autoscaler/README.md). **Diagnosis:** [Actions logs](github-actions-logs.md) and [model traces](pi-model-traces.md).
- **Historical investigations:** [LLM reliability research](llm-research/README.md), [agent experiments](agent-harness/experiments/), [smoke reports](releases/) and dated incident notes. Historical observations are not operational authority. [Harness extraction design](agent-harness/README.md) is a proposal, not a deployed separate repository.

## Current pipeline

```text
Issue (+ priority/depends_on in issue body)
  └─ optional Triage → Dispatcher ─┬─ Implementer → PR → Reviewer ─ PASS ─┐
                                   └─ Architect → child issues → Dispatcher│
                                                  Reviewer CHANGES_REQUESTED│
                                                          ↓                │
                                                        PR Fix → Reviewer  │
                                                                           ↓
                                                              Merge Gate + PR CI
                                                                           ↓
                                                                         dev
                                                                           ↓
                                                                   CI on merged SHA
                                                               green → next merge;
                                                               red   → queue stops
```

Every handoff reloads GitHub state. Workflow-dispatch events are **wakes**, not authenticated transport of labels, previous verdicts, dev SHA, or commit identity. Work is integrated against current `dev` by Implementer/PR Fix; **Merge Gate never creates synthetic integration commits**. The actual merged `dev` CI result is the integration truth.

| Stage / owner | Workflow | Trusted implementation |
| --- | --- | --- |
| Readiness and optional triage | `pi-triage.yml` | `pi-triage.mjs`, `pi-common/task-metadata.mjs` |
| Queue/scope classification | `pi-dispatcher.yml` | `pi-dispatcher.mjs`, `pi-common/queue-context.mjs` |
| Issue decomposition (when needed) | `pi-architect.yml` | `pi-architect.mjs`, `pi-architect-plan-validator.mjs` |
| Worktree, planning, code, PR publication | `pi-issue-agent.yml` | `pi-run-stage.mjs`, `pi-common/pi-stage-backend.mjs`, `pi-common/issue-publication.mjs` |
| Deterministic checks, independent verdict | `pi-pr-review.yml` | `pi-common/product-checks.mjs`, `pi-common/review-state.mjs` |
| Feedback and late conflict repair | `pi-pr-fix.yml` | `pi-common/repair-publication.mjs`, `pi-repair-result-tool.mjs` |
| Gate and squash merge | `pi-auto-merge.yml` | `pi-auto-merge.mjs` |
| Product and control-plane CI | `ci.yml` | `tests/`, `tests/test_runner_autoscaler.sh` |
| PR-CI completion wake | `ci-terminal-wake.yml` | `pi-common/workflow-dispatch.mjs` |
| Stale verdict invalidation | `pi-review-invalidate.yml` | `pi-common/review-state.mjs` |
| Orphan recovery, not scheduling | `pi-reconcile.yml` | `pi-reconcile.mjs`, `pi-common/review-state.mjs` |
| Automation control | `pi-automation-control.yml` | `pi-common/automation-control.mjs` |
| Usage/artifacts | `pi-usage.yml` | `pi-usage-collect.mjs` |

`control-runner-watch.yml` monitors delayed control-lane wakes; `verify-run-check-beelink.yml` provides a manual sandbox verification path. Neither is an issue pipeline owner.

## Issue state, labels, and mode

Names come from `.agent-harness.json`; transition validation is in `state-machine.mjs`. These are **ownership states**, not a free-form checklist:

- `dispatcher:ready` → `pi:ready` (Implementer) or `architect:ready` (Architect). `triage:ready` is optional preparation.
- `pi:ready` → `pi:running` → `pi:mr-created` after a PR is published. `architect:epic` parents are not executable issues.
- `pi:blocked` and `pi:needs-human` require explicit human intervention before new executable work. A published PR retains PR ownership; do not replace it with issue failure state.
- PR review labels are `review:passed` and `review:changes-requested`. `pi:needs-human` on a PR stops Reviewer, PR Fix, and Merge Gate. Do not equate a label alone with a current-HEAD verdict.

`PI_AUTOMATION_MODE` is a repository variable with three values: `RUNNING` permits new and in-flight work; `DRAINING` stops new issue work while existing PR review/fix/merge can finish; `PAUSED` stops automated model/merge stages. [Automation Control](../.github/workflows/pi-automation-control.yml) uses a scoped control token to set and read back the mode; switching to `RUNNING` wakes **Dispatcher only**. Reconciler is not another dispatcher.

Each normal stage owns its next handoff. Dispatcher/Architect never bypass blockers or dependencies. Manual Implementer dispatch is distinct from `pi:ready` dispatcher ownership (see `running-manual` transition). Reconciler removes or recovers stranded ownership after checks; for PR handoffs it waits for the ten-minute latest-update grace period, so it does not race a normal owner. In `DRAINING` it does not requeue new issue work.

## Implementer, Planner, and terminal contract

The workflow checks out trusted control code from `dev`, creates an isolated issue worktree and prepares its toolchain. A **fresh** attempt uses a short-lived, prompt-less bootstrap process (`pi-implementer-bootstrap.mjs`) to run the read-oriented Planner (`pi-common/implementation-planner.mjs`) *before* the main Implementer process. The Planner can inspect repository evidence through its explicit read/search surface; optional current-HEAD Orbit information is evidence, never instruction authority. The optional Orbit seed is prepared **before provider request #1** under a **30-second pre-request infrastructure safety budget**; it is **not a Planner lifecycle deadline or Orbit-query-count cap**. The `PI_PLANNER_ORBIT_SEED` event records seed availability and freshness without exposing graph content. Useful read/search work has **no Planner evidence-action budget**; semantic no-progress guards still apply.

The current Planner uses a **`submit_plan({planText})` terminal tool**, not a final prose answer and not an XML/JSON model-generated plan. A normally completed, nonempty submission yields a trusted `PreparedImplementation` artifact; transport/truncation/provider failures resolve to an explicit preparation fallback. The harness passes the accepted plan verbatim as untrusted task data to Main and its coding fork. It does not derive mutation rights, file acceptance, or complexity from the prose. Consult `implementation-planner.mjs`, `pi-planner-evidence.mjs`, and the pinned terminal adapter tests before changing output budgets, semantic evidence guards, or submission retries: these have changed repeatedly. Do not resurrect the historical fixed six-action budget or assume free-form final Planner text is accepted.

The main session can inspect/modify within runtime capabilities and may call `begin_coding_session` to fork a coding invocation with its own guarded tool surface and response budget. The child inherits **forked conversational context**, but has isolated session/binding state and must terminate via a verified `submit_result`; parent and child do not independently publish PRs. `scripts/pi-agent-runtime.mjs`, `pi-common/coding-session-capability.mjs`, the pinned `pi-subagents` patch, and the terminal receipt/session-binding helpers define the exact lease, fork, resume, and terminal rules.

Writes are worktree-contained and protected from symlink/`.git` escape. The accepted mutation scope requires trusted per-path intent before Implementer publication; scratch paths must be cleaned up. Mutation snapshots/journal, rollback, safe/structural edits, checkpoint publication, and deterministic worktree recovery preserve real work across interruption without authorizing unreviewed files. PR Fix has a separate repair/publish contract rather than borrowing the Implementer receipt gate.

Focused validation uses `run_check` (Python compile, Ruff, pytest, Node test or configured profile) and `retry_last_failed_check` when exposed. `run-check.mjs` defines normalized targets and `pass/fail/timeout/invalid/infra_error`; the runtime/validation ledger controls when checks may run and what counts as passing evidence. Product-stage trusted final checks come from `.agent-harness.json` (package roots, Ruff, `git diff --check`, pytest). Failed final product validation permits one bounded targeted repair path in `stage-validation-recovery.mjs`; do not confuse it with model-driven endless retry. If sandbox infrastructure is unavailable, do not silently replace it with unrestricted bash.

`submit_result` is a tool contract, **not** a phrase in assistant prose. It is bound to the current run/issue/attempt/session and validated against terminal receipt metadata, changed-file scope, prepared outputs, and checks before the trusted workflow publishes a PR. Wrong/stale/duplicate receipts or provider/abort/timeout failures cannot be rescued by plausible text. Recognized terminal obligations may trigger a bounded deterministic recovery action (metadata, scoped cleanup, conflict, required output, exact verification); `terminal-recovery-controller.mjs` blocks if no safe repair remains and leaves checkpoint/human diagnosis. Restored work and checkpoint replay take their own guarded path, not a fresh Planner run. The workflow owns commits, pushes, PR creation and fresh-review dispatch, not the model.

## Review, PR CI, Merge Gate, and recovery

Reviewer checks the exact current PR HEAD after trusted deterministic product validation. It publishes `PASS` or `CHANGES_REQUESTED` using `review-state.mjs`; a verdict is HEAD-bound. A push to `pi/issue-*` triggers `pi-review-invalidate.yml` to clear stale review labels; the invalidator does **not** schedule another review. Implementer and PR Fix own fresh-review handoff. An abandoned handoff can be recovered by Reconciler after its grace period. Review infrastructure failures receive one bounded retry, then a durable `pi:needs-human` rather than synthetic PASS.

On a changes-requested verdict, PR Fix owns the repair against latest `dev`, verifies and publishes a new PR HEAD, and dispatches another Reviewer. If Merge Gate discovers a late conflict, it invalidates PASS and transfers ownership to PR Fix; it does **not** solve conflicts, update the branch, or run an integration engine.

Merge Gate requires a live, permitted PR with a current-HEAD `review:passed` verdict and **green ordinary pull-request CI on that same PR HEAD**. Pending CI allows other ready PRs to be considered. Known product-CI failure transfers to PR Fix; CI infrastructure failure has one bounded rerun, then needs human intervention. Immediately before merging, the current `dev` HEAD must also have green push CI. GitHub squash merge receives the observed PR SHA for optimistic concurrency, not as cross-workflow state.

`ci.yml` runs on same-repository PRs to `dev`, pushes to `dev`, and manual dispatch. It uses N150 **self-hosted general** runners for Ruff, pytest, Node/harness tests, runner-autoscaler tests, and Docker/Compose integration; untrusted fork PRs are excluded. The separate `ci-terminal-wake.yml` observes *completed* PR CI via `workflow_run` and wakes Merge Gate on the dedicated control runner. After green push CI for the actual merged `dev`, `ci.yml` finalizes the issue and wakes the next merge. Red `dev` CI stops the sequence. No pipeline stage uses captured cross-run dev SHA or synthetic dev+PR CI.

## Runner capacity, providers, and diagnostics

N150 has **two independent ephemeral autoscaled pools**: `pi-agent` (model-capacity gated) for Dispatcher, Architect, Implementer, Reviewer, PR Fix, Triage; and `general` (not model gated) for CI, Merge Gate, Reconciler and Usage. A **third, dedicated persistent `control` runner** executes short CI terminal, post-merge and automation-control wakes even when general workers are saturated. Pool size, model concurrency and workflow-file watchers are set by `infra/github-runner-autoscaler/compose.yaml` and its host environment; do not document a fixed live number from a past deployment. `control-runner-watch.yml` separately checks stalled control jobs. For host setup, recovery/quarantine and evidence volumes use the [runner reference](../infra/github-runner-autoscaler/README.md).

Stage backend/model selection is centralized in `scripts/pi-run-stage.mjs` (default alias in `.pi/default-model`, optional override). The current Pi default provider route uses the Open Responses-compatible `4001/v1` endpoint through `DEFAULT_MODEL_BASE_URL` or `PI_MODEL_BASE_URL`; do not describe an obsolete LiteLLM/3009 direct path as the normal agent API. `pi-common/pi-stage-backend.mjs` and `mini-swe-stage-backend.mjs` implement backend-specific invocation. The model requested must actually be loaded at the selected endpoint; runner/model availability is an operational dependency, not a code quality verdict.

Usage records and reconciliation live in `pi-common/usage-ledger.mjs`, `pi-usage-summary.mjs` and `pi-usage-collect.mjs`. Implementer request/response traces are retained as restricted Actions artifacts for **seven days**. Logs, validation ledgers and failure artifacts aid diagnosis. `PI_RUNTIME_FAILURE_FILE` is diagnostic provenance, not an authorization boundary: the file lives under `$RUNNER_TEMP`, which an Implementer shell/tool process may be able to write. Its contents must never authorize publication, review, or merge, override GitHub state, or bypass trusted validation; only the trusted classifier may render recognized failure metadata. Unknown or malformed metadata fails closed. Use the linked [logs guide](github-actions-logs.md) and [trace guide](pi-model-traces.md); never put credentials, raw tokens, or user data into issue comments.

## Security and maintenance

The model may propose product changes but cannot change `.github/workflows/**`, `.pi/**`, `agents/**`, protected `scripts/pi-*` or `infra/github-runner-autoscaler/**`, root harness policy, or protected control-plane tests. The trusted policy is in `.agent-harness.json` and `pi-common/control-plane-policy.mjs`. Protected changes require a separate human-reviewed control-plane path; workflows do not grant model authority by rephrasing the task.

Keep this file **short and descriptive**, not a second executable contract. Update it when a workflow/ownership boundary changes. Put per-tool invariants in the relevant trusted code/tests, exact model prompts in `agents/**`, and host commands in the runner README. Do not add a second pipeline diagram or historical experiment to live operations.
