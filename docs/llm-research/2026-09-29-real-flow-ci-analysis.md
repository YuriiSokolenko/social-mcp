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

Keep the useful bound:

- each direct `read` must remain explicit and bounded to `limit <= 200`;
- unknown-path discovery, broad repository search, large dumps, logs, and cross-repository reconnaissance should still go to scout;
- already-known paths may be read directly as many times/files as needed for the immediate implementation decision.

This change is implemented in the same repository update as this report.

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

## Watchdog gap

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
6. **Idle watchdogs are insufficient; productive-progress watchdogs are needed.**
7. **Runtime correctly refused to mark no-terminal/no-change runs green.**

The immediate change from this incident is to remove the one-file-per-task direct-read rule while retaining the 200-line per-call bound and delegated search/discovery model.
