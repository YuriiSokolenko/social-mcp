# Four-task implementer experiment after PR #274

Date: 2026-10-01  
Repository: `YuriiSokolenko/social-mcp`  
Baseline branch: `dev`  
Baseline SHA: `46224c5ad58bc5b8c0dd029eba27bbe00042e60a`  
Baseline change: PR #274, "Implementer coding phase as a same-session 16K continuation (#273)"  
Backend: Pi / Laguna  
Experiment status: **in progress**

## Purpose

This document is a running evidence log for a four-task experiment against the implementer harness after PR #274.

The experiment is intentionally broader than the earlier Arkanoid/Breakout smoke tests. The four tasks exercise different kinds of normal repository work:

1. a small local regex/redaction change in existing code;
2. an asyncio concurrency primitive with cancellation behavior;
3. a deterministic time-window data structure;
4. a bounded typed event buffer with defensive-copy and JSON-export behavior.

The goal is to observe the complete implementer path under realistic variation:

- preparation/planner behavior;
- parent response budget behavior;
- evidence/orientation actions;
- transition into the coding session;
- same-session large mutation behavior;
- validation through `run_check`;
- terminal `submit_result`;
- publication of branch/PR;
- loop-guard behavior and failure recovery;
- token/time cost.

Detailed Rabbit traces can be appended later. This file should preserve the high-level experimental record even when raw logs are stored elsewhere.

## Test matrix

| Test | Issue | Task | Workflow run | Job | Snapshot result |
| --- | --- | --- | --- | --- | --- |
| 1 | #287 | JSON-style secret redaction | [36889307806](https://github.com/YuriiSokolenko/social-mcp/actions/runs/36889307806) | [110460580070](https://github.com/YuriiSokolenko/social-mcp/actions/runs/36889307806/job/110460580070) | **Failed / needs human** |
| 2 | #288 | asyncio keyed single-flight | [36889316531](https://github.com/YuriiSokolenko/social-mcp/actions/runs/36889316531) | 110460606310 | **In progress** |
| 3 | #289 | deterministic rolling event window | [36889325069](https://github.com/YuriiSokolenko/social-mcp/actions/runs/36889325069) | 110460637461 | **In progress** |
| 4 | #290 | bounded diagnostic event buffer | [36889334931](https://github.com/YuriiSokolenko/social-mcp/actions/runs/36889334931) | 110460670996 | **In progress** |

Snapshot taken while tests #288-#290 were still inside **Run implementation backend with live progress**. Their final outcome must be updated after completion.

---

## Test 1 — #287 JSON-style secret redaction

Issue: https://github.com/YuriiSokolenko/social-mcp/issues/287  
Run: https://github.com/YuriiSokolenko/social-mcp/actions/runs/36889307806  
Job: https://github.com/YuriiSokolenko/social-mcp/actions/runs/36889307806/job/110460580070

### Intended task

Extend `src/social_mcp/platforms/mapping.py` so sensitive values are also redacted in JSON/JSON-like colon syntax while preserving existing `key=value`, Bearer, and Basic redaction. Add focused pytest coverage and pass Ruff/`run_check`.

This is a small, local production-code change and should not require harness/control-plane modifications.

### Final workflow result

- Workflow job: **failure**
- Issue state after run: **open**
- Harness label: **`pi:needs-human`**
- Repository changes: **none**
- Branch publication: **skipped**
- PR creation: **skipped**
- Validation: **never reached**
- Mutation/coding session: **never reached**
- Terminal `submit_result`: **never called**

The harness reported:

> Pi stage implementer exited without its terminal tool

and then:

> Pi completed the task but produced no repository changes. Human review is required.

### Model/runtime metrics

From the GitHub Actions job summary:

- model responses: **5**
- fresh input: **32,371 tokens**
- output: **692 tokens**
- cache read: **20,186 tokens**
- total tokens: **53,249**
- model response time: **168.6 s**
- agent pass time: **303.1 s**
- tool actions recorded: **8**
- parent response ceiling: **2048 tokens on every observed parent turn**
- large mutation budget: **idle throughout**

This run therefore confirms the parent stayed at the intended short budget, but it did **not** exercise the new coding-session / large-mutation path.

### Event sequence

1. Model #1 identified the correct target and said it needed to read `mapping.py`.
2. It invoked `prepare_implementation` and also attempted a `read` before preparation had completed.
3. The runtime correctly blocked that read because the session was still behind the preparation gate.
4. The implementation planner then timed out after **120,000 ms**.
5. The runtime emitted:
   - `PI_SUBAGENT_FAILURE` with `planner_infrastructure_failure`;
   - `PI_PREPARATION_FALLBACK`;
   - an explicit instruction that preparation was satisfied and normal implementation could continue.
6. Model #2 explicitly said it would now read the redaction code and tests.
7. Instead of reading, it issued repeated `lsp_start_server` actions for the same Python workspace.
8. One startup succeeded; other calls were rejected or returned the same already-started state.
9. Model #3 again repeated `lsp_start_server`.
10. The semantic loop guard detected `repeated_observation` and steered the model.
11. Model #4 explicitly acknowledged the problem and wrote that it would read the source directly.
12. It nevertheless called `lsp_start_server` again.
13. The loop guard escalated to `repeated_failed_strategy` and aborted that strategy.
14. Model #5 returned no useful tool action.
15. The pass settled without mutation and without the required terminal tool.
16. The workflow correctly refused to publish an empty result and transitioned the issue to `pi:needs-human`.

### What worked

- The parent stayed at **2048 tokens**.
- Planner failure became explicit `PREPARATION_FALLBACK` instead of the older deadlock state.
- The harness did not fabricate successful implementation.
- The semantic loop guard eventually detected the repeated LSP startup strategy.
- No empty branch/PR was published.
- The workflow surfaced the result as `pi:needs-human`.

### What failed

#### Model/agent behavior

The main model ignored both its own stated plan and the runtime directive.

It repeatedly said variants of "read the file" but selected `lsp_start_server` instead. This is the primary behavioral failure in this run.

The most useful contrast is:

- model prose: read source/tests;
- actual tool choice: start an already-started LSP server again.

#### Harness/runtime behavior

The harness contained the failure but did not prevent enough wasted work.

Observed weaknesses:

- the planner consumed the full 120-second timeout before fallback;
- after a successful LSP startup, identical startup actions were still possible;
- repeated startup calls consumed several model turns before the loop guard aborted;
- an already-started server was represented in a way that still allowed the model to treat startup as a meaningful next action.

### Preliminary interpretation

This failure is **not evidence against the delegated mutation/coding-session design**, because the run never reached that part of the pipeline.

It is evidence for a different failure mode:

`planner timeout -> preparation fallback -> wrong repeated orientation/startup tool -> loop guard abort -> no terminal result`

The primary trigger is model tool-selection behavior. The harness contributes by allowing an already-satisfied startup action to remain repeatedly selectable and by waiting 120 seconds for the planner before fallback.

The loop guard itself behaved usefully: it identified and stopped the doom loop rather than allowing indefinite repetition.

### Candidate follow-up regression

A focused harness regression should cover:

`PREPARATION_FALLBACK -> successful lsp_start_server -> repeated identical lsp_start_server`

Expected behavior:

- first successful startup establishes the reusable server state;
- another identical startup should be treated as already satisfied/no-op;
- it should not count as productive progress;
- the runtime should immediately steer toward an actual read/LSP query/implementation action;
- repeated identical startup should not require several full model turns before being rejected.

---

## Test 2 — #288 asyncio keyed single-flight

Issue: https://github.com/YuriiSokolenko/social-mcp/issues/288  
Run: https://github.com/YuriiSokolenko/social-mcp/actions/runs/36889316531  
Job ID: `110460606310`

### Intended task

Implement a typed keyed single-flight async helper with:

- same-key coalescing;
- independent execution for different keys;
- exception fan-out and later retry;
- cancellation-safe waiters;
- cleanup after success/failure;
- focused pytest-asyncio coverage.

### Current result

**In progress at snapshot time.**

Completed workflow setup successfully through:

- checkout;
- issue validation/labels;
- temporary worktree;
- Python environment;
- Orbit code graph;
- run-check sandbox preparation.

Current step: **Run implementation backend with live progress**.

### Final result

Pending.

### Rabbit evidence

Pending. Claude/Rabbit logs can be appended here if deeper per-turn evidence is needed.

---

## Test 3 — #289 deterministic rolling event window

Issue: https://github.com/YuriiSokolenko/social-mcp/issues/289  
Run: https://github.com/YuriiSokolenko/social-mcp/actions/runs/36889325069  
Job ID: `110460637461`

### Intended task

Implement a deterministic stdlib-only rolling-window event counter with an injected monotonic clock, expiration/boundary semantics, category counts, bounded growth, and focused tests.

### Current result

**In progress at snapshot time.**

Workflow setup completed successfully and the job is currently inside **Run implementation backend with live progress**.

### Final result

Pending.

### Rabbit evidence

Pending. Claude/Rabbit logs can be appended here if deeper per-turn evidence is needed.

---

## Test 4 — #290 bounded diagnostic event buffer

Issue: https://github.com/YuriiSokolenko/social-mcp/issues/290  
Run: https://github.com/YuriiSokolenko/social-mcp/actions/runs/36889334931  
Job ID: `110460670996`

### Intended task

Implement a bounded typed in-memory event buffer with sequence numbers, eviction, filtering, explicit clear semantics, immutable/defensive snapshots, and deterministic JSON-compatible export.

### Current result

**In progress at snapshot time.**

Workflow setup completed successfully and the job is currently inside **Run implementation backend with live progress**.

### Final result

Pending.

### Rabbit evidence

Pending. Claude/Rabbit logs can be appended here if deeper per-turn evidence is needed.

---

## Cross-test conclusions

These conclusions are provisional until #288-#290 finish.

### 1. The 2048-token parent ceiling is holding

Test #287 kept every observed parent response at the short 2048-token ceiling. There was no accidental blanket 16K grant.

That is an important positive result from the PR #274 design.

### 2. A failed run can occur before the mutation architecture is exercised

#287 failed entirely in the preparation/orientation phase.

Therefore experiments must distinguish at least:

- preparation failure;
- evidence/orientation failure;
- coding-session handoff failure;
- mutation generation failure;
- validation failure;
- publication failure.

A single "task failed" number is too coarse to evaluate the architecture.

### 3. Planner reliability and planner timeout remain part of end-to-end cost

The planner timed out at 120 seconds in #287. Fallback prevented the old preparation deadlock, which is progress, but a planner failure can still consume substantial wall time before useful work starts.

We should track planner success/failure and planner latency independently from main-model implementation quality.

### 4. One-shot initialization tools need stronger state semantics

An already-running LSP server should not remain an attractive repeated action.

For stateful initialization tools, the harness should make the satisfied state obvious and cheap:

- return/reuse existing state;
- classify repeats as no-op;
- do not count them as productive progress;
- steer immediately to the next class of action.

### 5. Model intent and tool choice need to be measured separately

In #287 the model's prose repeatedly described the correct next action, while its tool calls did something else.

Rabbit analysis should therefore capture:

- stated next action/intention;
- actual tool selected;
- tool arguments;
- tool result;
- next tool selection.

This will help distinguish reasoning problems from tool-selection/serialization/runtime problems.

### 6. The semantic loop guard is useful but should be the last line of defense

The loop guard correctly detected the repeated LSP strategy and eventually aborted it.

The better target is to prevent obviously redundant state-initialization calls before the general loop guard has to intervene.

### 7. Do not attribute #287 to the 16K coding session

No `begin_coding_session`, mutation handoff, large mutation turn, `run_check`, or `submit_result` happened.

#287 currently provides no evidence about whether the same-session 16K coding continuation succeeds or fails once reached.

---

## Data to collect for every run

When the experiment is complete, record the same fields for all four runs:

| Dimension | Data |
| --- | --- |
| Outcome | success / failure / needs-human / cancelled |
| PR | created? number? |
| Parent turns | count |
| Parent token ceiling | per turn |
| Planner | success/failure, retries, latency |
| Preparation fallback | yes/no |
| Evidence actions | count + tool types |
| Coding session entered | yes/no |
| Large mutation budget used | yes/no |
| Mutation turns | count |
| Validation | commands/check types + pass/fail |
| Fix loop | number of mutation/check iterations |
| Loop guard | none/steer/abort + reason |
| Terminal tool | called? outcome |
| Fresh input tokens | total |
| Cache-read tokens | total |
| Output tokens | total |
| Model time | total |
| End-to-end agent time | total |
| Human intervention | required? why? |

## Rabbit log appendix

Raw Rabbit logs do not need to be duplicated here unless a specific sequence matters.

For each run, prefer adding a compact derived timeline:

```text
turn -> stated intent -> tool -> result -> repository state -> budget state
```

Keep raw-log links/paths below the corresponding test when Claude adds them.

## Experiment status

- [x] Four distinct test issues created.
- [x] All four started from the same `dev` baseline SHA.
- [x] Test #287 completed and was analyzed.
- [ ] Test #288 final result captured.
- [ ] Test #289 final result captured.
- [ ] Test #290 final result captured.
- [ ] Rabbit evidence appended where useful.
- [ ] Final cross-test conclusions updated after all four runs terminate.
