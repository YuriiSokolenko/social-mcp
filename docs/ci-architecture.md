# CI architecture

The control plane intentionally uses a simple contract:

1. Dispatcher routes eligible work.
2. Implementer integrates the latest `dev` in its live session, resolves conflicts, validates the result, and produces a verified PR.
3. Trusted review tooling runs deterministic checks on the exact PR HEAD; Reviewer then independently approves that same HEAD or requests changes.
4. Ordinary pull-request CI validates that exact PR HEAD, including control-plane and Docker checks that Reviewer does not own.
5. Merge Gate requires both `review:passed` and successful PR CI for the current `pr.head.sha`, then attempts a GitHub squash merge for that SHA.
6. Ordinary `push` CI tests the resulting `dev` commit.
7. Every terminal PR CI result wakes Merge Gate only after GitHub has finalized the CI run: the dedicated `ci-terminal-wake.yml` observes `workflow_run: completed` for `CI`, emits a state-free wake, and Merge Gate reloads current PR/HEAD/CI state. Pending PR CI does not block other ready PRs. A failed known product check invalidates review PASS and hands the PR to PR Fix; infrastructure failures are retried once and then require human recovery. Red post-merge `dev` CI still stops the merge sequence.

The actual merged `dev` commit is the integration truth.

## General runner pip cache

The general runner pool may share a host-backed writable pip download cache
between ephemeral CI workers. Fork pull requests are excluded from these jobs
by the workflow-level `if`; same-repository PR jobs and `dev` CI therefore
share the cache. This is an accepted trust assumption: the general `docker`
job already receives `/var/run/docker.sock`, which is effectively root access
to the host. The shared cache is an optimization, not a trust boundary. A
safer alternative is a pull-through package proxy such as devpi configured
only to proxy PyPI and accept no direct uploads; that adds a separately
managed service and is not part of this change.

## Test ownership rule

Agents use focused product tests when useful for implementation or reasoning. Authoritative full `pytest`, Ruff, and diff checks belong to trusted product-stage workflow/submit tooling and are not duplicated by the model merely as a completion ritual. Agents do not run CI/control-plane contract suites (`tests/*.test.mjs`, runner-autoscaler tests, or workflow self-tests). `ci.yml` exclusively owns those control-plane checks and runs them on the triggering `dev` commit, together with an isolated Docker Compose integration test.

## Pi `submit_result` TypeBox contract

The lightweight `tests/pi-implementer-submit-result-contract.test.mjs` loader keeps the ordinary Node test suite independent of the Pi runtime's `typebox` package. It covers registration and runtime behavior, but its compatible schema builder cannot validate TypeBox's generated JSON Schema metadata. CI therefore installs the Pi runtime's pinned `typebox@1.3.27` into the runner temp directory and runs `tests/pi-implementer-typebox-schema-contract.test.mjs` as a separate step before the general workflow tests. That test loads the production tool through a resolver pointed at the real package and checks the generated flat schema, optional outcome fields, public descriptions, and the split between permissive transport validation and authoritative fresh-changed runtime validation.

## Complexity guard

Do not reintroduce synthetic pre-merge exact-pair orchestration. The merge decision must not depend on captured dev SHAs, `integration_base_sha`, `repair_base_sha`, synthetic dev+PR merge commits, or a custom dev+PR integration state machine.

The current PR head SHA is local operation data. Merge Gate may read it from GitHub, require the ordinary PR CI run for that exact PR HEAD to be green, and then pass the same SHA to GitHub's merge API as optimistic concurrency protection. No workflow transports that SHA to another workflow.

## Ownership rule

Every normal transition has one obvious owner:
- Dispatcher owns queue routing.
- Architect owns optional decomposition.
- Implementer workflow owns publication of implementation PRs.
- Reviewer/PR Fix own review and requested changes.
- Merge Gate owns merge attempts.
- CI owns validation of the exact PR HEAD before merge and the merged `dev` result after merge.
- Reconciler owns recovery only.

Do not make Reconciler, Usage, or another diagnostic workflow a second scheduler.

## Wake rule

A wake event means only: "re-check your current work." It must not carry authoritative pipeline state.

Normal wake sources are readiness change -> Dispatcher, successful review -> Merge Gate, completed PR CI (`workflow_run: completed` for `CI`) -> Merge Gate, successful merged-`dev` CI -> Merge Gate for the next PR, and explicit/manual control -> selected workflow. The completion observer carries no SHA, PR number, or CI verdict; Merge Gate reloads all authoritative state. Reconciler is not a normal Merge Gate scheduler; it may issue one recovery wake only when an already-`review:passed` PR outlives the PR recovery grace period without its normal PASS handoff.

## Merge conflict rule

Merge Gate simply attempts the merge. If GitHub reports a late conflict, it removes the now-stale `review:*` verdict, dispatches PR Fix, and stops the queue without failing Merge Gate.

PR Fix—not Merge Gate—owns content-level repair against current `dev`. Trusted repair tooling performs integration, authoritative deterministic checks, publication of the new PR HEAD, and the handoff to a fresh Reviewer. Do not add mergeability polling, transported dev SHAs, synthetic integration, or conflict-solving code to Merge Gate.

## CI gating rule

```text
Reviewer PASS ----+
                  +--> Merge Gate --> merge into dev --> CI on actual dev commit
PR HEAD CI green -+        |                              |
                           |                        +-----+-----+
                     exact same SHA                 |           |
                                                 green         red
                                                   |           |
                                             next merge      stop
```

PR CI is not a synthetic integration approximation: it is the repository's ordinary pull-request workflow bound to the current PR HEAD. Pending PR CI is skipped. The PR-side wake is not emitted from inside that same CI run: `ci-terminal-wake.yml` listens for the `CI` workflow's `completed` event and only then dispatches the state-free Merge Gate scan. Merge Gate reloads the current PR and exact-head CI state from GitHub. Immediately before any successful-PR merge attempt it also requires push-CI for the current `dev` HEAD to be green, so a stale completed PR run cannot authorize a newer HEAD and a duplicate completion wake after a merge cannot advance the queue before the new `dev` commit is validated; failure/repair classification for other PRs remains non-blocking. A failure in a known deterministic product-check step transfers ownership to `review:changes-requested` + PR Fix and does not stall later ready PRs. Cancellation, timeout, setup/runner failures, missing job metadata, and Docker-job failures are treated conservatively as infrastructure instead of consuming an LLM repair run. Post-merge `dev` CI remains the integration truth.

## PR CI failure classification

Merge Gate classifies only trusted GitHub Actions run/job/step metadata. The repairable allowlist is intentionally narrow: Ruff, Pytest, Agent workflow checks, and Runner autoscaler checks. Docker build/start/smoke/integration failures are not auto-repairable because the same step can fail from a product change or transient Docker, registry, or network infrastructure.

Infrastructure recovery is bounded to one automatic retry. For a completed workflow with conclusion `failure`, Merge Gate uses GitHub's `rerun-failed-jobs` endpoint so already-green jobs do not run again. For `cancelled` or `timed_out`, it re-runs the full workflow because there may be no failed job set to retry. A second infrastructure-classified terminal attempt moves the PR to `pi:needs-human`.

A product test that hangs until the workflow or job timeout is deliberately classified as infrastructure because GitHub metadata cannot safely distinguish a product hang from runner or infrastructure loss. The policy is one retry and then `pi:needs-human`, not automatic PR Fix.

## Workflow input rule

Keep dispatch payloads minimal: an object identifier such as `issue_number`, `pr_number`, or `run_id`, or a genuine user command such as automation `mode`.

Do not pass titles, labels, branch/base/head SHAs, URLs, reasons, or state snapshots when the receiver can load current GitHub state.

```text
object ID / command -> load current GitHub state -> act
```

## SHA rule

A SHA is not cross-workflow pipeline state.

Forbidden: `workflow A -> SHA -> workflow B`.

Allowed: `workflow -> read current SHA -> query GitHub state for that SHA -> use locally for one atomic operation`.

Once that operation finishes, the SHA has no orchestration meaning.

## Agent control-plane boundary

The CI control plane is not agent-editable. No Pi agent may create, edit, delete, rename, review, repair, or auto-merge changes under `.github/workflows/**`, `.pi/**`, `agents/**`, `scripts/pi-*`, `tests/*.test.mjs`, `tests/test_runner_autoscaler.sh`, `infra/github-runner-autoscaler/**`, or the harness config itself (`.agent-harness.json`, `.agent-harness.yml`, `.agent-harness.yaml`). `agents/**` counts as control plane because it is the runtime prompt each model stage reads first, not product content. Trusted tooling enforces this independently of prompts. Control-plane maintenance is performed only through the trusted human/direct-`dev` path.

## Trusted control-plane rule

All control-plane workflows execute orchestration scripts from an explicit trusted checkout of `dev`, including Architect, Merge Gate, Dispatcher, Implementer, PR Fix, PR Review, Reconciler, Triage, and Usage collection.

Do not execute `scripts/pi-*` from a PR branch, issue branch, event commit, agent worktree, or another ref-dependent checkout. Normal CI is intentionally different: it checks out and tests the triggering commit.

```text
control plane -> trusted dev checkout
tested application code -> triggering commit
```

## Concurrency rule

Use only GitHub Actions' supported concurrency contract: a stable `concurrency.group` and `cancel-in-progress: false` where active work must not be cancelled. Never add `concurrency.queue` / `queue: max`. Serialization comes from the concurrency group; application/model capacity comes from the N150 autoscaler and model-slot limits.


## Shared-helper rule

Trusted reusable pipeline policy belongs in `scripts/pi-common/`, with its purpose and non-goals documented in `scripts/pi-common/README.md`. YAML should express stage order, conditions, permissions, and environment wiring—not copies of GitHub API clients, pagination loops, security gates, state-machine logic, or deterministic product-check implementations. Repeated GitHub REST routes are centralized in `github-api.mjs`; workflow YAML must not use inline `curl` for them. `workflow-dispatch.mjs` is the small adapter for no-input workflow wakes and pins those wakes to trusted `dev`.

Keep stage-specific orchestration outside the common directory. A helper is common only when multiple stages need the same deterministic rule.

All model-driven stages run through `pi-run-stage.mjs`, which wires one shared progress controller plus the stage-specific terminal tool. The controller owns bounded orientation, complexity declaration, repeat/turn protection, response budgets, single-use startup actions, and productive-progress state. The global turn ceiling remains an emergency bound, but Implementer no longer depends on a no-progress turn count: once the planner's bounded initial evidence budget (0–6 actions; see `CI_RULES.md`) is spent it enters `ACTION_REQUIRED`, where it must take a productive action (`structural_edit`, `safe_edit`, `edit`, `write`, `begin_coding_session`, `rollback_last_mutation`, or `submit_result`) or declare one concrete `need_more_evidence` blocker to unlock exactly one more evidence action. Dispatcher becomes terminal-only after its prepared candidate context is loaded. Complexity is planning metadata, not a second quota system. Model prose or a process exit is never accepted as a substitute for a trusted terminal result artifact.

## Recovery rule

Recovery must be smaller than the normal pipeline. For issue work, Reconciler only restores durable ownership: in RUNNING lost work goes back to `dispatcher:ready`; it never dispatches Implementer or Architect directly. Do not reproduce the happy path inside Reconciler, and do not add recovery-specific copies of merge/review/dispatch logic. `DRAINING` disables creation/recreation of issue-ready states while preserving recovery for already-published PRs. A durable Architect parent marker makes partial child publication idempotently recoverable without rerunning model planning.

## Change test

Before adding CI machinery, ask:
1. Can the receiver read this value from GitHub instead of receiving it?
2. Can one existing owner perform this transition directly?
3. Is this already covered by ordinary exact-head PR CI or post-merge `dev` CI?
4. Can GitHub's atomic API operation handle the race?
5. Does this belong to recovery rather than the happy path?

If yes, use the simpler path.
