# Real-flow CI analysis — 2026-09-29

## Scope

This report records what happened during the first real multi-issue Pi flow after real tasks were marked ready for Dispatcher on 2026-09-28.

Observed window: approximately **2026-09-28 22:43 UTC through 2026-09-29 00:38 UTC**.

The main conclusion is that GitHub Actions infrastructure, Dispatcher, state transitions, and Reconciler were broadly functional. The dominant failure was inside the Implementer trajectory: agents spent large amounts of model time and context on preparation, reading restrictions, and delegated reconnaissance, but did not transition from evidence gathering to repository mutation and terminal submission.

## Outcome summary

| Issue | Workflow outcome | Reported total tokens | Reported model time | Final repository outcome |
| --- | --- | ---: | ---: | --- |
| #95 — Enforce granted capabilities before platform operations | failure | 550,135 | 3,035.7 s | no edit/write; `pi:needs-human` |
| #97 — Add SQLite schema versioning and migrations | failure | 540,614 | 3,047.2 s | no edit/write; `pi:needs-human` |
| #79 — Implement TikTok OAuth connection and reconnect through Web Admin | failure | 610,011 | 3,859.7 s | no new change; `pi:needs-human` |
| #17 — Threads: token lifecycle and connection status | failure | 1,010,812 | 3,573.3 s | no edit/write; `pi:needs-human` |

Combined across these four Implementer runs:

- **2,711,572 reported tokens**
- **13,515.9 seconds / about 3 h 45 min of aggregate model time**
- **0 completed product mutations**
- **0 successful terminal submissions**

The jobs ran concurrently, so aggregate model time is not wall-clock elapsed time.

## Dispatcher behavior

Dispatcher run **#143** successfully prepared two remaining candidates and classified both as `IMPLEMENT`:

- #79 — TikTok OAuth connection/reconnect
- #17 — Threads token lifecycle

The decisions were consistent with the Dispatcher contract: both issues describe coherent single outcomes and do not require a separately mergeable architecture stage.

The Dispatcher was nevertheless verbose. It repeatedly re-argued the same classification and consumed a full 2,048-token reasoning response before submitting the result. This is a smaller version of the same reasoning-before-action pattern seen in Implementer.

## Implementer #95

Run: https://github.com/YuriiSokolenko/social-mcp/actions/runs/36494034412

Observed sequence:

1. `prepare_implementation` completed and classified the issue as `complex`.
2. Direct broad shell exploration was blocked as designed.
3. A scout gathered repository context.
4. Main attempted direct reads without a valid bounded limit; they were blocked.
5. Main performed one successful bounded read of `src/social_mcp/server/capabilities.py`.
6. Attempting to continue reading the same file via another `read` was blocked by the one-file-per-task rule.
7. Main delegated again.
8. The second scout ran for about **1,673.5 seconds** and reported **11,168 output tokens**.
9. Main then spent two full 2,048-token turns reconsidering scope and architecture.
10. No `edit`, `write`, or `submit_result` occurred.

Runtime correctly failed the stage with:

`Pi stage implementer exited without its terminal tool`

The issue was moved to `pi:needs-human`.

## Implementer #97

Run: https://github.com/YuriiSokolenko/social-mcp/actions/runs/36494042008

Observed sequence:

1. `prepare_implementation` completed in about 43 seconds and classified the task as `complex`.
2. Scout found the SQLite storage/startup paths.
3. Main read the SQLite implementation.
4. Additional direct reads hit the one-file-per-task guard.
5. More scout/delegate work extracted test fixtures and transaction behavior.
6. By this point the agent had sufficient evidence to implement the migration mechanism.
7. Instead of mutating the repository, main continued designing transaction boundaries and migration behavior in reasoning.
8. The final main response again reached exactly 2,048 output tokens without a mutation.

Result:

- **540,614 tokens**
- **3,047.2 s model time**
- no repository changes
- `pi:needs-human`

This run is strong evidence that the current bottleneck is not lack of repository understanding. The model had enough information but did not cross the reasoning-to-action boundary.

## Implementer #79

Run: https://github.com/YuriiSokolenko/social-mcp/actions/runs/36495146189

This was the clearest example of compounded control-plane and delegation cost.

### Preparation failures

The first `prepare_implementation` timed out after about 120 seconds:

`implementation-planner failed: Subagent timed out after 120000ms`

A second main-level retry triggered the planner's internal structured-output retry and still failed:

`Missing structured_output call; this step has outputSchema and must finish by calling structured_output.`

Because complexity had not been recorded, normal repository work remained runtime-blocked. The model spent several turns reasoning about whether it was allowed to retry preparation, use `bash`, read a file, or call `submit_result`.

A third main-level preparation attempt finally completed and classified the issue as `complex`.

### Delegation explosion

After preparation:

- broad scout exploration timed out at exactly **1,800 seconds**;
- main then tried to recover partial output;
- additional targeted scouts were launched;
- delegate calls followed;
- one delegate response reported **28,102 output tokens**.

Despite this, no mutation was made. The stage ended with no terminal tool and issue #79 moved to `pi:needs-human`.

The pipeline summary also surfaced the old closed PR #91, but no new implementation was published.

## Implementer #17

Run: https://github.com/YuriiSokolenko/social-mcp/actions/runs/36495153562

This run consumed the most total context.

Observed behavior:

1. Planner missed structured output once and was retried internally.
2. Preparation eventually completed after about **228 seconds** with complexity `normal`.
3. Main spent multiple turns figuring out how to access scout.
4. A scout ran for about **810 seconds**.
5. The one-file-per-task direct-read rule repeatedly shaped the trajectory.
6. A delegate then ran for about **1,210 seconds** and returned **11,274 output tokens**.
7. Main additionally performed external research on Threads token behavior.
8. Main synthesized the implementation in reasoning but never called `edit` or `write`.
9. A final 2,048-token reasoning turn ended without `submit_result`.

Result:

- **1,010,812 reported tokens**
- **3,573.3 s model time**
- no repository change
- `pi:needs-human`

## The one-file direct-read rule was counterproductive

At the time of these runs, the Implementer contract/runtime allowed only one direct main-agent file read per task, with a per-call limit of 200 lines.

The intent was to keep exploratory context out of main. In practice the rule repeatedly caused this pattern:

1. main obtains one useful file;
2. the next already-known file is blocked;
3. main reasons about the restriction;
4. main launches scout/delegate;
5. the child reads much more context than the main agent needed;
6. child output/context becomes substantially more expensive than another bounded direct read.

The rule therefore optimized a cheap operation at the cost of expensive child sessions.

### Decision

Remove the **per-task file-count cap**.

The first follow-up removed the per-task file-count cap while retaining a 200-line per-call cap. That remaining cap was then removed as well because it was trivially bypassable with sequential reads and created more policy surface for the model to reason about.

Current rule:

- already-known paths may be read directly without a runtime line-count or file-count cap;
- unknown-path discovery, broad repository search, large dumps, logs, and cross-repository reconnaissance still go to scout;
- the routing boundary is now based on **known path vs. exploration**, not arbitrary read size.

This keeps the control simple and avoids turning cheap direct reads into another source of meta-reasoning.

## Subagent response budget observation

Logs often show:

`PI_SUBAGENT_BUDGET {"maxTokens":2048}`

but individual delegated sessions later report outputs such as:

- 4,278 tokens
- 7,099 tokens
- 11,168 tokens
- 12,337 tokens
- 28,102 tokens

This is consistent with the configured ceiling applying to an individual child model response, not the entire multi-turn child session. Therefore `maxTokens=2048` should not be treated as a total delegation-cost ceiling.

A separate total child-session budget or productive-progress limit is needed if we want deterministic upper bounds on delegated cost.

## Historical watchdog gap (resolved later on 2026-09-29)

The current idle/stall protections are aimed at periods with no activity. These failures remained "active":

- model responses continued;
- tools continued to be called;
- scouts and delegates continued running.

But **product state did not advance**.

A useful next guard should distinguish activity from productive progress. Candidate progress events include:

- successful `edit` / `write`;
- a new working-tree diff;
- successful terminal submission;
- a concrete validation failure that changes the next action;
- a newly discovered minimal edit anchor that is immediately followed by mutation.

Repeated reasoning, additional repository summaries, and additional broad child investigations should not indefinitely reset a productive-progress deadline.

## Architect #100 cancellation race

Architect run: https://github.com/YuriiSokolenko/social-mcp/actions/runs/36494047733

The Architect was analyzing #100 when the issue was closed. Cancellation was expected, but cleanup attempted to transition the already-closed issue back to an unowned Dispatcher state and failed with:

`cannot transition closed issue to unowned`

The final issue state was not corrupted. A cancellation cleanup path should simply no-op when the issue is already closed.

## Reconciler state

Scheduled Reconcile run **#14** completed successfully and reported:

`Pipeline reconciler: 0 object(s) need attention; mode=apply-safe-repairs; automation=RUNNING; issue-recovery=enabled; pr-recovery=enabled`

This is correct for the resulting state: #17, #79, #95, and #97 were already parked at `pi:needs-human`, so Reconciler did not automatically redispatch them.

## Ordinary CI failures before the real flow

The preceding red `ci.yml` runs #1968 through #1971 were not the cause of the real-task failures.

Those runs were intermediate control-plane changes with assertion mismatches against the evolving Implementer contract text. Subsequent runs:

- #1972 — success
- #1973 — success

Therefore the real-task failures should be analyzed primarily as agent/runtime behavior, not as a broken repository CI baseline.

## Conclusions

1. **Dispatcher/Reconciler/state transitions broadly worked.**
2. **The dominant failure is reasoning-to-action transition failure.**
3. **The one-file direct-read cap materially amplified cost and delegation.**
4. **Planner failure is dangerous because preparation is an enforced gateway.**
5. **Scout/delegate sessions need a total-session cost/progress bound, not only per-response max tokens.**
6. **At this point in the investigation, idle watchdogs were insufficient and a productive-progress runtime guard was still needed.** This was later addressed by the state-machine change documented at the end of this report.
7. **Runtime correctly refused to mark no-terminal/no-change runs green.**

The immediate follow-up removed both the one-file-per-task cap and the later 200-line per-call cap. Known-path reads now stay in main without an arbitrary size/count quota. Subsequent changes also added deterministic main-agent repository search and made closed-issue cancellation cleanup idempotent.

## Post-fix reassessment

Reassessment after commit `09d5aa6` and green CI run `36526006149`:

1. **The direct-read routing mistake is fixed.** Main can read already-known files without arbitrary line/file-count limits, and inspecting multiple known files is no longer a reason to delegate.
2. **Deterministic discovery now has the correct place in the cost hierarchy.** `repo_search` handles literal path/content discovery in main without launching another model. The preferred flow is now `repo_search -> read -> scout only if semantic interpretation is still needed`.
3. **Scout is closer to the intended role but remains the most dangerous cost amplifier.** Its launch conditions are narrower, but a child session still has no hard aggregate session budget for total turns/output/wall time.
4. **At this reassessment point, the core reasoning-to-action failure was still open.** Laguna could reach sufficient repository evidence and continue reconsidering instead of calling `edit`/`write`. This was later addressed by the productive-progress state machine described below.
5. **At this reassessment point, `prepare_implementation` was still only textually single-shot.** Runtime single-use enforcement was added later in the same 2026-09-29 follow-up described below.
6. **The Architect #100 cancellation race is fixed narrowly and safely.** A `stopped` transition on an already-closed issue is now an explicit no-op; unrelated invalid state transitions remain errors.
7. **The system is materially better positioned for the next real-flow experiment.** The next run should measure how many `repo_search`/direct-read operations replace former scout calls, how many child sessions remain, and how many model turns elapse between the last new evidence and the first repository mutation.

### Remaining high-priority work at that reassessment point

At the time of the `09d5aa6` reassessment, the remaining major controls were:

1. runtime-enforced single-shot preparation with internal retry/fallback;
2. hard aggregate budget for scout/delegate sessions;
3. productive-progress watchdog tied to repository mutation or terminal state.

The first and third items were subsequently addressed by the 2026-09-29 productive-progress state-machine change described below. The aggregate child-session budget remains open.

## Second real-flow reproduction and watchdog implementation

Later runs reproduced the same reasoning-to-action failure more cleanly:

- Implementer #4 — run `36532754647`, job `109289896187`
- Dispatcher — run `36533170996`, job `109291202103`

Implementer #4 completed preparation and accumulated enough repository evidence to describe the implementation, but finished after 21 model responses and 45 tool calls with no `edit`, `write`, or `submit_result`. Dispatcher reached a stable classification for all five candidates, then repeatedly reconsidered the same decisions and exhausted two 2,048-token responses without calling `submit_result`.

The important runtime finding was that `madeProgress:false` already existed in the logs, but `ProgressController` used it only for response-budget selection. Lack of productive progress did not constrain the next legal action.

A fixed "N turns without progress" watchdog was considered and rejected because it measures duration rather than whether the next transition is justified. The implemented design is instead a deterministic state machine:

```text
prepare_implementation
  -> EVIDENCE_ALLOWED
  -> one evidence action
  -> ACTION_REQUIRED
       -> edit/write/submit_result
       -> need_more_evidence({missing, reason})
            -> one evidence action
            -> ACTION_REQUIRED
```

Additional enforcement:

- `prepare_implementation` is now runtime single-shot;
- the evidence permit is consumed at tool-call time, so parallel exploration cannot fan out;
- exact repeated `need_more_evidence` blockers are rejected;
- restored Implementer work begins in `ACTION_REQUIRED`;
- Dispatcher moves directly from its prepared candidate context to terminal-only submission;
- Dispatcher no longer performs a mandatory project-documentation exploration phase;
- `productiveState` is emitted in the budget logs for trace analysis.

Implementation:

- `064a78a89e08401f425eae71073d35c87c75b707` — `fix(pi): enforce productive progress state machine`
- `6da3bc652a84fcfda2949aaf0b170d0a9e2ec134` — contract-test alignment

Validation:

- CI run `36537093235` — **success**
- Ruff — success
- full pytest — success
- Agent workflow checks — success
- Runner autoscaler checks — success
- Docker — success

The detailed incident/design report is `docs/llm-research/2026-09-29-productive-progress-state-machine.md`.

### Current remaining high-priority work

1. **Hard aggregate child-session budget** for scout/delegate total turns/output/wall time.
2. **Semantic blocker-equivalence research** if differently worded `need_more_evidence` requests become a new loop surface.
3. **Real-flow measurement** of preparation-to-first-mutation time, blocked exploration attempts, blocker count, and child cost under the new state machine.
