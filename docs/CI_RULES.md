# CI and Agent Workflow Rules

GitHub repository state is the source of truth. Workflow inputs and SHAs are not pipeline state.

## Core flow

```text
Issue -> Dispatcher -> Implementer -> checks -> PR -> Reviewer -> Merge Gate -> dev -> CI -> next PR
```

Every green CI run on a `dev` push wakes Merge Gate, which reloads current PR state and either merges one eligible PR or exits. Terminal PR CI uses a separate completion boundary: `ci-terminal-wake.yml` listens only for `workflow_run: completed` from `CI` and then issues a state-free Merge Gate wake, so the gate never depends on a wake emitted while that same PR CI run can still be `in_progress`. The wake transports no PR number, SHA, or CI verdict; Merge Gate reloads the current PR and exact-head CI state from GitHub. Merge Gate also verifies that push-CI for the current `dev` HEAD is green immediately before each merge attempt, so duplicate/stale wake delivery cannot merge a second PR before the newly merged `dev` commit is validated while failure/repair classification remains non-blocking. Red `dev` CI does not wake Merge Gate and therefore stops that merge sequence. Do not build a second pre-merge integration pipeline.

## Agent control-plane boundary

No Pi agent may create, edit, delete, rename, review, repair, or auto-merge CI/control-plane files. Protected paths are `.github/workflows/**`, `agents/**`, `scripts/pi-*`, `tests/*.test.mjs`, `tests/test_runner_autoscaler.sh`, and `infra/github-runner-autoscaler/**`. `agents/**` is protected as control-plane, not product content, because it holds the runtime prompt every model stage reads before doing anything else; an agent editing its own instructions is a control-plane change, not a product change.

Implementer and PR Fix enforce this in trusted submit tooling. Reviewer and PR Fix also inspect the complete PR file list before model execution; a control-plane PR is marked `pi:needs-human` and skipped. Merge Gate uses the same centralized path policy and cannot auto-merge such a PR. Dispatcher, Architect, and Triage do not edit repository files at all. Control-plane changes, including changes to `agents/**` prompts, use the trusted human/direct-`dev` path only.

## Branches and trust

- `dev` is the default development/integration branch. Routine development, Pi workflows, and control-plane scripts live there. Task metadata lives in GitHub issues.
- Pi PRs target `dev`; `main` is reserved for releases.
- Control-plane workflows explicitly check out trusted `dev` before running `scripts/pi-*`.
- Normal CI tests the triggering commit.
- Trusted Pi agents run on N150 self-hosted runners. Never execute arbitrary external PR code there.
- Models do not own GitHub mutations. Workflows/scripts own commits, pushes, labels, comments, dispatches, and merges.

## Automation mode

`PI_AUTOMATION_MODE` supports:
- `RUNNING`: start new work and continue in-flight work.
- `DRAINING`: do not start new issues; existing PR work may finish.
- `PAUSED`: do not start new automated stages.

Missing or unknown values fail closed.

## Dispatcher and Architect

An open issue with `dispatcher:ready` and a valid top-level `## Task metadata` section is eligible for Dispatcher. The issue body is the source of truth: `Priority: P0|P1|P2` and `Depends on: [#12, #18]` (or `[]`). On every run Dispatcher reloads current issues directly from GitHub. Dispatcher decides only whether eligible work goes to Implementer or Architect. Eligibility, dependencies, priority, and repository state are deterministic workflow concerns.

When an issue becomes `dispatcher:ready`, Dispatcher may be woken directly. Wake events are signals only; Dispatcher reloads current GitHub state.

Architect is optional and exists only for work needing decomposition or task-plan correction. Validated child/revised issues return to Dispatcher.

## Implementer

Implementer edits code and tests in an isolated worktree. It does not commit, push, create PRs, merge, or mutate GitHub directly.

Before the Implementer session may finish successfully, its trusted `submit_result` tool fetches the latest `dev` and merges `origin/dev` into the issue branch. If that merge conflicts, the same live Implementer session must resolve the conflicted files and retry `submit_result`; a resolvable conflict is not a successful terminal state. Trusted tooling owns staging and the merge commit, while the agent owns the content-level conflict resolution.

Only after latest `dev` is integrated does trusted submit tooling run the authoritative product deterministic checks, and they must pass before publication, including at least:

```bash
pytest
ruff check .
```

Product agents (Implementer, Reviewer, PR Fix) do not run CI/control-plane contract suites such as `node --test tests/*.test.mjs`, runner-autoscaler checks, or workflow self-tests. Those belong exclusively to `ci.yml`. Product-agent validation covers application behavior; `ci.yml` validates both product code and the CI/control plane.

Both these final checks and any focused `run_check` calls the Implementer makes during the session are recorded in one validation ledger (`scripts/pi-common/validation-ledger.mjs`). PR bodies and job summaries render their "Validation" text from that ledger, never from model prose or a static template, and a focused check that ends in `infra_error`/`timeout`/`not_run` leaves verification incomplete even when the broad checks above pass.

A checkpoint branch may exist for recovery; it is never a merge candidate. Checkpoints are replayed onto the latest `dev`. If replay leaves unresolved conflicts, cancellation must preserve the previous good checkpoint rather than commit conflict markers. The published branch is `pi/issue-<number>`, its PR targets `dev`, and links the issue with `Closes #<number>`.

## Reviewer and PR Fix

Reviewer is independent from Implementer and does not edit files. Before model review, trusted workflow code validates the exact PR HEAD with centralized deterministic product checks. The model then reviews issue compliance and semantic correctness at the depth warranted by the diff; it does not rerun those full checks. A failing deterministic check never reaches a model PASS.

Reviewer returns `PASS` or `CHANGES_REQUESTED`; the workflow owns labels/comments. A review verdict is valid only for the PR HEAD that was reviewed. If the HEAD changes for any reason, the `pull_request:synchronize` handler removes every stale `review:*` label. That handler is an invalidator only: it does not dispatch Reviewer or become another scheduler. Normal Implementer/PR Fix handoff starts the fresh Reviewer after latest-`dev` integration and deterministic checks pass; if that handoff is lost, Reconciler may recover it after the PR recovery grace period. Merge Gate requires a fresh `review:passed`, and only PASS wakes it.

If Merge Gate later discovers that an already-approved PR now conflicts with current `dev`, that approval is stale for the changed integration result. Merge Gate replaces the old review verdict with `review:changes-requested`, dispatches PR Fix, and stops the queue. `review:changes-requested` is also the durable ownership marker for this recovery path: if the direct PR Fix dispatch is lost, Reconciler recovers PR Fix rather than incorrectly starting Reviewer. PR Fix resolves content conflicts against current `dev` in its live session; trusted `submit_repair` integrates and validates the result, publishes the new PR HEAD, and sends it through a fresh Reviewer before Merge Gate may try again.

`pi:needs-human` on a PR is a hard automation gate: Reviewer, PR Fix, and Merge Gate must skip that PR before model work or mutation. Removing the label is an explicit human decision to return the PR to automation.

PR Fix is not a hidden pre-merge integration engine.

## Merge Gate

Merge Gate is deliberately small. It validates stable ownership/safety requirements and attempts the GitHub squash merge.

It does not:
- run synthetic dev+PR integration;
- transport or compare captured dev SHAs;
- require a custom exact-pair status;
- update a PR branch merely because `dev` moved;
- recreate review/base synchronization state.

The current PR head SHA may be read immediately before merge and supplied to GitHub as optimistic concurrency protection. That SHA is local operation data, not pipeline state.

If GitHub reports a merge conflict, Merge Gate invalidates the stale review verdict, dispatches PR Fix, and stops the queue without crashing. Conflict resolution remains outside Merge Gate. PRs modifying any protected control-plane path (`.github/workflows/**`, `agents/**`, `scripts/pi-*`, `tests/*.test.mjs`, `tests/test_runner_autoscaler.sh`, or `infra/github-runner-autoscaler/**`) are not auto-merged.

## Post-merge CI

The authoritative integration check is CI on the actual merged `dev` commit. That CI runs Ruff, pytest, Node control-plane contract tests, runner-autoscaler tests, and an isolated Docker Compose integration test before the merge queue may continue.

```text
merge PR -> push dev -> CI
                     -> green: wake Merge Gate for next PR
                     -> red: stop merge sequence
```

Normal queue progress does not rely on Reconciler. The one recovery exception is a PR that already has durable `review:passed` but lost its direct PASS -> Merge Gate dispatch: after the PR recovery grace period Reconciler may wake the shared Merge Gate scan. This is recovery of an existing handoff, not a second happy-path scheduler. Merge Gate must never infer a merge event from commit-message text.

## Inputs and SHA rule

Keep workflow inputs minimal: object identifiers such as `issue_number`, `pr_number`, or `run_id`, plus genuine user commands such as automation `mode`.

Do not pass titles, labels, URLs, reasons, state snapshots, branches, or base/head SHAs when the receiver can load current GitHub state.

```text
object ID / command -> load current GitHub state -> act
```

A SHA is not cross-workflow pipeline state.

Forbidden: `workflow A -> SHA -> workflow B`.

Allowed: `workflow -> read current SHA -> use locally for one atomic merge/lease operation`.

Do not add `integration_base_sha`, `repair_base_sha`, captured dev SHA, exact-pair state, or equivalent orchestration.

## Reconciler and Triage

Reconciler is recovery infrastructure, not a scheduler. In `RUNNING`, it may recover orphaned issue ownership, stranded `pi:ready` work, interrupted Architect child publication, abandoned PR review/fix handoffs, lost PASS -> Merge Gate wakes, and obsolete checkpoints by returning work directly to its normal owner. In `DRAINING`, issue recovery must not create `dispatcher:ready`, `architect:ready`, or `pi:ready`; orphaned issue ownership is cleared instead, while already-published PR review/fix/merge recovery remains enabled so in-flight PR work can finish. PR recovery has a 10-minute grace period measured from the PR's latest `updated_at` (falling back to `created_at`): fresh PR creation, pushes, labels, or other updates belong to the normal owner during that window. The grace period does not delay normal CI; it only prevents Reconciler from racing a normal handoff. Reconciler must not become another happy-path dispatcher.

Triage is an optional preparation step for issues not yet in the pipeline. It reads the same canonical `## Task metadata` from the GitHub issue body as Dispatcher and Architect; no `tasks/<id>.md` snapshot exists. It may validate readiness and set `dispatcher:ready`; it does not replace Dispatcher.

## Terminal-result contract

Model prose is never pipeline state. Architect, Dispatcher, Triage, Reviewer, PR Fix, and Implementer finish through their trusted terminal tool. The shared `pi-run-stage.mjs` runner verifies the terminal marker before returning success; result parsers/publication then consume the trusted result artifact. A zero Pi process exit without the terminal tool is still a stage failure. Legacy free-text `*_RESULT:` markers are not accepted.

## Concurrency and failures

Different issues may execute in parallel. Work for the same issue/PR follows its workflow concurrency rule. Stateful workflows use only standard GitHub Actions concurrency keys: `group` plus `cancel-in-progress: false`. Do not add `concurrency.queue` or `queue: max`; GitHub Actions does not support that key. Dispatcher and Merge Gate are serialized by their concurrency groups. N150 autoscaling/model capacity limits actual trusted-agent concurrency.

Cancellation is operational control, not failure. If Implementer or Architect is cancelled before publication, remove its active pipeline ownership and leave the issue unowned. Do not add `dispatcher:ready` or dispatch another workflow automatically. If a PR was already published, preserve PR-pipeline ownership. A genuine execution failure without a published PR may require `pi:needs-human`.

Use explicit states:
- genuine implementation/architect execution failure before publication -> `pi:needs-human`
- unclear/no actionable change -> `pi:needs-human`
- reviewer requests changes -> `review:changes-requested`
- reviewer passes -> `review:passed`
- merge conflict -> stale review is removed, PR Fix is dispatched, and Merge Gate itself succeeds/stops the queue

Do not silently substitute another task when selected work fails.

## Complexity guard

Routing to Architect is a Dispatcher decision made before Implementer starts. Implementer therefore needs only a binary startup class from its planner: **trivial** or **nontrivial**. That class changes exactly one bounded runtime parameter—the initial productive-progress evidence allowance (**2** or **6** actions). It does not change response budgets, turn quotas, workflow routing, or whether delegation is required. Reviewer and PR Fix keep their separate `trivial | normal | complex` review-depth classification.


## Productive-progress guard

Implementer exploration is constrained by trusted runtime state rather than by a fixed count of "no-progress" turns.

For fresh work, successful `prepare_implementation` opens a bounded initial evidence budget: **2 actions for trivial work and 6 for nontrivial work**. This permits one narrow discovery-and-inspection chain such as `locate -> contract -> target implementation -> registration/caller -> exact edit anchor` without forcing a guessed mutation. Once that budget is exhausted, the runtime enters `ACTION_REQUIRED`: the next substantive action must be `safe_edit`, `edit`, `write`, or `submit_result`. If one concrete fact outside that bounded initial chain still prevents a safe action, `need_more_evidence({missing, reason})` unlocks exactly one additional evidence action and then returns to `ACTION_REQUIRED`. That escape hatch may be used only once per productive epoch; another `need_more_evidence` is blocked until a successful productive action (`safe_edit`, `edit`, `write`, `rollback_last_mutation`, or `submit_result`) resets the epoch. Failed productive actions do not reset it.

`prepare_implementation` is runtime single-shot. If planner infrastructure fails after its configured internal retry (one retry for missing `structured_output`), the runtime records `PREPARATION_FALLBACK` and satisfies preparation without inventing planner output or complexity. The fallback closes startup orientation and enters `ACTION_REQUIRED`: normal mutation/submission tools, `delegate_mutation`, and `request_large_mutation_budget` are available; `run_check` still requires a successful mutation, and a concrete missing fact can unlock one read/search via `need_more_evidence`. A second preparation call remains blocked. Fallback itself grants no elevated response budget. `PI_SUBAGENT_FAILURE`, `PI_SUBAGENT_RETRY`, and `PI_PREPARATION_FALLBACK` distinguish failed attempts, retry exhaustion, and recovery. Cancellation still propagates rather than enabling execution. Restored Implementer work starts directly in `ACTION_REQUIRED` and should call `submit_result({})` first.

### Delegated large mutations

A mutation whose payload would not fit in the Implementer's small action ceiling (2,048 tokens) goes through `delegate_mutation({operation, path, intent, requirements, context?})` instead of a parent-side budget escalation. Ownership is split three ways:

- **Implementer (parent)** decides *what* to change and why: the exact target path, `write` (create/fully replace) or `edit` (rewrite an existing file), a concrete intent, and at least one concrete requirement. It never emits the payload and stays at its normal response ceiling before and after the call. Vague requests such as "fix the issue" are rejected before any writer runs.
- **`mutation-writer` subagent** (`.pi/agents/mutation-writer.md`) materializes only that payload under the large ceiling (16,384 tokens, `IMPLEMENTER_RESPONSE_MAX_TOKENS`). It has no repository tools; it receives the request, the issue, the prepared plan or the `PREPARATION_FALLBACK` marker, and, for `edit`, the current file content. It returns structured `{operation, path, content}` and never touches the worktree.
- **Runtime** validates that the result matches the requested path and operation and has non-empty content, then applies it atomically through the normal mutation path: mutation snapshot, no-op detection, `rollback_last_mutation`, productive-progress and semantic-loop accounting, and one `run_check` permit. Invalid, truncated, mismatched, or cancelled writer output is never applied. Writer retry is bounded to one extra attempt, and only for a missing or malformed structured result. A failed delegation returns a normal tool error and leaves every productive tool available.

Delegation is available after normal preparation, under `PREPARATION_FALLBACK`, and on restored work, but never before preparation. It keeps no parent-side 16K state: an interrupted run before application has changed nothing, and after application the worktree/checkpoint is authoritative. Small mutations stay direct. A direct `write`/`edit`/`safe_edit`/`structural_edit` truncated at the output ceiling is steered to `delegate_mutation` rather than to regenerating the payload. `PI_DELEGATED_MUTATION` (`requested`, `writer_started`, `writer_completed`, `writer_failed`, `writer_retry`, `rejected`, `cancelled`, `applied`, `no_op`) and `PI_MUTATION` (`mode: direct|delegated`) let one delegated mutation be reconstructed from CI logs. The legacy one-shot `request_large_mutation_budget` grant is kept for compatibility (stage 1 of issue #273) until delegation is proven in smoke runs.

Dispatcher is narrower: after reading its prepared candidate context, exploration is closed and only classification submission (plus non-evidence response-budget control) remains valid. The prepared candidate issue scope is authoritative; Dispatcher must not read repository code, project documentation, Git history, queue state, or unrelated issues to manufacture more certainty.

The productive-progress state is independent from response-token budgeting and is logged as `productiveState` in `PI_BUDGET` / `PI_BUDGET_NEXT`. Prompt prose does not override this state machine.

## Semantic loop guard

Implementer also tracks repeated failed strategies, repeated observations, no-op mutations, and revisits to earlier repository states. A first trip emits `PI_LOOP_GUARD` and `PI_LOOP_GUARD_STEER`; a repeated trip after steering emits `PI_LOOP_GUARD_ABORT` and aborts the stage. These checks are advisory around tool execution: Git or filesystem fingerprint failures skip repository-state classification and must not block a tool call or progress accounting. Blocked tool calls are counted as failed strategies even though they do not produce `tool_execution_end`.

`PI_LOOP_GUARD_WINDOW` sets the bounded history size (default **8**, maximum **64**); `PI_LOOP_GUARD_THRESHOLD` sets the revisit count (default **3**). Invalid or non-positive values use their defaults, and threshold is capped at the window size. Repository fingerprints include tracked diffs and untracked paths; untracked files up to 1 MiB are content-hashed, while larger files use size and modification time to bound synchronous work.

Before adding a workflow, input, status, SHA field, synchronization step, or recovery path, ask whether fresh GitHub state plus the existing owner can solve the problem.

Prefer current GitHub state over transported state, IDs over metadata payloads, direct ownership over relay workflows, ordinary `dev` CI over synthetic integration, one wake owner over duplicate wake sources, and explicit failure/blocking over hidden repair.

Do not add complexity solely for a hypothetical race that GitHub's atomic API operation or a later fresh-state check already handles.


## Shared trusted CI helpers

Reusable control-plane primitives live in `scripts/pi-common/`. Workflow YAML is orchestration only: checkout trusted `dev`, prepare context, invoke `pi-run-stage.mjs` when a model is required, publish, and clean up. Model provider/options, extensions, terminal-marker enforcement, and per-stage runtime limits must not be duplicated in YAML. Do not duplicate GitHub REST pagination, pipeline-state mutation, control-plane path policy, PR pre-model gates, product validation, or reusable safety policy in multiple workflows. Repeated GitHub REST routes belong in `github-api.mjs`; YAML must not implement them with inline `curl`. No-input workflow wakes use `workflow-dispatch.mjs`, which always dispatches the trusted `dev` workflow definition.

`scripts/pi-common/README.md` documents every shared helper and the boundary for adding new ones. Stage-specific decisions remain in their existing `scripts/pi-*.mjs` files; the common directory must not become a generic framework.

Reviewer and PR Fix share `pr-guard.mjs` for complete PR loading, human gating, and control-plane gating. Authoritative product validation is centralized in `product-checks.mjs` and invoked by trusted workflow/submit tooling; agent prompts must not maintain or require duplicate full pytest/Ruff rituals.

## Security

Never commit credentials, PATs, OAuth tokens, client secrets, encryption keys, authorization headers, cookies, local `.env` files, or production credentials. Never print secret values to agent logs or Job Summaries. Agents must not bulk-dump environment variables or enable shell tracing; the trusted Pi log filter redacts secret-bearing keys as a defense-in-depth boundary, but redaction is not permission to inspect secrets. Repository rulesets/branch protection remain an independent security boundary; agent prompts are not one.

## Orbit Local code graph

The Pi runner image includes a pinned GitLab Orbit Local CLI. Architect and Implementer workflows configure Orbit's local stdio MCP integration for Pi before model execution and index the checkout that is authoritative for that stage. Architect indexes the trusted `dev` checkout; Implementer indexes its isolated issue worktree, so delegated scout work can use the same current code graph.

Orbit is complementary to Zoekt, not a replacement. Implementer does not load RepoMap. When the issue or plan already names a source-code symbol, use semantic LSP as the first discovery hop and read the resolved source before mutation; do not precede that with Zoekt, Git Context, or scout merely to rediscover the symbol. Otherwise use Zoekt/indexed search for fast literal/path discovery against indexed `dev`, Orbit for bounded structural questions such as imports, references, dependency direction, and blast radius, and direct `read` for exact source before mutation. Orbit Local is code-only and must not be configured with GitLab Remote credentials for this pipeline.
