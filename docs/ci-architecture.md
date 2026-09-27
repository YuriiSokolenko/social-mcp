# CI architecture

The control plane intentionally uses a simple contract:

1. An implementation agent finishes an issue and publishes a PR.
2. Merge Gate validates only that the PR belongs to the expected issue/repository, is not a draft, and does not modify protected control-plane files.
3. Merge Gate squash-merges at most one PR into `dev` per run.
4. The normal `push` CI runs on the resulting merged `dev` commit.
5. Green CI means the merged result is accepted and wakes Merge Gate for the next ready PR. Red CI stops the merge sequence and must not be converted into a pre-merge state machine.

## Complexity guard

Do not reintroduce pre-merge exact-pair orchestration.

In particular, the merge decision must not depend on a captured dev SHA, `integration_base_sha`, `repair_base_sha`, synthetic dev+PR merge commits, SHA/base-bound status contexts, or a pre-merge CI/review/repair chain.

A PR head SHA may still be supplied to GitHub's merge API as normal optimistic concurrency protection. That is not pipeline state.

Prefer GitHub's own merge operation and the ordinary CI run on `dev` over custom synchronization/state. If a new requirement appears, first try to express it as a post-merge `dev` CI check or a simple issue/PR state instead of adding another orchestration layer.


## Workflow input rule

Keep `workflow_dispatch` inputs minimal.

A workflow may receive only:
- the minimal identifier of the object it must operate on, such as `issue_number`, `pr_number`, or a completed `run_id`; or
- a real user command that cannot be derived from repository state, such as the automation `mode`.

Do not pass derived or duplicated GitHub data between workflows. In particular, do not add titles, branch/base/head SHAs, reasons, labels, status/state snapshots, URLs, or other metadata as workflow inputs when the workflow can load the current value from GitHub using the object identifier.

Prefer this contract:

`object ID / command → workflow loads current GitHub state → workflow acts`

Do not use workflow inputs as a transport layer or as hidden pipeline state. Before adding a new input, first prove that the value cannot be derived safely from GitHub state inside the receiving workflow.


## SHA rule

A SHA is not pipeline state and must not be transported between workflows.

Do not pass a SHA from workflow A to workflow B, store it as orchestration state, or use it to create a custom cross-workflow state machine.

A workflow may read the current SHA directly from GitHub and use it locally for one atomic operation where optimistic concurrency is required. Examples include supplying the current PR head SHA to the GitHub merge API or using the current remote SHA with `--force-with-lease`.

The distinction is intentional:

- forbidden: `workflow A → SHA → workflow B`;
- allowed: `workflow → read current SHA from GitHub → use it locally for merge/lease protection`.

Once that local operation finishes, the SHA has no orchestration meaning. GitHub repository state is the source of truth.


## Trusted control-plane rule

All control-plane workflows must execute orchestration scripts from an explicit trusted checkout of `dev`.

This includes Architect, Merge Gate, Dispatcher, Implementer, PR Fix, PR Review, Reconciler, Triage, and Usage collection. Their checkout must explicitly use `ref: dev`, and control-plane scripts/extensions must be invoked from that trusted checkout (normally through `$GITHUB_WORKSPACE/scripts/...`).

Do not execute `scripts/pi-*` from a PR branch, issue branch, event commit, worktree being modified by an agent, or any other untrusted/ref-dependent checkout.

The normal CI workflow is intentionally different: it checks out and tests the commit that triggered CI. It must not execute control-plane `scripts/pi-*` from that tested commit.

In short:

`control plane → trusted dev checkout`

`tested application code → triggering commit`
