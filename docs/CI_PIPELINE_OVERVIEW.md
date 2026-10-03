# CI/CD pipeline overview

This is the short map of the current pipeline. `CI_RULES.md` contains the rules; `ci-architecture.md` contains the architectural invariants.

## Happy path

```text
Issue + Task metadata
        |
        v
   Dispatcher
    /       \
Implementer Architect
    ^         |
    +---------+
        |
        v
 PR -> Reviewer
       /      \
    PASS    CHANGES_REQUESTED
      |          |
      |        PR Fix
      +<---------+
      |
      v
  Merge Gate
      |
      v
     dev
      |
      v
      CI
   /      \
 green    red
   |       |
 next      stop
 merge
```

The actual merged `dev` commit is the integration truth. Trusted product-stage tooling runs the authoritative pre-publication/review checks (`git diff --check`, `pytest`, Ruff); agents may run focused tests while developing or reasoning, but do not duplicate full deterministic suites as a ritual. `ci.yml` then validates the merged commit with Ruff, pytest, Node CI/control-plane contract tests, runner-autoscaler checks, and an isolated Docker Compose integration test. There is no separate pre-merge dev-SHA/exact-pair integration state machine.

## Responsibilities

| Component | Responsibility |
|---|---|
| Dispatcher | Route currently eligible issues to Implementer or Architect |
| Architect | Optional decomposition/planning; return tasks to Dispatcher |
| Implementer | Change code/tests; integrate latest dev in the live session; resolve conflicts; verify and publish PR |
| Reviewer | Independently review the exact PR HEAD after trusted deterministic checks pass; verdict is invalidated when HEAD changes |
| PR Fix | Address reviewer feedback or late dev conflicts; trusted submit tooling integrates current dev and validates the repaired HEAD before re-review |
| Merge Gate | Validate basic ownership/safety and attempt one squash merge |
| CI | Test the real commit after it lands on `dev`; exclusively own CI/control-plane contract tests |
| Reconciler | Recover stranded/orphaned state after the PR recovery grace period; never schedule normal work |
| Triage | Optional issue preparation before Dispatcher |
| Usage | Diagnostics/metrics only |

## Merge Gate and wake ownership

Merge Gate is not an integration engine. It may read the current PR head SHA only for GitHub merge optimistic concurrency. It does not carry SHAs between workflows, synthesize dev+PR commits, update branches because `dev` moved, or maintain exact-pair review/CI state.

A late merge conflict invalidates the old PASS, sets `review:changes-requested` as durable PR Fix ownership, dispatches PR Fix, and blocks the queue without making Merge Gate itself fail. If that dispatch is lost, Reconciler therefore recovers PR Fix rather than Reviewer. PR Fix integrates current dev, resolves conflicts in its live agent session, validates and pushes the new HEAD, then starts a fresh Reviewer. Protected CI/control-plane changes are not auto-merged.

Normal wake sources are deliberately narrow:
- `dispatcher:ready` can wake Dispatcher;
- successful review can wake Merge Gate;
- terminal PR CI wakes Merge Gate only from `ci-terminal-wake.yml` after GitHub emits `workflow_run: completed` for `CI`; the wake carries no PR/SHA/verdict and Merge Gate reloads current state;
- successful CI on a `dev` push wakes Merge Gate, which reloads current PR state;
- explicit/manual control can wake the relevant owner.

Any PR HEAD change emits `pull_request:synchronize`; that handler removes stale `review:*` labels and does nothing else. It never dispatches Reviewer. Implementer/PR Fix own the normal fresh-review handoff after current-`dev` integration and deterministic checks succeed. If the handoff is genuinely abandoned, Reconciler may recover it only after a 10-minute grace period from the PR's latest update; this grace period never delays the happy path.

Reconciler is not a normal Merge Gate scheduler: it issues one state-free Merge Gate wake only when a PR already carrying `review:passed` outlives the PR recovery grace period without its normal PASS handoff. A wake carries no authoritative task state; the receiver reloads GitHub state. `pi:needs-human` on a PR is a hard stop for Reviewer, PR Fix, and Merge Gate.

## Agent control-plane boundary

Pi agents have no control-plane create/edit/delete/rename/review/repair/auto-merge authority. `.github/workflows/**`, `.pi/**`, `agents/**`, `scripts/pi-*`, `tests/*.test.mjs`, `tests/test_runner_autoscaler.sh`, `infra/github-runner-autoscaler/**`, and the harness config itself (`.agent-harness.json`, `.agent-harness.yml`, `.agent-harness.yaml`) are protected from agent-generated changes. `agents/**` holds the runtime prompts every model stage reads first, so it is protected the same way as workflow/script control-plane files, not treated as ordinary product content. Implementer/PR Fix submissions reject them; Reviewer/PR Fix stop before model work; Merge Gate refuses automatic merge. Such changes require the trusted human/direct-`dev` path.

## Branch, trust, and inputs

`dev` is the default/development branch; `main` is reserved for releases. Control-plane workflows/scripts execute from trusted `dev`; normal CI tests the triggering commit.

Trusted Pi work runs on N150 self-hosted runners. External/untrusted PR code must not execute there.

`PI_RUNTIME_FAILURE_FILE` is diagnostic provenance, not an authorization boundary. It lives under `$RUNNER_TEMP`, which an Implementer shell/tool process may be able to write, so its contents must never authorize publication, review, or merge, bypass deterministic validation, or override GitHub state. Workflow consumers accept only the versioned `model_execution_abort` schema and known failure codes, and render fixed trusted text instead of publishing file-controlled strings into Actions commands or GitHub comments. Unknown, malformed, or future codes fail closed to `runtime_failure_metadata_invalid`. The file is used only to refine the human-facing classification of an already-established failed/no-terminal-result path.

Workflows receive the minimum identifier they need and load titles, labels, branches, SHAs, and current status from GitHub. Reusable GitHub REST routes live in `scripts/pi-common/github-api.mjs`; workflow YAML must not duplicate them with inline `curl`. No-input workflow wakes use `scripts/pi-common/workflow-dispatch.mjs`.

```text
ID -> fresh GitHub state -> action
```

Do not use workflow inputs as a message bus or state store.

## Model response budgets

All model-driven stages use the shared `scripts/pi-agent-runtime.mjs` extension (backed by `scripts/pi-common/progress-controller.mjs`).

The normal response levels are SHORT 2048, NORMAL 4096, and DEEP 8192, but a ceiling hit alone no longer earns a larger response. Automatic promotion requires the current turn to have made concrete progress:

```text
SHORT 2048
  ├─ below ceiling OR no productive progress -> SHORT 2048
  └─ ceiling hit + productive progress        -> NORMAL 4096

NORMAL 4096
  ├─ below ceiling OR no productive progress -> SHORT 2048
  └─ ceiling hit + productive progress        -> DEEP 8192

DEEP 8192
  └─ automatic next level -> SHORT 2048
```

A short intermediate turn that actually invokes a tool may preserve an already elevated NORMAL/DEEP budget for the following response. `set_response_budget` remains a proactive one-response override. Task complexity and response size remain independent.

Triage is the deliberate exception: `PI_FIXED_RESPONSE_MAX_TOKENS=1000` keeps every Triage response fixed at 1000 tokens, disables automatic promotion, and does not expose `set_response_budget`.

Each model call logs its active limit as `PI_BUDGET`; the automatic decision for the following call is logged as `PI_BUDGET_NEXT`.

Implementer loop protection logs `PI_LOOP_GUARD` for a repeated observation, failed strategy, no-op mutation, or repository-state revisit. The first trip steers the model (`PI_LOOP_GUARD_STEER`); a repeated trip aborts the stage (`PI_LOOP_GUARD_ABORT`). `PI_LOOP_GUARD_WINDOW` defaults to 8 (maximum 64) and `PI_LOOP_GUARD_THRESHOLD` defaults to 3; invalid values fall back to defaults and threshold is capped at the window.

## Productive-progress state

The normative execution rules live in [CI_RULES.md](CI_RULES.md). The short Implementer shape is:

```text
runtime bootstrap (separate pi session, before the main session starts)
  -> one planner result: steps + trivial|nontrivial + evidence_budget (0-6), or resolved PREPARATION_FALLBACK
  -> main Implementer session starts already prepared (first request carries the plan)
  -> evidence_budget evidence actions (fallback: 2 if trivial, otherwise 6)
  -> structural_edit / safe_edit / edit / write / begin_coding_session / rollback_last_mutation / submit_result
     or one need_more_evidence escape -> one evidence action -> action
```

Known source symbol → LSP first. Unknown literal/path → indexed/current-worktree search. Structural question → Orbit. RepoMap is Architect-only. Restored work starts by calling `submit_result({})`.

## Automation modes

| Mode | Behavior |
|---|---|
| `RUNNING` | Start new work and continue in-flight work |
| `DRAINING` | Do not start new issues; let existing PR work finish |
| `PAUSED` | Do not start new automated stages |

Unknown/missing mode fails closed.

Manual cancellation is not a failure state. Before PR publication, cancelled Implementer/Architect work becomes unowned without adding `dispatcher:ready` or triggering automatic redispatch; Implementer checkpoint work is retained when safe. Unresolved replay conflicts are never checkpointed over the previous good checkpoint.

## Main workflows

| Workflow | Purpose |
|---|---|
| `ci.yml` | Test PR HEADs and the merged `dev` commit: product checks, control-plane contracts, autoscaler tests, Docker integration; green `dev` CI continues the merge queue |
| `ci-terminal-wake.yml` | Observe completed PR `CI` workflow runs and issue a state-free Merge Gate wake only after GitHub exposes the terminal result |
| `pi-dispatcher.yml` | Queue routing |
| `pi-architect.yml` | Optional decomposition/planning |
| `pi-issue-agent.yml` | Implementation |
| `pi-pr-review.yml` | Independent review |
| `pi-pr-fix.yml` | Reviewer-requested repair or late merge-conflict recovery |
| `pi-auto-merge.yml` | Serialized merge attempt |
| `pi-reconcile.yml` | Recovery/audit |
| `pi-triage.yml` | Optional issue preparation |
| `pi-automation-control.yml` | RUNNING/DRAINING/PAUSED control |
| `pi-usage.yml` | Usage diagnostics |

## Concurrency

Stateful workflows serialize related work with standard GitHub Actions `concurrency.group` and `cancel-in-progress: false`. `queue: max` / `concurrency.queue` is not part of the design and must not be reintroduced.

## Design rule

If a proposed CI change needs another SHA parameter, another cross-workflow status, another duplicated wake path, or another synchronization workflow, first try to remove the need for it.

The preferred system is a chain of small owners reading fresh GitHub state, not a distributed state machine.
