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

## Implemented design

The productive-progress watchdog is now a deterministic state machine.

### Fresh Implementer

```text
prepare_implementation
        |
        v
EVIDENCE_ALLOWED
        |
        | one evidence action
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

After one evidence action the agent cannot keep expanding exploration without declaring one concrete blocker.

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
