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
  ├── inspect repo
  ├── <= 6 evidence
  ├── repositoryFacts
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

The Planner only inspects the repository and produces a bounded handoff:

- a prepared implementation plan;
- up to six repository facts;
- affected files;
- expected checks;
- mutation intent and size.

The Implementer then starts a fresh coding session. It does not inherit the parent transcript, project context, or global context. Its first prompt receives the Issue together with `PreparedImplementation`.

This separation keeps repository discovery bounded, reduces repeated context injection, and gives the coding session a focused starting state before mutation begins.
