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

The actual merged `dev` commit is the integration test. Product agents run product checks (`pytest`, Ruff, and relevant focused tests); only `ci.yml` runs CI/control-plane contracts such as Node workflow tests and runner-autoscaler checks. There is no separate pre-merge dev-SHA/exact-pair integration state machine.

## Responsibilities

| Component | Responsibility |
|---|---|
| Dispatcher | Route currently eligible issues to Implementer or Architect |
| Architect | Optional decomposition/planning; return tasks to Dispatcher |
| Implementer | Change code/tests; integrate latest dev in the live session; resolve conflicts; verify and publish PR |
| Reviewer | Run deterministic checks on the exact PR HEAD, then independently review that same HEAD; verdict is invalidated when HEAD changes |
| PR Fix | Address reviewer feedback or late dev conflicts; integrate current dev in the live repair session; re-review the new HEAD |
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
- successful CI on a `dev` push wakes Merge Gate, which reloads current PR state;
- explicit/manual control can wake the relevant owner.

Any PR HEAD change emits `pull_request:synchronize`; that handler removes stale `review:*` labels and does nothing else. It never dispatches Reviewer. Implementer/PR Fix own the normal fresh-review handoff after current-`dev` integration and deterministic checks succeed. If the handoff is genuinely abandoned, Reconciler may recover it only after a 10-minute grace period from the PR's latest update; this grace period never delays the happy path.

Reconciler does not wake Merge Gate. A wake carries no authoritative task state; the receiver reloads GitHub state. `pi:needs-human` on a PR is a hard stop for Reviewer, PR Fix, and Merge Gate.

## Agent control-plane boundary

Pi agents have no control-plane create/edit/delete/rename/review/repair/auto-merge authority. `.github/workflows/**`, `scripts/pi-*`, `tests/*.test.mjs`, `tests/test_runner_autoscaler.sh`, and `infra/github-runner-autoscaler/**` are protected from agent-generated changes. Implementer/PR Fix submissions reject them; Reviewer/PR Fix stop before model work; Merge Gate refuses automatic merge. Such changes require the trusted human/direct-`dev` path.

## Branch, trust, and inputs

`dev` is the default/development branch; `main` is reserved for releases. Control-plane workflows/scripts execute from trusted `dev`; normal CI tests the triggering commit.

Trusted Pi work runs on N150 self-hosted runners. External/untrusted PR code must not execute there.

Workflows receive the minimum identifier they need and load titles, labels, branches, SHAs, and current status from GitHub.

```text
ID -> fresh GitHub state -> action
```

Do not use workflow inputs as a message bus or state store.

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
| `ci.yml` | Test triggering commit; green merged-`dev` CI continues merge queue |
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
