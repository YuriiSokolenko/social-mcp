# CI/CD pipeline overview

This is the short map of the current pipeline. `CI_RULES.md` contains the rules; `ci-architecture.md` contains the architectural invariants.

## Happy path

```text
Issue + tasks/<n>.md
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

The actual merged `dev` commit is the integration test. There is no separate pre-merge dev-SHA/exact-pair integration state machine.

## Responsibilities

| Component | Responsibility |
|---|---|
| Dispatcher | Route currently eligible issues to Implementer or Architect |
| Architect | Optional decomposition/planning; return tasks to Dispatcher |
| Implementer | Change code/tests; workflow verifies and publishes PR |
| Reviewer | Independently review PR and deterministic checks |
| PR Fix | Address reviewer-requested code changes |
| Merge Gate | Validate basic ownership/safety and attempt one squash merge |
| CI | Test the real commit after it lands on `dev` |
| Reconciler | Recover stranded/orphaned state; never schedule normal work |
| Triage | Optional issue preparation before Dispatcher |
| Usage | Diagnostics/metrics only |

## Merge Gate and wake ownership

Merge Gate is not an integration engine. It may read the current PR head SHA only for GitHub merge optimistic concurrency. It does not carry SHAs between workflows, synthesize dev+PR commits, update branches because `dev` moved, or maintain exact-pair review/CI state.

A merge conflict blocks the queue without making Merge Gate itself fail. Protected CI/control-plane changes are not auto-merged.

Normal wake sources are deliberately narrow:
- `dispatcher:ready` can wake Dispatcher;
- successful review can wake Merge Gate;
- successful post-merge CI on `dev` can wake Merge Gate for the next PR;
- explicit/manual control can wake the relevant owner.

Reconciler does not wake Merge Gate. A wake carries no authoritative task state; the receiver reloads GitHub state.

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

## Main workflows

| Workflow | Purpose |
|---|---|
| `ci.yml` | Test triggering commit; green merged-`dev` CI continues merge queue |
| `pi-dispatcher.yml` | Queue routing |
| `pi-architect.yml` | Optional decomposition/planning |
| `pi-issue-agent.yml` | Implementation |
| `pi-pr-review.yml` | Independent review |
| `pi-pr-fix.yml` | Reviewer-requested repair |
| `pi-auto-merge.yml` | Serialized merge attempt |
| `pi-reconcile.yml` | Recovery/audit |
| `pi-triage.yml` | Optional issue preparation |
| `pi-automation-control.yml` | RUNNING/DRAINING/PAUSED control |
| `pi-usage.yml` | Usage diagnostics |

## Design rule

If a proposed CI change needs another SHA parameter, another cross-workflow status, another duplicated wake path, or another synchronization workflow, first try to remove the need for it.

The preferred system is a chain of small owners reading fresh GitHub state, not a distributed state machine.
