# CI and Agent Workflow Rules

GitHub repository state is the source of truth. Workflow inputs and SHAs are not pipeline state.

## Core flow

```text
Issue -> Dispatcher -> Implementer -> checks -> PR -> Reviewer -> Merge Gate -> dev -> CI -> next PR
```

Every green CI run on a `dev` push wakes Merge Gate, which reloads current PR state and either merges one eligible PR or exits. Terminal PR CI uses a separate completion boundary: `ci-terminal-wake.yml` listens only for `workflow_run: completed` from `CI` and then issues a state-free Merge Gate wake, so the gate never depends on a wake emitted while that same PR CI run can still be `in_progress`. The wake transports no PR number, SHA, or CI verdict; Merge Gate reloads the current PR and exact-head CI state from GitHub. Merge Gate also verifies that push-CI for the current `dev` HEAD is green immediately before each merge attempt, so duplicate/stale wake delivery cannot merge a second PR before the newly merged `dev` commit is validated while failure/repair classification remains non-blocking. Red `dev` CI does not wake Merge Gate and therefore stops that merge sequence. Do not build a second pre-merge integration pipeline.

## Agent control-plane boundary

No Pi agent may create, edit, delete, rename, review, repair, or auto-merge CI/control-plane files. Protected paths are `.github/workflows/**`, `.pi/**`, `agents/**`, `scripts/pi-*`, `tests/*.test.mjs`, `tests/acceptance_probes/**`, `tests/test_runner_autoscaler.sh`, `infra/github-runner-autoscaler/**`, and the harness config itself (`.agent-harness.json`, `.agent-harness.yml`, `.agent-harness.yaml`). `agents/**` is protected as control-plane, not product content, because it holds the runtime prompt every model stage reads before doing anything else; an agent editing its own instructions is a control-plane change, not a product change.

Implementer and PR Fix enforce this in trusted validation/publication tooling (the central policy in `.agent-harness.json` → `control-plane-policy.mjs`). Reviewer and PR Fix also inspect the complete PR file list before model execution; a control-plane PR is marked `pi:needs-human` and skipped. Merge Gate uses the same centralized path policy and cannot auto-merge such a PR. Dispatcher, Architect, and Triage do not edit repository files at all. Control-plane changes, including changes to `agents/**` prompts, use the trusted human/direct-`dev` path only.

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

Only after latest `dev` is integrated, and after the Implementer backend exits, does the trusted stage harness (`stage-validation-recovery.mjs` → `validateFinalProductTree()`) run the authoritative product deterministic checks. They must pass before publication. If they fail, the harness starts exactly one focused validation-repair attempt in the same worktree with the concrete diagnostics and then reruns them. The checks include at least:

```bash
pytest
ruff check .
```

Product agents (Implementer, Reviewer, PR Fix) do not run CI/control-plane contract suites such as `node --test tests/*.test.mjs`, runner-autoscaler checks, or workflow self-tests. Those belong exclusively to `ci.yml`. Product-agent validation covers application behavior; `ci.yml` validates both product code and the CI/control plane.

Both these final checks and any focused `run_check` calls the Implementer makes during the session are recorded in one validation ledger (`scripts/pi-common/validation-ledger.mjs`). PR bodies and job summaries render their "Validation" text from that ledger, never from model prose or a static template, and a focused check that ends in `infra_error`/`timeout`/`not_run` leaves verification incomplete even when the broad checks above pass.

A checkpoint branch may exist for recovery; it is never a merge candidate. Checkpoints are replayed onto the latest `dev`. If replay leaves unresolved conflicts, cancellation must preserve the previous good checkpoint rather than commit conflict markers. The published branch is `pi/issue-<number>`, its PR targets `dev`, and links the issue with `Closes #<number>`.

## Reviewer and PR Fix

Reviewer is independent from Implementer and does not edit files. Before model review, trusted workflow code validates the exact PR HEAD with centralized deterministic product checks. The model then reviews issue compliance and semantic correctness at the depth warranted by the diff; it does not rerun those full checks. A failing deterministic check never reaches a model PASS.

Reviewer returns `PASS` or `CHANGES_REQUESTED`; the workflow owns labels/comments. A review verdict is valid only for the PR HEAD that was reviewed, and the applied review comment carries a hidden HEAD-bound verdict marker. Automated Pi branches (`pi/issue-*`) use the dedicated `PR Review Invalidate` workflow on branch push to remove stale `review:*` labels. That lightweight invalidator runs outside the N150 queue, discovers the open `dev` PR for the pushed branch, passes the pushed SHA to `review-state.mjs`, and becomes a no-op if the PR has already advanced or a verdict marker already proves that the current verdict belongs to that HEAD. It never dispatches Reviewer or becomes another scheduler. Ordinary PR pushes do not create this workflow. Normal Implementer/PR Fix handoff starts the fresh Reviewer after latest-`dev` integration and deterministic checks pass; if that handoff is lost, Reconciler may recover it after the PR recovery grace period. Merge Gate requires a fresh `review:passed`, and only PASS wakes it.

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

If GitHub reports a merge conflict, Merge Gate invalidates the stale review verdict, dispatches PR Fix, and stops the queue without crashing. Conflict resolution remains outside Merge Gate. PRs modifying any protected control-plane path (`.github/workflows/**`, `.pi/**`, `agents/**`, `scripts/pi-*`, `tests/*.test.mjs`, `tests/acceptance_probes/**`, `tests/test_runner_autoscaler.sh`, `infra/github-runner-autoscaler/**`, or the harness config itself (`.agent-harness.json`, `.agent-harness.yml`, `.agent-harness.yaml`)) are not auto-merged.

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

Routing to Architect is a Dispatcher decision made before Implementer starts. Implementer therefore needs only a binary startup class from its planner: **trivial** or **nontrivial**. The planner separately returns its own per-task `evidence_budget` estimate (0–6), and that estimate is the initial productive-progress evidence allowance; the class only supplies the fallback allowance (**2** for trivial, **6** for nontrivial) when no estimate is recorded. Neither value changes response budgets, turn quotas, workflow routing, or whether delegation is required. Reviewer and PR Fix keep their separate `trivial | normal | complex` review-depth classification.


## Productive-progress guard

Implementer exploration is constrained by trusted runtime state rather than by a fixed count of "no-progress" turns.

For fresh work, the runtime bootstrap (below) installs a bounded initial evidence budget before the first main-model request, equal to the planner's `evidence_budget` estimate (**0–6** actions; the by-complexity fallback of 2 trivial / 6 nontrivial applies only when no estimate is recorded). A budget of 0 enters `ACTION_REQUIRED` immediately. This permits one narrow discovery-and-inspection chain such as `locate -> contract -> target implementation -> registration/caller -> exact edit anchor` without forcing a guessed mutation. Once that budget is exhausted, the runtime enters `ACTION_REQUIRED`: the next substantive action must be `structural_edit`, `safe_edit`, `edit`, `write`, `begin_coding_session`, `rollback_last_mutation`, or `submit_result`. If one concrete fact outside that bounded initial chain still prevents a safe action, `need_more_evidence({missing, reason})` unlocks exactly one additional evidence action and then returns to `ACTION_REQUIRED`. That escape hatch may be used only once per productive epoch; another `need_more_evidence` is blocked until a successful productive action (`structural_edit`, `safe_edit`, `edit`, `write`, `rollback_last_mutation`, or `submit_result`) resets the epoch. Failed productive actions do not reset it.

**Planner bootstrap (fresh work only).** Planning is a prerequisite for creating the fresh Implementer session, not an action the Implementer requests. Before the main session starts, `pi-stage-backend` launches a short-lived, prompt-less bootstrap Pi process (`scripts/pi-implementer-bootstrap.mjs`, Session A), which hosts the isolated `implementation-planner` child. The planner has a strictly read-only surface (`read`/`grep`/`find`/`ls` plus the bounded read-only helpers `repo_search` and `planner_code_graph`) and no planner evidence-action budget, no planner-specific lifecycle deadline, and no fixed structured-result retry count. The stopping rule is semantic: continue only while another repository action is likely to materially improve the plan, then finish immediately. Distinct useful evidence beyond six actions is valid. Evidence accounting is observability only. Repeated equivalent/no-progress evidence is stopped by semantic loop protection; a streak of repository actions that yields no new compact planning fact is also a deadlock signal and resets as soon as useful evidence appears. These guards are about lack of progress, not elapsed time or total useful actions.

A successful planner lifecycle ends only through `structured_output`. Starting finalization permanently closes repository evidence for ordinary schema/serialization repair. Rejected structured results receive deterministic correction feedback and may converge through any number of materially improving corrections; three materially equivalent result failures are treated as semantic no-progress. If an assistant turn ends in prose without any result call, the child gets one result-only recovery steer, the active surface is restricted to required `structured_output`, and a second prose-only completion is treated as semantic no-progress rather than silently falling back. The planner wrapper intentionally omits its own wall-clock deadline and generic tool-count budget; genuine provider/tool/process hangs remain the responsibility of lower-level `pi-subagents`/provider/process infrastructure and are not planner behavior budgets. The planner is launched from pi's `resources_discover` event rather than `session_start`, so delegation context is installed before bootstrap work begins. Session B starts only after the resulting `PreparedImplementation` or explicit fallback artifact has been resolved; planner reasoning, repair dialogue, and transcript are never inherited by the main Implementer.

The cat completion incentive is state-based: planner startup emits `PI_PLANNER_CAT_WAITING`; useful progress may emit the same `CAT_WAITING` reminder without accumulating reward; only a normalized, validated `PreparedImplementation` emits `PI_PLANNER_CAT_PETTED`. Planner evidence is logged as `PI_PLANNER_EVIDENCE {tool,action}` and compact repository facts as `PI_PLANNER_EVIDENCE_FACT`. Finalization observability includes `PI_PLANNER_RESULT_ATTEMPT`, `PI_PLANNER_RESULT_REJECTION`, `PI_PLANNER_RESULT_CORRECTION`, `PI_PLANNER_RESULT_RECOVERY`, `PI_PLANNER_RESULT_SUCCESS`, and `PI_PLANNER_NO_PROGRESS`. Prepared/fallback telemetry uses `plannerEvidenceActions`, `plannerStructuredCorrections`, `plannerProviderTurns`, `plannerDurationMs`, planner input/output usage, and `plannerFailureClass`; there is no evidence cap/remaining field. The main Implementer's `evidence_budget` remains a separate downstream 0–6 allowance for unresolved evidence after the planner handoff and must never be interpreted as a limit on Planner exploration.

Harmless handoff oversize is normalized before strict validation instead of causing #528-style fallback. Individual plan steps, facts, and the reason are compacted to deterministic serialization ceilings, repository facts remain capped for prompt hygiene, and the normalized plan keeps up to 16 ordered steps so nine-step plans remain valid while the main-session handoff cannot grow without bound. This is a downstream serialization boundary, not a model-visible planning budget. The transport schema itself does not reject a result merely for exceeding these cosmetic sizes.

Planner fallback represents a real inability to produce a trustworthy plan: provider/process infrastructure failure, child/bootstrap crash, unrecoverable structured-result channel failure, or semantic no-progress. Removed failure modes such as six-evidence exhaustion, a 15-minute planner deadline, the second structured-output rejection, or harmless string/step oversize must not produce fallback. `plannerFailureClass` distinguishes semantic no-progress (`planner_semantic_no_progress`), unrecoverable structured-result failure (`structured_result_unrecoverable`), lower-level transport timeout (`planner_transport_timeout`), and other preparation infrastructure failure. Cancellation still propagates rather than enabling execution. Restored work, validation-repair attempts, and forked coding sessions never run the bootstrap; restored Implementer work starts directly in `ACTION_REQUIRED` and should call `submit_result({})` first.

### Coding session (16K coding phase)

The Implementer's normal responses are capped at 2,048 tokens, and tool-call arguments are part of that output. That ceiling suits exploration and decisions, but not writing a complete file plus its tests. The Implementer therefore runs in two phases of **one logical session**:

- **2K exploration phase.** Read, search, plan and decide, under the normal evidence rules.
- **16K coding phase.** Once evidence is complete (`action_required`; the controller rejects the call earlier), the Implementer calls `begin_coding_session({reason?})`. The runtime forks the Implementer's own persisted session (pi-subagents `context: "fork"`, which branches the parent transcript with `createBranchedSession`) into the `implementer-coding-session` agent. The fork sees the same conversation: issue prompt, contract, evidence and tool results, the plan or `PREPARATION_FALLBACK`, and decisions. It continues normally there: write code, write tests, `run_check`, fix, `run_check`, `submit_result`.

Details:

- **Same trusted runtime inside the fork.** The fork loads exactly three extensions, by absolute path from the trusted control checkout: `pi-agent-runtime.mjs`, `pi-bash-timeout.mjs` and `pi-implementer-result-tool.mjs`. The runtime runs in coding-session mode (`PI_CODING_SESSION`): fixed 16,384-token responses, already prepared, starting in `action_required`, with no nested coding session and no legacy grant. Everything else is the normal Implementer runtime. That includes worktree/`.git`/symlink containment for every `write`/`edit`/`safe_edit`/`structural_edit` (also enforced in the 2K phase), snapshots and `rollback_last_mutation`, no-op detection, the `run_check` sandbox and its one-check-per-mutation permit, `need_more_evidence`, productive-progress and semantic-loop guards, the ceiling-without-tool bound, and `submit_result`. The fork may change as many files as the issue needs. The parent session stays at 2,048 throughout and has no 16K state.
- **Thinking off.** The coding session exists to fit large code in tool arguments, not to give the model a bigger planning phase (smoke #284: the first 16K response was 38,755 chars of pure reasoning with no tool call). Thinking is disabled in three trusted layers:
  1. The registered definition has `thinking: "off"`. It must be the string: pi-subagents appends it as a `:off` model suffix, and `false` would leave the default on.
  2. The delegation request carries `thinking: "off"`, which pi-subagents applies as `thinkingOverride ?? agent.thinking`, so it beats worktree `agentOverrides.thinking`, `defaultThinking` and model suffixes.
  3. Because pi sends no reasoning field for this provider's compat at level `off`, the runtime in coding-session mode sets `chat_template_kwargs.enable_thinking = false` on every provider request (`before_provider_request`). A live probe of Laguna with the same request shape gave 3,049 reasoning chars and no tool call by default, against 0 reasoning chars and an immediate `write` with `enable_thinking: false`.

  The 16,384 ceiling is unchanged, and the 2K parent's requests are not altered. `PI_CODING_SESSION` logs `thinking_disabled`, `first_tool_call` (ms since `session_ready`) and `first_response` (output tokens).
- **Tools.** The fork's tool allowlist is the normal coding/verification set: `read`, bounded `bash`, `write`, `edit`, `structural_edit`, `safe_edit`, `rollback_last_mutation`, `run_check`, `repo_search`/`indexed_repo_search`, `need_more_evidence`, `submit_result`. Exploration orchestration (subagents, MCP/LSP via ambient extensions) and the transition/legacy budget tools stay in the 2K phase.
- **Trusted definition source.** The fork's definition, tool allowlist and extensions are not read from the issue worktree, which the Implementer can rewrite. The parent runtime registers the agent in code (`pi-subagents:runtime-agent-register:v1`). An explicit `extensions` list disables ambient worktree/global extensions in the fork. Worktree `agentOverrides` can only narrow model/thinking for a runtime agent. A same-name agent planted in the worktree `.pi/agents` collides, and the launch fails closed. Forking needs a persisted parent session, so the implementer stage runs pi with `--session-dir` (next to the stage artifacts, outside the worktree); all other stages keep `--no-session`. When no session exists, the call is rejected (`fork_unavailable`); there is no fresh-prompt fallback.
- **Ending.** When the fork calls `submit_result`, it writes the stage's terminal result (`PI_TERMINAL_RESULT_FILE`), and the parent's `begin_coding_session` returns `terminate: true`, so the run finishes normally. If the fork ends without submitting, its worktree changes stay (checkpoint semantics are unchanged), and the parent continues at 2K. It may start one more session (`codingSessionMaxSessions`, default 2), finish directly, or submit. The runtime records, without relying on the model-declared `required_capability`, which tools the fork attempted that the coding-session contract can never expose (for example raw `bash` for cleanup, #396/#399). If the fork ended without a result after such an attempt, an equivalent relaunch is rejected before launch (`PI_CODING_SESSION` `rejected` with `reason: repeated_incapable_session`) until a trusted recovery transition (`undo_mutation`, `recover_worktree`, `rollback_last_mutation`) succeeds or the contract gains every capability that was unreachable. An arbitrary worktree change does not lift the guard (#440). Cancellation propagates. Nothing about a coding session is persisted besides the worktree and checkpoint, which stay authoritative.
- **Recovery and steering.** The coding fork must use only the tools exposed on the current provider request and must not invent helpers such as `read_for_input`. In `action_required`, if `read` is hidden and one concrete missing fact blocks the next safe action, it calls `need_more_evidence({missing, reason})` to unlock the single evidence action. A direct `write`/`edit`/`safe_edit`/`structural_edit` truncated at 2K is steered to `begin_coding_session`. pi reports that rejection through `tool_execution_end`, so the steer is sent from there as well as from `tool_result`, once per call. An action-required response that uses the whole ceiling without any tool call (for example code drafted in reasoning) gets a targeted steer, and three such responses in a row abort the stage (`PI_ACTION_REQUIRED_ABORT`). The prose-only guard deliberately ignores ceiling-hit turns.
- **Request capability authority.** Before every Implementer provider request (parent and coding-session fork), the runtime re-syncs the active surface, filters `payload.tools` to it, and logs `PI_PROVIDER_CAPABILITY_SNAPSHOT`. pi resolves a turn's tool calls against the context captured with that payload, so `payload.tools` is the executable surface of the request (`activeTools`/`executableTools` in the snapshot). A tool activated after the payload was assembled is **deferred**, not added: pi exposes it from the next request (`PI_PROVIDER_CAPABILITY_DEFERRED` with `request`, `executableTools`, live `activeTools`, `deferredTools`). A live smoke on pi 0.87.1 showed that adding the definition makes the model call a tool pi then rejects as not found (#441). pi's `Tool X not found` is classified against the snapshot: a tool the request advertised is a real infrastructure `PI_TOOL_CONTRACT_FAILURE` (hard abort; also when no snapshot exists yet). A deferred tool is a deterministic `PI_CAPABILITY_LIFECYCLE_MISMATCH`: no abort. The model is told not to retry in this response, and on the next request to call it only if that request exposes it. The steer makes no promise about the next surface, because another tool in the same response may change state again. Any other tool is an ordinary `PI_UNAVAILABLE_TOOL_ATTEMPT`.
- **Usage accounting.** The job summary keeps the historical logical usage-record count for compatibility and separately reports provider turn count, **known provider response time**, and **delegated lifecycle time**. Lifecycle roll-ups may supply `turns` and `durationMs`; `turns` can improve provider-count accuracy, but `durationMs` is never treated as provider-only time because it may include queue/tool/runtime work. CSV `model_seconds` remains based only on explicit per-response `responseMs` measurements.
- **Observability.** `PI_CODING_SESSION` (`agent_registered`, `requested`, `started`, `session_ready` in the fork with active tools / ceiling / inherited-entry counts, `completed`, `ended_without_submit`, `rejected`, `cancelled`); `PI_MUTATION` with `mode: "direct" | "coding_session"`; `PI_MUTATION_BLOCKED` for refused containment.

`request_large_mutation_budget` (a one-shot 16K grant to the parent's own next response) is legacy, kept only for stage-1 compatibility; recovery and the contract never select it.

History (#273): the first implementation delegated large payloads to a separate tool-less 16K `mutation-writer` given a compressed `intent/requirements` prompt (lossy context, JSON transport escaping bug #278, writer tool-call markup applied to disk). The second implementation was a one-shot same-session **mutation turn** restricted to one declared `write`/`edit`. Live smoke 4 showed that restriction stopping the informed fork from continuing to check and validate its work after writing the 14,634-char file (`Tool budget hard limit reached … The 'write' tool is blocked`). Both were replaced by this coding session.

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
