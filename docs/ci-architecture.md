# CI architecture

The control plane intentionally uses a simple contract:

1. Dispatcher routes eligible work.
2. Implementer integrates the latest `dev` in its live session, resolves conflicts, validates the result, and produces a verified PR.
3. Reviewer runs deterministic checks on the exact PR HEAD and independently approves that same HEAD or requests changes.
4. Merge Gate validates basic ownership/safety and attempts a GitHub squash merge.
5. Ordinary `push` CI tests the resulting `dev` commit.
6. Green post-merge CI wakes Merge Gate for the next ready PR; red CI stops the merge sequence.

The actual merged `dev` commit is the integration truth.

## Test ownership rule

Implementer, Reviewer, and PR Fix validate product behavior only: focused product tests as needed, full `pytest`, Ruff, and diff checks. They do not run CI/control-plane contract suites (`tests/*.test.mjs`, runner-autoscaler tests, or workflow self-tests). `ci.yml` exclusively owns those control-plane checks and runs them on the triggering `dev` commit. This keeps product agents focused and prevents CI from recursively testing itself inside agent workflows.

## Complexity guard

Do not reintroduce pre-merge exact-pair orchestration. The merge decision must not depend on captured dev SHAs, `integration_base_sha`, `repair_base_sha`, synthetic dev+PR merge commits, SHA/base-bound status contexts, or a custom pre-merge CI/review/repair state machine.

A PR head SHA may be read immediately before GitHub's merge call and supplied as optimistic concurrency protection. That is local operation data, not pipeline state. Prefer GitHub's atomic repository operations and fresh-state reads over custom synchronization.

## Ownership rule

Every normal transition has one obvious owner:
- Dispatcher owns queue routing.
- Architect owns optional decomposition.
- Implementer workflow owns publication of implementation PRs.
- Reviewer/PR Fix own review and requested changes.
- Merge Gate owns merge attempts.
- CI owns validation of the merged `dev` result.
- Reconciler owns recovery only.

Do not make Reconciler, Usage, or another diagnostic workflow a second scheduler.

## Wake rule

A wake event means only: "re-check your current work." It must not carry authoritative pipeline state.

Normal wake sources are readiness change -> Dispatcher, successful review -> Merge Gate, successful merged-`dev` CI -> Merge Gate for the next PR, and explicit/manual control -> selected workflow. Reconciler must not wake Merge Gate.

## Merge conflict rule

Merge Gate simply attempts the merge. If GitHub reports a late conflict, it removes the now-stale `review:*` verdict, dispatches PR Fix, and stops the queue without failing Merge Gate.

PR Fix—not Merge Gate—integrates current `dev`. Its live repair session resolves any content conflicts, runs deterministic checks, pushes the new PR HEAD, and starts a fresh Reviewer. Do not add mergeability polling, transported dev SHAs, synthetic integration, or conflict-solving code to Merge Gate.

## Post-merge CI rule

```text
PR -> merge into dev -> CI on actual dev commit
                         |
                   +-----+-----+
                   |           |
                 green         red
                   |           |
             next merge      stop
```

Do not duplicate this with a pre-merge approximation.

## Workflow input rule

Keep dispatch payloads minimal: an object identifier such as `issue_number`, `pr_number`, or `run_id`, or a genuine user command such as automation `mode`.

Do not pass titles, labels, branch/base/head SHAs, URLs, reasons, or state snapshots when the receiver can load current GitHub state.

```text
object ID / command -> load current GitHub state -> act
```

## SHA rule

A SHA is not cross-workflow pipeline state.

Forbidden: `workflow A -> SHA -> workflow B`.

Allowed: `workflow -> read current SHA -> use locally for one atomic operation`.

Once that operation finishes, the SHA has no orchestration meaning.

## Agent control-plane boundary

The CI control plane is not agent-editable. No Pi agent may create, edit, delete, rename, review, repair, or auto-merge changes under `.github/workflows/**`, `scripts/pi-*`, `tests/*.test.mjs`, `tests/test_runner_autoscaler.sh`, or `infra/github-runner-autoscaler/**`. Trusted tooling enforces this independently of prompts. Control-plane maintenance is performed only through the trusted human/direct-`dev` path.

## Trusted control-plane rule

All control-plane workflows execute orchestration scripts from an explicit trusted checkout of `dev`, including Architect, Merge Gate, Dispatcher, Implementer, PR Fix, PR Review, Reconciler, Triage, and Usage collection.

Do not execute `scripts/pi-*` from a PR branch, issue branch, event commit, agent worktree, or another ref-dependent checkout. Normal CI is intentionally different: it checks out and tests the triggering commit.

```text
control plane -> trusted dev checkout
tested application code -> triggering commit
```

## Recovery rule

Recovery must be smaller than the normal pipeline. Prefer returning stranded work directly to its normal owner. Do not reproduce the happy path inside Reconciler, and do not add recovery-specific copies of merge/review/dispatch logic.

## Change test

Before adding CI machinery, ask:
1. Can the receiver read this value from GitHub instead of receiving it?
2. Can one existing owner perform this transition directly?
3. Can ordinary post-merge `dev` CI validate this instead?
4. Can GitHub's atomic API operation handle the race?
5. Does this belong to recovery rather than the happy path?

If yes, use the simpler path.
