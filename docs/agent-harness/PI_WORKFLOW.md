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
                    │       │ - opaque planText        │
                    │       │ - layout hint            │
                    │       │ - harness metadata       │
                    │       │ - fallback on failure    │
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
  ├── finalize as ordinary plain text / Markdown
  ├── preserve opaque planText verbatim
  ├── fail closed on empty / incomplete / truncated final
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

The Planner inspects the repository with its read-only evidence tools, then emits one ordinary plain-text/Markdown final response. The harness persists that response verbatim as opaque `PreparedImplementation.planText` (no XML/JSON schema, parser, or format-repair turn). Empty, incomplete or truncated finals and provider failures produce a safe fallback artifact. The provider completion ceiling remains 2048 tokens; there is no separate character or byte limit on the handoff.

The v2 `PreparedImplementation` contains `planText`, status/fallback reason, harness-owned conservative metadata and the resolved layout hint. Legacy v1 artifacts are migrated at the read boundary. Main and the fresh coding session receive the complete Planner text as explicitly untrusted data, not as instructions or accepted mutation scope; they do not inherit the Planner transcript.

**Intentional behavior change:** the old `validateResolvedTargetPaths` check over Planner-produced structured paths is removed because free-form `planText` is not an authoritative target declaration. Resolved layout targets and mutation-scope enforcement must come from independent trusted harness context and final validation, not from parsing Planner text.

Validation-repair receives the original untrusted `planText` alongside authoritative bounded diagnostics and accepted-scope facts. This keeps discovery separate from mutation without dropping the plan during repair.
