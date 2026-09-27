# CI and Agent Workflow Rules

GitHub repository state is the source of truth. Workflow inputs and SHAs are not pipeline state.

## Core flow

```text
Issue -> Dispatcher -> Implementer -> checks -> PR -> Reviewer -> Merge Gate -> dev -> CI -> next PR
```

Every green CI run on a `dev` push wakes Merge Gate, which reloads current PR state and either merges one eligible PR or exits. This avoids coupling queue progress to commit-message conventions. Red `dev` CI does not wake Merge Gate and therefore stops that merge sequence. Do not build a second pre-merge integration pipeline.

## Agent control-plane boundary

No Pi agent may create, edit, delete, rename, review, repair, or auto-merge CI/control-plane files. Protected paths are `.github/workflows/**`, `scripts/pi-*`, `tests/*.test.mjs`, `tests/test_runner_autoscaler.sh`, and `infra/github-runner-autoscaler/**`.

Implementer and PR Fix enforce this in trusted submit tooling. Reviewer and PR Fix also inspect the complete PR file list before model execution; a control-plane PR is marked `pi:needs-human` and skipped. Merge Gate uses the same centralized path policy and cannot auto-merge such a PR. Dispatcher, Architect, and Triage do not edit repository files at all. Control-plane changes use the trusted human/direct-`dev` path only.

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

Only after latest `dev` is integrated do product deterministic checks run, and they must pass before the result is accepted for publication, including at least:

```bash
pytest
ruff check .
```

Product agents (Implementer, Reviewer, PR Fix) do not run CI/control-plane contract suites such as `node --test tests/*.test.mjs`, runner-autoscaler checks, or workflow self-tests. Those belong exclusively to `ci.yml`. Product-agent validation covers application behavior; `ci.yml` validates both product code and the CI/control plane.

A checkpoint branch may exist for recovery; it is never a merge candidate. Checkpoints are replayed onto the latest `dev`. If replay leaves unresolved conflicts, cancellation must preserve the previous good checkpoint rather than commit conflict markers. The published branch is `pi/issue-<number>`, its PR targets `dev`, and links the issue with `Closes #<number>`.

## Reviewer and PR Fix

Reviewer is independent from Implementer and does not edit files. It checks issue compliance, correctness, regressions, tests, architecture, security-sensitive changes, and accidental artifacts. A failing deterministic check cannot be treated as PASS.

Reviewer returns `PASS` or `CHANGES_REQUESTED`; the workflow owns labels/comments. A review verdict is valid only for the PR HEAD that was reviewed. If the HEAD changes for any reason, the `pull_request:synchronize` handler removes every stale `review:*` label. That handler is an invalidator only: it does not dispatch Reviewer or become another scheduler. Normal Implementer/PR Fix handoff starts the fresh Reviewer after latest-`dev` integration and deterministic checks pass; if that handoff is lost, Reconciler may recover it after the PR recovery grace period. Merge Gate requires a fresh `review:passed`, and only PASS wakes it.

If Merge Gate later discovers that an already-approved PR now conflicts with current `dev`, that approval is stale for the changed integration result. Merge Gate replaces the old review verdict with `review:changes-requested`, dispatches PR Fix, and stops the queue. `review:changes-requested` is also the durable ownership marker for this recovery path: if the direct PR Fix dispatch is lost, Reconciler recovers PR Fix rather than incorrectly starting Reviewer. PR Fix resolves the conflict against current `dev` in its live agent session, runs deterministic checks, pushes the new PR HEAD, and sends it through a fresh Reviewer before Merge Gate may try again.

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

If GitHub reports a merge conflict, Merge Gate invalidates the stale review verdict, dispatches PR Fix, and stops the queue without crashing. Conflict resolution remains outside Merge Gate. PRs modifying any protected control-plane path (`.github/workflows/**`, `scripts/pi-*`, `tests/*.test.mjs`, `tests/test_runner_autoscaler.sh`, or `infra/github-runner-autoscaler/**`) are not auto-merged.

## Post-merge CI

The authoritative integration check is CI on the actual merged `dev` commit.

```text
merge PR -> push dev -> CI
                     -> green: wake Merge Gate for next PR
                     -> red: stop merge sequence
```

Reconciler does not wake Merge Gate. Merge Gate must not infer a merge event from commit-message text.

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

Reconciler is recovery infrastructure, not a scheduler. It may recover orphaned ownership, stranded `pi:ready` work, abandoned PR review/fix handoffs, and obsolete checkpoints by returning work directly to its normal owner. PR recovery has a 10-minute grace period measured from the PR's latest `updated_at` (falling back to `created_at`): fresh PR creation, pushes, labels, or other updates belong to the normal owner during that window. The grace period does not delay normal CI; it only prevents Reconciler from racing a normal handoff. Reconciler must not become another happy-path dispatcher and must not wake Merge Gate.

Triage is an optional preparation step for issues not yet in the pipeline. It reads the same canonical `## Task metadata` from the GitHub issue body as Dispatcher and Architect; no `tasks/<id>.md` snapshot exists. It may validate readiness and set `dispatcher:ready`; it does not replace Dispatcher.

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

Before adding a workflow, input, status, SHA field, synchronization step, or recovery path, ask whether fresh GitHub state plus the existing owner can solve the problem.

Prefer current GitHub state over transported state, IDs over metadata payloads, direct ownership over relay workflows, ordinary `dev` CI over synthetic integration, one wake owner over duplicate wake sources, and explicit failure/blocking over hidden repair.

Do not add complexity solely for a hypothetical race that GitHub's atomic API operation or a later fresh-state check already handles.

## Security

Never commit credentials, PATs, OAuth tokens, client secrets, encryption keys, authorization headers, cookies, local `.env` files, or production credentials. Repository rulesets/branch protection remain an independent security boundary; agent prompts are not one.
