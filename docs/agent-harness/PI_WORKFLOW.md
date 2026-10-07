# Pi Agent Workflow

> Current text diagram of the Pi agent workflow and its main runtime state machines.
>
> Last updated: 2026-10-07.

## End-to-end workflow

```text
┌──────────────────────────────────────────────────────────────────────┐
│                         GitHub Issue / Task                          │
│                                                                      │
│  tasks/<id>.md                                                       │
│  - priority                                                          │
│  - depends_on                                                        │
│  - acceptance criteria                                               │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │      DISPATCHER       │
                    │ scripts/pi-dispatcher │
                    └───────────┬───────────┘
                                │
                 Проверяет, можно ли запускать:
                 - зависимости закрыты
                 - нет pi:needs-human
                 - нет blocker'ов
                 - automation = RUNNING
                                │
                    ┌───────────┴───────────┐
                    │                       │
                    ▼                       ▼
               Нельзя запускать         Можно запускать
                    │                       │
                    │                       ▼
                    │            dispatcher:ready / pi:ready
                    │                       │
                    │                       ▼
                    │       ┌──────────────────────────┐
                    │       │       AUTOSCALER         │
                    │       │         N150             │
                    │       │                          │
                    │       │ - runner capacity        │
                    │       │ - model slots            │
                    │       │ - ephemeral runner       │
                    │       └────────────┬─────────────┘
                    │                    │
                    │                    ▼
                    │       ┌──────────────────────────┐
                    │       │        PLANNER           │
                    │       │ prompt-less Pi session   │
                    │       └────────────┬─────────────┘
                    │                    │
                    │                    │ fresh context
                    │                    │
                    │                    ▼
                    │       ┌──────────────────────────┐
                    │       │ Repository discovery     │
                    │       │                          │
                    │       │ read / grep / find / ls  │
                    │       │ ONLY                     │
                    │       │                          │
                    │       │ max evidence: 6          │
                    │       │ lifecycle: <= 15 min     │
                    │       └────────────┬─────────────┘
                    │                    │
                    │                    ▼
                    │       ┌──────────────────────────┐
                    │       │ PreparedImplementation   │
                    │       │                          │
                    │       │ - implementation plan    │
                    │       │ - repositoryFacts <= 6   │
                    │       │ - affected files         │
                    │       │ - checks                 │
                    │       │ - intent / mutation size │
                    │       └────────────┬─────────────┘
                    │                    │
                    │                    ▼
                    │       ┌──────────────────────────┐
                    │       │      IMPLEMENTER         │
                    │       │       Pi coding          │
                    │       └────────────┬─────────────┘
                    │                    │
                    │          Первый prompt содержит:
                    │          Issue + PreparedImplementation
                    │
                    │                    ▼
                    │       ┌──────────────────────────┐
                    │       │ Fresh coding context     │
                    │       │                          │
                    │       │ parent transcript        │
                    │       │ НЕ наследуется           │
                    │       │                          │
                    │       │ project/global context   │
                    │       │ НЕ наследуется           │
                    │       └────────────┬─────────────┘
                    │                    │
                    │                    ▼
                    │       ┌──────────────────────────┐
                    │       │   IMPLEMENTATION LOOP    │◄─────────────┐
                    │       └────────────┬─────────────┘              │
                    │                    │                            │
                    │                    ▼                            │
                    │       inspect/read required files               │
                    │                    │                            │
                    │                    ▼                            │
                    │       mutation scope / accepted paths           │
                    │                    │                            │
                    │                    ▼                            │
                    │       write / edit / structural_edit            │
                    │                    │                            │
                    │                    ▼                            │
                    │       ┌──────────────────────────┐              │
                    │       │       run_check          │              │
                    │       │                          │              │
                    │       │ not_yet_available        │              │
                    │       │ available                │              │
                    │       │ exhausted                │              │
                    │       └────────────┬─────────────┘              │
                    │                    │                            │
                    │              check passes?                       │
                    │             ┌──────┴──────┐                     │
                    │             │             │                     │
                    │            YES            NO                    │
                    │             │             │                     │
                    │             │             ▼                     │
                    │             │    retry_last_failed_check        │
                    │             │             │                     │
                    │             │             ▼                     │
                    │             │       repair required             │
                    │             │             │                     │
                    │             │             └─────────────────────┘
                    │             │
                    │             ▼
                    │       ┌──────────────────────────┐
                    │       │      FINAL GATES         │
                    │       └────────────┬─────────────┘
                    │                    │
                    │                    ├─ diff ⊆ accepted mutation scope
                    │                    ├─ no unresolved recovery
                    │                    ├─ verification completed
                    │                    ├─ mutation journal consistent
                    │                    ├─ no capability dead-end
                    │                    └─ no unfinished required action
                    │
                    │                    ▼
                    │       ┌──────────────────────────┐
                    │       │      submit_result       │
                    │       └────────────┬─────────────┘
                    │                    │
                    │          ┌─────────┴─────────┐
                    │          │                   │
                    │        success             failure
                    │          │                   │
                    │          │                   ▼
                    │          │              recovery loop
                    │          │              or terminal abort
                    │          │
                    │          ▼
                    │       commit / push
                    │          │
                    │          ▼
                    │    Pull Request created
                    │          │
                    │          ▼
                    │  ┌────────────────────────────┐
                    │  │            CI              │
                    │  │                            │
                    │  │ test                       │
                    │  │ docker                     │
                    │  │ other required checks      │
                    │  └──────────────┬─────────────┘
                    │                 │
                    │          ┌──────┴──────┐
                    │          │             │
                    │        green         failure
                    │          │             │
                    │          │             ▼
                    │          │      repair / retry policy
                    │          │
                    │          ▼
                    │  ┌────────────────────────────┐
                    │  │         REVIEWER           │
                    │  │       pi-pr-review         │
                    │  └──────────────┬─────────────┘
                    │                 │
                    │          ┌──────┼───────────┐
                    │          │      │           │
                    │        PASS   CHANGES     INFRA
                    │          │    REQUESTED    FAILURE
                    │          │      │           │
                    │          │      │       retry once
                    │          │      │           │
                    │          │      │      still failing
                    │          │      │           │
                    │          │      │           ▼
                    │          │      │      pi:needs-human
                    │          │      │
                    │          │      ▼
                    │          │   Implementer / repair
                    │          │      │
                    │          │      └──────────────► Reviewer
                    │          │
                    │          ▼
                    │   review:passed
                    │          │
                    │          ▼
                    │  ┌────────────────────────────┐
                    │  │        MERGE GATE          │
                    │  │                            │
                    │  │ dedicated control runner   │
                    │  │ self-hosted,n150,control   │
                    │  └──────────────┬─────────────┘
                    │                 │
                    │                 ├─ required CI green
                    │                 ├─ review passed
                    │                 ├─ PR mergeable
                    │                 └─ no blocking state
                    │
                    │                 ▼
                    │         ┌───────────────┐
                    │         │     MERGE     │
                    │         └───────┬───────┘
                    │                 │
                    │                 ▼
                    │              dev
                    │
                    └────────────────────────────────────────
```

## Pi Implementer lifecycle

```text
Issue
  │
  ▼
Planner
  │
  ├── inspect repo with read-only evidence
  ├── finalize as plain <plan> XML
  ├── local canonical validation
  ├── at most one XML-only repair
  └── PreparedImplementation
  │
  ▼
Fresh Pi coding session
  │
  ▼
Read required context
  │
  ▼
Establish mutation scope
  │
  ▼
Modify
  │
  ▼
Run check
  │
  ├── PASS ───────────────────────────────┐
  │                                       │
  └── FAIL                                │
       │                                  │
       ▼                                  │
     Repair                               │
       │                                  │
       ├── inspect preserved changed path │
       ├── mutate allowed path            │
       ├── retry failed check             │
       │                                  │
       └───────────────► loop             │
                                          │
                                          ▼
                                  Final verification
                                          │
                                  ┌───────┴────────┐
                                  │                │
                               valid            invalid
                                  │                │
                                  ▼                ▼
                             submit_result     recovery /
                                  │           terminal abort
                                  ▼
                             commit + PR
```

## Progress and retry guards

Pi is intentionally prevented from looping indefinitely around the same problem. Useful actions, no-op loops, provider errors, and output ceilings are handled separately.

```text
                     Pi response
                         │
             ┌───────────┼────────────┐
             │           │            │
          useful       no-op       provider /
          action       loop        output limit
             │           │            │
             ▼           ▼            ▼
          continue   progress      bounded retry
                     guards            │
                       │               │
                       ▼               ▼
                    force         retry exhausted?
                    action          │       │
                       │           no      yes
                       │            │       │
                       └────────────┘       ▼
                                      terminal error
```

## Recovery state machine

```text
normal coding
     │
     │ check / mutation / submit failure
     ▼
recovery obligation
     │
     ▼
read preserved changed path
     │
     ├── readable path exists
     │       │
     │       ▼
     │    inspect
     │       │
     │       ▼
     │    targeted repair
     │       │
     │       ▼
     │    verification
     │
     └── no readable preserved path
             │
             ▼
        recoveryDeadEnd
             │
             ▼
 PI_CODING_RECOVERY_BLOCKED
 worktree_preserved=true
```

## Conceptual pipeline

```text
DISPATCH
   ↓
PLAN
   ↓
IMPLEMENT
   ↓
VERIFY
   ↓
REPAIR ───────┐
   ↑          │
   └──────────┘
   ↓
PR
   ↓
CI
   ↓
REVIEW
   ↓
MERGE GATE
   ↓
MERGE
```

## Architectural note

Planner and Implementer are deliberately separated.

The Planner only inspects the repository with its read-only evidence surface. There is no numeric evidence-action or repository-fact budget; semantic no-progress guards stop useless loops. When sufficiently grounded, it returns one plain `<plan>...</plan>` XML document in assistant content. Runtime parses and canonically validates that XML locally; malformed XML gets at most one finalization-only correction turn with repository tools closed.

The normalized `PreparedImplementation` carries the ordered plan, synthesized repository facts, `trivial | nontrivial` classification, required mutation anchors, large-mutation decision, and reason. A valid first XML result completes without an extra provider turn, result tool, accepted-result sidecar recovery, or terminal-abort bookkeeping.

The Implementer then starts a fresh coding session. It does not inherit the Planner transcript or repair dialogue. Its first prompt receives the Issue together with `PreparedImplementation`.

This separation keeps discovery isolated from mutation while preserving all useful semantic facts needed by Main.
