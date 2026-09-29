# Productive-progress state machine — 2026-09-29

## Scope

This report records the follow-up investigation and runtime change made after the real-flow failures documented in `2026-09-29-real-flow-ci-analysis.md`.

The new evidence came from two runs on 2026-09-29:

- Implementer issue #4: Actions run `36532754647`, job `109289896187`
- Dispatcher queue scan: Actions run `36533170996`, job `109291202103`

Both runs were active, produced valid reasoning, and continued calling tools, but failed to reach their required productive terminal transition.

## Implementer #4 reproduction

The Implementer successfully completed `prepare_implementation`, received a concrete plan, and classified the task as `normal`.

It then read the relevant Threads contract, adapter, server, mapping, tests, storage model, and reliability code. By response #13 it explicitly stated that it had a comprehensive understanding of the codebase and began designing the implementation in prose.

Observed totals:

- 21 model responses
- 45 tool calls
- 8,948 output tokens
- 724,769 reported total tokens including cache reads
- about 899.3 seconds model response time
- 0 successful `edit`
- 0 successful `write`
- 0 successful `submit_result`

The stage ended with:

`Pi stage implementer exited without its terminal tool`

and the workflow reported no repository changes.

The important signal was already present throughout the run:

`PI_BUDGET_NEXT ... "madeProgress":false`

but the runtime only used that value to control the next response budget. It did not change which actions were legal.

## Dispatcher reproduction

The Dispatcher loaded five prepared candidates and reached the same classification for all of them: `IMPLEMENT`.

It then repeatedly reopened the settled decision with reasoning such as:

- "Let me double-check"
- "Wait, let me reconsider"
- "Let me reconsider once more"
- "I'm now confident"

The final two model responses each reached the 2,048-token ceiling. The second pass again emitted prose instead of the terminal tool.

Observed totals:

- 8 model responses
- 9 tool calls
- 4,711 output tokens
- 137,412 reported total tokens including cache reads
- about 530.9 seconds model response time
- no `submit_result`

The stage ended with:

`Pi stage dispatcher exited without its terminal tool`

This was a clean semantic reasoning-loop reproduction: the classification itself was already settled, but the model continued reconsidering it.

## Root cause in the runtime

Before this change, `ProgressController` had three relevant protections:

1. exact repeated tool-call blocking;
2. a global turn ceiling;
3. `turnMadeProgress` for response-budget selection.

These protections were insufficient for the observed trajectory.

Exact-call blocking could not catch semantically equivalent exploration using different tool arguments. The global turn limit was only a distant emergency ceiling. Most importantly, `turnMadeProgress=false` had no control-flow consequence beyond keeping the next response at SHORT.

Therefore the runtime could observe lack of product progress without forcing a transition from exploration to action.

## Rejected design: fixed no-progress turn counter

A first proposal was to count consecutive turns without mutation and force action after an arbitrary threshold.

That design was rejected because task complexity and required evidence vary too much:

- a difficult task may legitimately need several distinct evidence steps;
- a simple Dispatcher classification may already be stuck after one redundant reconsideration;
- a numeric threshold measures duration, not whether the current transition is justified.

The chosen design instead constrains the legal next state.

## Initial implemented design

The first productive-progress watchdog was a deterministic state machine with one initial evidence action. This section records that historical version. Later runs expanded the bounded startup window; the current policy is **2 initial evidence actions for trivial work and 6 for normal/complex work**.

### Fresh Implementer — historical first version

```text
prepare_implementation
        |
        v
EVIDENCE_ALLOWED
        |
        | one initial evidence action
        v
ACTION_REQUIRED
        |
        +--> edit
        +--> write
        +--> submit_result
        |
        +--> need_more_evidence({missing, reason})
                    |
                    v
              EVIDENCE_ALLOWED
                    |
                    | exactly one evidence action
                    v
              ACTION_REQUIRED
```

Evidence actions include non-mutating repository/research work such as:

- `read`
- `repo_search`
- `trivial_repo_lookup`
- scout/research delegation
- bounded diagnostic commands

The permit is consumed at tool-call time, so one response cannot fan out into multiple parallel exploration calls.

### Concrete blocker escape

`need_more_evidence({missing, reason})` is the only normal way to reopen exploration from `ACTION_REQUIRED`.

It must identify one concrete missing fact and why that fact prevents the next safe mutation or submission. It unlocks exactly one evidence action.

An exact repeated blocker request is rejected. This is intentionally deterministic; the runtime does not ask another LLM whether two blocker descriptions are semantically equivalent.

### Productive actions

The Implementer action state permits:

- `edit`
- `write`
- `submit_result`

Control operations such as `set_response_budget` and the one-time `subagents_enable` do not consume the evidence permit.

### Restored Implementer work

Restored work starts directly in `ACTION_REQUIRED`.

The expected first action remains `submit_result({})`. If validation reports a concrete problem, the agent fixes that problem and retries submission.

### Dispatcher

Dispatcher now has a narrower protocol:

```text
read agents/dispatcher/AGENTS.md
        |
        v
read pi-dispatcher-context.json
        |
        v
ACTION_REQUIRED
        |
        v
submit_result
```

The prepared candidate context is authoritative and sufficient for scope classification. Dispatcher no longer has a mandatory project-documentation exploration phase. After the prepared context is read, repository/docs/history exploration is runtime-blocked.

## Runtime-enforced single-shot preparation

`prepare_implementation` is now configured as a single-use tool.

The second accepted attempt in the same session is blocked by runtime state rather than relying only on the agent contract.

This closes the earlier gap where "call exactly once" was textual guidance but not an enforced transition.

## Logging

`PI_BUDGET` and `PI_BUDGET_NEXT` now include:

`productiveState`

This makes the control state visible in CI traces and allows future incident analysis to distinguish:

- `inactive`
- `evidence_allowed`
- `action_required`

from ordinary token-budget state.

## Validation

Implementation commit:

- `064a78a89e08401f425eae71073d35c87c75b707` — `fix(pi): enforce productive progress state machine`

A stale Dispatcher contract assertion was then aligned with the new protocol:

- `6da3bc652a84fcfda2949aaf0b170d0a9e2ec134` — `test(pi): align dispatcher contract with progress protocol`

Final CI run:

- Actions run `36537093235`
- conclusion: `success`

Validated successfully:

- Ruff
- full product pytest suite
- Agent workflow checks
- Runner autoscaler checks
- Docker job

## What this fixes

The runtime now prevents the main failure observed in #4 and Dispatcher:

```text
evidence
-> more evidence
-> more evidence
-> reconsider
-> more evidence
-> no mutation/terminal action
```

Under that first version, after one evidence action the agent could not keep expanding exploration without declaring one concrete blocker. The current runtime applies the same finite-state rule after its complexity-specific initial allowance (2 actions for trivial, 6 for normal/complex).

This changes productive progress from a passive metric into a control-plane state transition.

## What this does not solve

The state machine is deliberately small and deterministic.

It does not yet provide:

1. a hard aggregate token/turn/wall-time budget for an individual scout/delegate child session;
2. semantic equivalence detection for differently worded `need_more_evidence` blockers;
3. a semantic judge for free-form reasoning text;
4. proof that every model/provider will choose `edit`/`write` immediately once exploration tools are closed.

Pure prose does not unlock more evidence. If the model finishes without the required terminal tool, the existing terminal nudge/gate still applies and the stage cannot be reported successful.

## Current priority after this change

The earlier "productive-progress watchdog" gap is closed at the runtime transition level.

The highest remaining cost-control gap is now the aggregate child-session budget: per-response child limits do not bound total child turns/output/wall time across a multi-turn scout/delegate session.

Future real-flow runs should measure:

- number of `need_more_evidence` calls per issue;
- evidence actions per blocker;
- time from preparation to first mutation;
- attempts to call blocked exploration tools in `ACTION_REQUIRED`;
- main and child token cost;
- whether terminal submission follows mutation without renewed open-ended exploration.


## Regression: differently worded evidence-unlock loop

A later real-flow run exposed a loophole in the first state-machine implementation:

- Implementer issue #4 — Actions run `36539939627`, job `109312697784`
- 37 model responses
- 42 tool calls
- 17,610 output tokens
- 927,310 reported total tokens including cache reads
- 919.2 seconds model response time
- 0 successful repository mutations
- no terminal tool

The runtime correctly reached `ACTION_REQUIRED` and blocked ordinary reads/searches. However, the model discovered that it could repeatedly call `need_more_evidence` with a newly worded missing fact, consume the single evidence permit, return to `ACTION_REQUIRED`, and request another permit.

The trace explicitly showed the loop:

```text
ACTION_REQUIRED
-> need_more_evidence("fact A")
-> one evidence action
-> ACTION_REQUIRED
-> need_more_evidence("fact B")
-> one evidence action
-> ACTION_REQUIRED
-> ...
```

The earlier exact-signature guard only rejected an identical blocker payload. It did not constrain semantically different blocker requests within the same no-mutation period.

### Fix: productive epochs

The runtime now treats evidence reopening as a one-shot escape hatch within a productive epoch:

```text
successful prepare_implementation
-> initial evidence permit
-> ACTION_REQUIRED
-> at most one need_more_evidence
-> one evidence action
-> ACTION_REQUIRED
-> edit/write/submit_result required
-> successful productive action resets the epoch
```

Rules:

- one extra evidence unlock is allowed between successful productive actions;
- changing `missing` or `reason` does not create another permit;
- a failed `edit`, `write`, or terminal submission does not reset the permit;
- a successful productive action resets the epoch and permits a future concrete blocker if later work genuinely needs one;
- the design remains state-based rather than imposing a generic tool-call or no-progress-turn quota.

This regression is covered in `tests/pi-progress-controller.test.mjs`.

The incident also confirmed that `madeProgress:false` and `productiveState:"action_required"` were being logged correctly; the missing protection was specifically the ability to reopen evidence repeatedly without an intervening productive action.


## Regression: forced action before sufficient evidence

A later clean real-flow rerun exposed the opposite failure mode after the productive-epoch fix:

- Implementer issue #4 — Actions run `36543597806`, job `109324580830`
- 6 model responses
- 5 tool calls
- 5,520 output tokens
- 89,693 reported total tokens including cache reads
- about 273.0 seconds model response time
- 0 repository mutations
- no terminal tool

The runtime correctly prevented repeated evidence reopening, but the initial evidence allowance was too narrow. After preparation, main attempted a bounded read/search sequence. The first deterministic search was not sufficient to locate the implementation target, and the one `need_more_evidence` permit was then consumed by a path search that returned no useful target. Runtime moved to `ACTION_REQUIRED` even though the model still did not know a safe file/anchor to edit.

The trace reached the explicit contradiction:

`productiveState:"action_required"`

while the model reported that it still did not know the relevant repository path. The remaining responses were spent reasoning about how to obey the runtime contract rather than implementing the issue, and the stage ended with `Pi stage implementer exited without its terminal tool`.

### Fix: bounded initial evidence chain

Fresh Implementer work now receives an initial evidence budget of **three** accepted evidence actions after `prepare_implementation`:

```text
prepare_implementation
        |
        v
EVIDENCE_ALLOWED (3)
        |
        +--> locate
        +--> read target
        +--> obtain exact edit anchor / one final bounded fact
        |
        v
ACTION_REQUIRED
```

The budget is consumed at accepted tool-call time, so exploration is still bounded and parallel fan-out cannot become unlimited. Three actions are enough for the common `repo_search -> read -> anchor` path while still forcing a transition to mutation/submission quickly.

The productive-epoch rule remains unchanged after the initial budget is exhausted:

- at most one `need_more_evidence` unlock before the next successful productive action;
- that unlock permits exactly one evidence action;
- differently worded blockers do not create new permits;
- failed edits/writes/submissions do not reset the epoch;
- successful `edit`, `write`, or `submit_result` resets the extra-evidence eligibility.

This change addresses **forced action without sufficient evidence** without returning to open-ended exploration or a generic no-progress turn counter.


## Confirmation run: state machine is steering in the right direction

The next real implementation attempt on issue #4 provided stronger evidence that the productive-progress design is directionally correct:

- Actions run `36543597806`, job `109330983540`
- workflow conclusion: `success`
- 98 model responses
- 101 tool calls
- 53,964 output tokens
- 4,463,917 reported total tokens including cache reads
- about 2,879.7 seconds model response time
- PR #146 created successfully
- issue transitioned to `pi:mr-created`
- checkpoint publication and cleanup completed successfully

The important result is not the cost; the run remained much too expensive. The important result is that the runtime state was correctly identifying the trajectory.

Across the 98 main responses:

- 40 turns were logged with `madeProgress:true`;
- 58 turns were logged with `madeProgress:false`;
- `productiveState:"action_required"` was active for 94 turns;
- the longest uninterrupted no-progress streak was 17 turns, from turn 1 through turn 17.

This confirms that the state machine is observing the right failure class. The model repeatedly entered a state where more free exploration was not justified, and the runtime correctly represented that as `ACTION_REQUIRED`.

The remaining gap is therefore narrower than the original watchdog problem:

> detection is working; action enforcement and recovery behavior still need tightening.

A particularly useful failure pattern occurred after the agent introduced `tests/__init__.py` and caused existing pytest import behavior to regress. The model eventually identified the correct conceptual recovery — remove or roll back the change — but then spent many responses inventing compensating `sys.path` shims and repeatedly reconsidering pytest import semantics.

That gives us a concrete next target: rollback/revert of the agent's own harmful mutation must be treated as a first-class productive action, and `ACTION_REQUIRED` should make repeated evidence-only reconsideration progressively harder rather than merely recording it.

This run therefore strengthens, rather than weakens, the current architecture:

- do not return to a generic fixed no-progress turn counter;
- keep the explicit productive-progress state machine;
- improve what actions are legal and preferred inside `ACTION_REQUIRED`;
- measure future changes against time-to-first-mutation, no-progress streak length, and mutation-to-submit delay.


## Follow-up: rollback and bounded validation recovery

The successful-but-expensive issue #4 run showed that detection was correct but recovery behavior was still too permissive. Two runtime changes were added.

### 1. Last-mutation rollback is a productive action

Implementer now exposes `rollback_last_mutation`.

Before each accepted `edit` or `write`, runtime captures the exact file state. After a successful mutation that snapshot becomes the rollback target. If the mutation created a new file, rollback removes that file; if it changed an existing file, rollback restores the exact previous bytes.

This deliberately avoids a coarse `git restore <path>`, which could erase earlier valid work in the same file.

A successful rollback is treated as productive progress and resets the productive epoch. The agent contract now explicitly prefers rollback when validation shows that the latest local mutation itself caused the regression, rather than layering compensating workarounds on top.

### 2. Failed terminal validation enters bounded recovery

A failed `submit_result` no longer returns the Implementer to ordinary exploration.

Runtime enters a dedicated recovery state:

```text
submit_result fails
        |
        v
RECOVERY_EVIDENCE_ALLOWED (1)
        |
        +--> at most one diagnostic evidence action
        |
        v
RECOVERY_ACTION_REQUIRED
        |
        +--> edit/write an already-mutated file
        +--> rollback_last_mutation
        +--> retry submit_result
```

During recovery:

- `need_more_evidence` cannot reopen a new exploration epoch;
- only one diagnostic evidence action is available per failed validation attempt;
- new unrelated file mutations are blocked;
- after that diagnostic action, further read/search/scout work is blocked;
- successful corrective edits remain in recovery until terminal validation succeeds;
- rollback exits recovery and starts a new productive epoch from the restored state.

This directly targets the `tests/__init__.py` failure pattern from job `109330983540`: once validation demonstrates that a mutation is harmful, the preferred trajectory becomes diagnose once -> fix or rollback -> validate, rather than repeated semantic reconsideration and workaround accumulation.


## Regression: issue #148 exhausted discovery before inspection

A real Implementer run on issue #148 exposed a second case where the three-action startup budget was still too small for a normal product change:

- Actions run `36565564926`, job `109396511401`
- Orbit Local setup/indexing: successful
- Implementer responses: 9
- tool calls: 16
- reported total tokens including cache reads: 155,640
- model response time: about 407.6 seconds
- repository mutations: 0
- terminal tool: not called
- final stage error: `Pi stage implementer exited without its terminal tool`

The agent used the three startup evidence permits on repository discovery, then used the one extra `need_more_evidence` permit to read the Threads tool contract. It still had not inspected the existing Threads adapter, registration/caller pattern, or tests. Runtime then entered `ACTION_REQUIRED` and blocked those reads. The model correctly recognized that editing without those files would be blind, but the state machine gave it no safe path forward. Several responses were then spent reasoning about the deadlock instead of implementing the issue.

This is a useful negative benchmark because it separates two concerns clearly:

- the anti-loop guard correctly prevents unlimited exploration;
- the startup evidence budget must still be large enough for one bounded implementation chain before forcing mutation.

### Fix: six-action initial evidence window

At this point in the rollout, fresh Implementer work was expanded to **six** initial evidence actions after `prepare_implementation`. The intended shape was one narrow chain, for example:

```text
locate
-> contract/spec
-> target implementation
-> registration/caller
-> directly relevant test/pattern
-> exact mutation anchor
-> edit/write/submit_result
```

The runtime still counts accepted evidence tool calls and transitions to `ACTION_REQUIRED` when the configured initial allowance is exhausted. The one-shot `need_more_evidence` escape hatch remains unchanged and is reserved for one concrete fact outside that bounded initial chain. Subsequent tuning made the allowance complexity-aware: **2 initial evidence actions for trivial work, 6 for normal work, and 6 for complex work**. This keeps the state machine finite while avoiding the #148 failure mode where the model was forced to choose between blind mutation and protocol deadlock.

Orbit remains complementary evidence. The #148 run confirmed that Orbit indexing completed successfully, but the main agent did not invoke Orbit graph queries; this benchmark therefore should not be interpreted as an Orbit failure. Future runs should prefer Orbit for bounded structural questions and Zoekt/repo search for literal/path discovery, but neither should consume the entire startup window before direct target inspection.
