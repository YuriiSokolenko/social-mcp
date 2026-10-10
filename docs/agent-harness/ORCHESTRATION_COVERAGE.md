# Orchestration test coverage (#727)

This page describes how the Pi control plane is tested from task intake to finalization, how coverage is measured, and what is still not executed. Issue #727 asked for tests that check **state transitions, dispatches, retries and fencing, terminal results and recovery** instead of source-text snippets. This work adds tests and coverage reporting. It does not redesign the pipeline.

## How the tests work

| Piece | File | What it does |
| --- | --- | --- |
| Fake GitHub | `tests/helpers/fake-github-preload.mjs` | A `node --import` preload that replaces `fetch` with an in-memory GitHub REST model. The model covers issues, labels, comments, pulls, files, merges, refs, Actions runs, jobs, reruns, dispatches and variables. It refuses any request to a host other than GitHub and any route it does not model. It logs every request. It can inject faults (HTTP status, timeout, transport error; with `skip` and `times`) and interleave another actor's write just before a request. |
| Test handle | `tests/helpers/fake-github.mjs` | Creates an isolated store for one test. Runs a **production entrypoint** as a child process against that store, with an allowlisted environment: no inherited `GITHUB_*` runner state and a synthetic token. Provides fixtures and `mutatedRoot()` for mutation checks. |
| Scenarios | `tests/helpers/orchestration-scenarios.mjs` | Cross-stage scenarios. Each takes `{ root }`, the checkout whose scripts run, so the same scenario can run against a mutated copy. |
| Tests | `tests/pi-orchestration-{flow,faults,edges,mutants}.test.mjs` | Flow: happy and optional paths. Faults: the failure and concurrency matrix. Edges: stage-boundary rejections and no-ops. Mutants: regression proofs. |
| Coverage | `tests/helpers/orchestration-coverage.mjs` | Runs the suite with Node's built-in V8 coverage, writes `lcov.info` and reports the selected modules. |

No hosted model, real GitHub, network, production credential or N150 runtime is involved:

- **Model output** is fixed: a `submit_result` transcript for each stage.
- **Implementer output** is real but local. Each test builds a git candidate and writes a real terminal receipt and validation ledger with the production helpers.
- **The PR Fix push** goes to a local bare remote.
- **Temporary state** lives in one directory per test, removed when the test ends.

The tests run in the existing `harness` CI job through `node --test tests/*.test.mjs` ("Agent workflow checks").

## Commands

```bash
# Focused orchestration tests (about 25 s locally)
node --test tests/pi-orchestration-*.test.mjs

# Full Node suite, as CI runs it
node --test tests/*.test.mjs

# Orchestration coverage: writes coverage/orchestration/{lcov.info,summary.json,summary.md}
node tests/helpers/orchestration-coverage.mjs

# Reproduce the baseline: run the same tool on the pre-#727 tree (dev at 9541fd20)
git worktree add --detach /tmp/pi-727-base 9541fd20
cp tests/helpers/orchestration-coverage.mjs /tmp/pi-727-base/tests/helpers/
(cd /tmp/pi-727-base && node tests/helpers/orchestration-coverage.mjs --out /tmp/pi-727-baseline)
node tests/helpers/orchestration-coverage.mjs --compare /tmp/pi-727-baseline/summary.json

# Re-summarize a saved run without re-running tests
node tests/helpers/orchestration-coverage.mjs --from-lcov /tmp/pi-727-baseline/lcov.info --out /tmp/pi-727-baseline
```

CI adds an "Orchestration coverage report" step to the `harness` job. It writes the module table to the job summary and uploads `lcov.info`, `summary.json` and `summary.md` as the `orchestration-coverage-<run>-<attempt>` artifact. The step is `continue-on-error`: it only reports, and "Agent workflow checks" remains the gate.

## Measured modules and exclusions

The 18 measured modules are the stage entrypoints and the shared state and recovery code they hand off through:

`pi-triage.mjs`, `pi-dispatcher.mjs`, `pi-architect.mjs`, `pi-transition.mjs`, `pi-common/issue-publication.mjs`, `pi-common/pr-guard.mjs`, `pi-common/review-state.mjs`, `pi-review-result.mjs`, `pi-common/repair-publication.mjs`, `pi-auto-merge.mjs`, `pi-post-merge.mjs`, `pi-reconcile.mjs`, `pi-common/automation-control.mjs`, `pi-common/workflow-dispatch.mjs`, `pi-common/github-api.mjs`, `pi-common/github-state.mjs`, `pi-common/state-machine.mjs`, `pi-common/recovery-policy.mjs`. All are under `scripts/`.

These are excluded:

- **The Pi model runtime and its adapters** (`pi-agent-runtime.mjs`, `pi-run-stage.mjs`, terminal and session tooling). Their provider and tool-call behaviour belongs to #658 and to their own focused tests.
- **Workflow YAML.** It is not JavaScript, so coverage cannot instrument it. YAML assertions are reported separately in the matrix below and are never counted as runtime coverage.
- **The test file `tests/pi-run-stage.test.mjs`**, from the coverage run only. It passes a frozen environment object to `spawn()`, so coverage mode cannot inject `NODE_V8_COVERAGE` into it. It still runs, without instrumentation, in "Agent workflow checks".

Coverage includes the stage scripts that tests spawn as child processes: Node propagates `NODE_V8_COVERAGE`.

## Before and after

Node v26.0.0, macOS. Baseline is `dev` at `9541fd20`; after is this branch. The same tool ran over the same test-file set in both runs (all `tests/*.test.mjs` except the excluded file). Both runs had the same 3 failures, which happen only on a Mac: `pi-auto-merge.test.mjs` spawns `python`, and only `python3` exists here. The failures do not touch the measured modules.

| Module | Branch % before → after | Branches hit/found before → after | Lines % before → after |
| --- | --- | --- | --- |
| `pi-triage.mjs` | 75.86 → 86.75 | 66/87 → 72/83 | 88.89 → 92.31 |
| `pi-dispatcher.mjs` | 82.61 → 98.46 | 57/69 → 64/65 | 86.96 → 98.91 |
| `pi-architect.mjs` | 72.93 → 76.30 | 97/133 → 103/135 | 86.01 → 93.71 |
| `pi-transition.mjs` | 42.86 → 68.42 | 9/21 → 13/19 | 75.00 → 100.00 |
| `pi-common/issue-publication.mjs` | 70.97 → 72.63 | 66/93 → 69/95 | 83.89 → 90.28 |
| `pi-common/pr-guard.mjs` | not loaded → 50.00 | 0/? → 6/12 | not loaded → 100.00 |
| `pi-common/review-state.mjs` | 76.24 → 84.02 | 138/181 → 142/169 | 81.90 → 95.05 |
| `pi-review-result.mjs` | 80.33 → 87.18 | 98/122 → 102/117 | 94.09 → 96.36 |
| `pi-common/repair-publication.mjs` | not loaded → 50.00 | 0/? → 7/14 | not loaded → 98.51 |
| `pi-auto-merge.mjs` | 80.00 → 88.54 | 68/85 → 85/96 | 96.00 → 99.33 |
| `pi-post-merge.mjs` | 75.00 → 78.95 | 9/12 → 15/19 | 34.62 → 100.00 |
| `pi-reconcile.mjs` | 45.24 → 75.90 | 19/42 → 63/83 | 52.28 → 98.48 |
| `pi-common/automation-control.mjs` | not loaded → 100.00 | 0/? → 5/5 | not loaded → 100.00 |
| `pi-common/workflow-dispatch.mjs` | not loaded → 100.00 | 0/? → 1/1 | not loaded → 100.00 |
| `pi-common/github-api.mjs` | 75.00 → 88.89 | 27/36 → 32/36 | 93.14 → 100.00 |
| `pi-common/github-state.mjs` | 69.23 → 75.00 | 9/13 → 12/16 | 77.59 → 93.10 |
| `pi-common/state-machine.mjs` | 92.16 → 93.14 | 94/102 → 95/102 | 97.77 → 97.77 |
| `pi-common/recovery-policy.mjs` | 88.00 → 88.00 | 22/25 → 22/25 | 100.00 → 100.00 |
| **Aggregate** | **76.30 → 83.15 (+6.85 pp)** | **779/1021 → 908/1092** | **84.32 → 95.95 (+11.63 pp)** |

Function coverage went from 85.20 % to 95.67 %. Four modules were never loaded by any test before (`pr-guard`, `repair-publication`, `automation-control`, `workflow-dispatch`).

### Why the branch gain is below the 15-point target

The issue accepts a smaller gain if it is justified and every critical path is covered. The aggregate branch gain is 6.85 points. That is less than the target for two reasons.

1. **The denominators grow as coverage improves.** V8 reports the inner blocks of a function only after the function has run.
   - New tests added 71 branches to the denominator (1021 → 1092) while hitting 129 more branches.
   - Restricted to the 14 modules loaded in both runs, the result is 76.30 % → 83.87 % (889/1060).
   - Between identical runs, denominators also vary by a few branches; for example, `pi-dispatcher.mjs` has reported both 65 and 70.
   - The fairer measure is unhit branches: they fell from 242 to 184.
2. **Most remaining unhit branches are defensive fallbacks, not orchestration paths.** Examples are `body ?? ''`, `pr.head?.ref ?? ''`, `label.name` versus string labels, and the `usage()` guards of CLIs no workflow calls incorrectly. Tests whose only purpose is to hit those fallbacks would raise the number without adding protection, which is what the issue warns against.

The other remaining unhit branches are in `issue-publication.mjs` checkpoint and push. Those use git leases and are covered in-process by `pi-issue-publication-gate.test.mjs`.

Every critical path in the matrix below has a behavioral test. No critical path relies only on a text or regex assertion, except where a workflow YAML step is the mechanism itself (marked **S**).

## Stage × transition matrix

**B** means a behavioral integration test: the production entrypoint runs against the stateful fake and the test asserts effects. **U** means an in-process unit test. **S** means a static contract only: assertions on YAML or source text. A dash (—) means not covered.

| Stage | Transition or failure mode | Cov. | Where |
| --- | --- | --- | --- |
| Triage | `triage:ready` → `dispatcher:ready` | B | flow: happy path |
| | Unclear issue → `pi:needs-human` with hash-marker comment; re-check only after a body change | B | faults: Triage 5xx; `pi-triage-e2e` |
| | Re-validation at apply time: changed candidate set, missing criteria, issue claimed after prepare | B | edges: Triage |
| | 5xx on a label write → batch fails with no partial comment; retry completes | B | faults: Triage 5xx |
| | Missing, truncated or duplicate model classification → no mutation | B | faults: invalid provider output |
| Dispatcher | `dispatcher:ready` → `pi:ready` and an Implementer dispatch with exact inputs | B | flow: happy path |
| | ARCHITECT → `architect:ready` and an Architect dispatch | B | flow: Architect split |
| | 429 on the dispatch → rolled back to `dispatcher:ready`; retry dispatches exactly once | B | faults: dispatch rate-limited |
| | Concurrent ownership change between read and write → fails closed; newer owner kept | B | faults: concurrent ownership |
| | Issue assigned by an earlier serialized Dispatcher → skipped with no duplicate dispatch | B | edges: Dispatcher |
| | Blocked, dependency-pending, `pi:needs-human` or invalid-metadata issue → not dispatched | B | flow: gated states; edges; `pi-dispatcher-e2e` |
| Architect (Planner) | Split → ordered children labelled `dispatcher:ready`; parent becomes `architect:epic` | B | flow: Architect split |
| | Keep or revise → `dispatcher:ready`; manual `workflow_dispatch` claim | B | edges: Architect; `pi-architect-e2e` |
| | Crash after the first child is created → re-run reuses that child with no duplicate | B | edges: Architect |
| | Children created but never labelled (interrupted publication) → Reconciler completes it | B | flow: Architect split (**this found a bug, see below**) |
| | Source or parent changed while planning; plan for another issue → rejected with no mutation | B | edges; faults |
| Implementer | Claim `pi:ready` → `pi:running`; publication → `pi:mr-created` | B | flow: happy path |
| | Already satisfied → closed as completed; stopped → unowned; closed issue → terminal no-op | B | edges: transitions |
| | Late failure after the PR merged → completes the issue; `needs-human` never replaces `pi:mr-created` | B | flow: delayed completion |
| | Human `pi:blocked` is preserved through a running transition, with no comment | B | flow: gated states |
| | Provider timeout, transport error or invalid tool call inside the model session | U | `pi-run-stage`, `pi-provider-tool-*` (#658). At the orchestration boundary this appears as a missing or truncated result, which is covered as B. |
| | Workflow step ordering: checkpoint lease, `pi:mr-created` before the Reviewer dispatch | S | `pi-control-plane-scenarios` |
| PR publication | Verified candidate → PR whose HEAD is the candidate and whose body contains `Closes #N` | B | flow: happy path |
| | Retried publication updates the same PR (one `POST /pulls`) | B | flow: happy path; gated states |
| | Unverified ledger → PR gated with `pi:needs-human`; Reviewer and Merge Gate skip it | B | flow: gated states |
| | Truncated terminal receipt → no PR | B | faults: terminal receipts |
| | Published PR HEAD differs from the local candidate → `pi:needs-human` | U | `pi-issue-publication-gate` |
| Reviewer | PR guard: safe PR allowed; closed or merged PR skipped; foreign or wrong-base PR refused; control-plane change → human | B | edges: PR guard; flow |
| | PASS → `review:passed` and one Merge Gate dispatch; CHANGES_REQUESTED → PR Fix dispatch | B | flow |
| | Verdict or follow-up for a stale HEAD → rejected and verdict cleared | B | flow: stale head |
| | Duplicate run record or start, delayed invalidator, human takeover, superseded verdict | B | edges: Reviewer state; `pi-review-failure` (U) |
| | Publication boundary: missing, invalid, foreign or stale receipt, or context not bound → exit 4; no result → exit 3 | B | edges; faults |
| PR Fix | Publishes a new HEAD under the lease; refuses a HEAD that moved | B | flow: repair loop |
| | Handoff clears the verdict and dispatches Reviewer; a failed dispatch is recovered once by the Reconciler | B | flow: repair loop |
| Merge Gate | PASS, green CI on the exact head and green dev CI → squash merge, then a dev CI wake | B | flow: happy path |
| | CI pending; green CI only for an old head; HEAD changes before merge → no merge | B | flow: happy path; stale head |
| | Product CI failure → `review:changes-requested` and PR Fix; if the dispatch fails, ownership stays and the Reconciler recovers it | B | faults: lost repair dispatch; `pi-auto-merge-e2e` |
| | Cancelled or infrastructure CI → one retry; a duplicate wake is idempotent; exhaustion → human; PR Fix never dispatched | B | faults: cancelled CI; `pi-auto-merge-e2e` |
| | Red dev CI stops the scan; merge not confirmed; GitHub timeout or transport error → no merge | B | edges; faults |
| | Draft, control-plane, `pi:needs-human` or not-yet-`pi:mr-created` PR → skipped | B | flow: gated states; edges |
| Post-merge | Merged linked PR → issue closed as completed and refs deleted; idempotent | B | flow: happy path |
| | Missing, unlinked or non-Pi PR → nothing changes | B | edges: post-merge |
| Reconciler | Orphaned Implementer or Architect, or stranded `pi:ready` → RUNNING: `dispatcher:ready`; DRAINING and PAUSED: cleared; checkpoint kept | B | flow: modes; faults: #698 |
| | Stranded PR → Reviewer, PR Fix or Merge Gate by verdict; only after the grace period; never while a stage run is live; never for a human-owned PR | B | faults: lost wake, #698, lost repair; flow: repair loop |
| | Closed issue still owning a label → repaired; completed checkpoint collected; step summary written | B | edges: Reconciler |
| | Audit mode → read-only | B | flow: modes |
| Automation control | Mode is set and read back (mismatch fails); resume wakes only Dispatcher; unknown mode rejected | B | flow: modes; edges |
| Workflow wiring | `workflow_run` and terminal-CI wake, concurrency groups (`cancel-in-progress: false`), step `if:` conditions | S | `pi-control-plane-scenarios`, `pi-review-ci-contract`, `tests/ci/test_workflow_integrity.py` |

## Fault-injection scenarios

There are 12. Each runs deterministically against the fake:

1. GitHub **429** on the Implementer dispatch.
2. GitHub **502** on a Triage label write.
3. GitHub **503** on the PR Fix dispatch after a product CI failure.
4. GitHub **502** on the Reviewer handoff dispatch after PR Fix.
5. GitHub **timeout** on a Merge Gate read.
6. **Transport error** on the merge itself.
7. **Transport error** in the middle of an Architect split.
8. **Cancelled CI**, followed by a retry that also fails.
9. **Missing, truncated or invalid model output** at Dispatcher, Triage and Architect.
10. **Truncated or foreign terminal receipts** at Implementer and Reviewer publication.
11. **A concurrent owner** writing between read and write.
12. **The PR HEAD changing** between Merge Gate's two reads.

Lost or duplicate signals are covered by:

- the **#698 reboot fixture**: an interrupted Reviewer, a duplicate `workflow_run` delivery, a second interruption, and an orphaned Implementer with a checkpoint;
- a **lost Reviewer wake**;
- **repeated Reconciler passes**;
- a **full second pass of every stage** after the happy path, which must cause no GitHub mutation.

The #698 fixture tests the **recovery behavior that already exists** (bounded retry, then escalation). It does not prove the crash-safe mechanics that #698 will implement.

## Mutation checks

`tests/pi-orchestration-mutants.test.mjs` breaks one production line in a temporary copy of `scripts/` and requires a named scenario to fail with an assertion. A control run checks that every scenario first passes against an unmodified copy. Each anchor must match exactly once, so refactoring a mutated line fails loudly.

There are 18 mutants. They cover:

- Triage: an incorrect transition.
- Dispatcher: an incorrect dispatch, and a missing rollback.
- Compare-and-swap disabled.
- Architect: children never exposed.
- Publication: a duplicate PR.
- Reviewer: a stale-head verdict accepted, and unbounded retry.
- PR Fix: a wrong-stage handoff.
- Merge Gate: stale-head merge, unbounded infrastructure retry, and label loss before dispatch.
- GitHub client: no request timeout.
- Post-merge: issue never completed.
- Reconciler: missed recovery, a duplicate Reviewer while one is live, and the escaped split regex.
- Transition: a late failure that escalates instead of completing.

## Production change: interrupted Architect split recovery never ran

`pi-reconcile.mjs` matched split children with `/<!-- architect-children:([1-9]\\d*…)/`. Inside a regex **literal**, `\\d` matches a backslash followed by `d`, not a digit. The pattern could never match a real marker, so the Reconciler's "complete an interrupted Architect split" path was dead code. `pi-architect.mjs` and `pi-architect-plan-validator.mjs` use the correct `\d`. The fix is one line, and the Architect split scenario together with its mutant keeps it fixed.
