# CI and Agent Workflow Rules

This document defines the repository's CI/CD and AI-agent workflow conventions.

## Goals

The pipeline is designed to:

- keep `main` stable and put reviewed implementation changes into `dev`;
- isolate untrusted public CI from trusted local AI execution;
- ensure every implementation includes tests;
- require deterministic verification before creating a pull request;
- review AI-generated pull requests independently before merge;
- keep self-hosted runners ephemeral and disposable.

## Branch roles

`dev` is the GitHub default branch. GitHub loads default-branch events such as `repository_dispatch` and `workflow_run` from `dev`. Pi workflows check out `dev` for their executable scripts, and the automation control workflow dispatches the dispatcher with ref `dev`. `main` is reserved for future releases.

`dev` is the development integration branch. Pi issue branches start at `dev`; issue PRs, independent review, the auto-merge gate, and dispatcher task metadata target `dev`. The dispatcher triggered by a merged PR checks out `dev`. CI runs on PRs and pushes to both branches.

For manual maintenance and agent-assisted changes, apply changes to `dev`. Control workflow definitions and executable Pi scripts run from `dev`. Do not modify `main` as part of routine development.

Automatic issue merges target only `dev`. When releases begin, promote a verified `dev` state to `main` with a separate human-reviewed PR. Use a merge commit for the release promotion so subsequent promotions preserve branch ancestry; tag the release on `main` after its checks pass. Do not squash or rebase the `dev` → `main` promotion. Ordinary Pi issue PRs cannot auto-merge changes to workflow definitions or `scripts/pi-*.mjs` and `scripts/pi-*.sh`; those changes require a separate human-reviewed update.

## Trust boundaries

### Public GitHub-hosted CI

The standard CI workflow runs on GitHub-hosted `ubuntu-latest` runners.

It is safe to run for public pull requests because it does not execute on the N150 host and has read-only repository permissions.

It performs:

- Ruff;
- pytest;
- Docker Compose build/start;
- `/health` verification;
- teardown of the isolated Compose environment.

Workflow:

```text
.github/workflows/ci.yml
```

### Trusted N150 AI runners

Pi implementation and review jobs run only on self-hosted runners labeled:

```text
self-hosted
linux
x64
n150
pi-agent
```

These runners are for trusted repository workflows only.

Do not route arbitrary public pull-request code directly to the N150 runner.

## Global automation control

The repository-wide automation state is stored in the GitHub Actions repository variable:

```text
PI_AUTOMATION_MODE
```

Supported values are:

```text
RUNNING
DRAINING
PAUSED
```

Semantics:

- `RUNNING`: the complete automation flow is enabled. The dispatcher may assign new issues and existing PRs may continue through review, repair, CI, and auto-merge.
- `DRAINING`: no new issues are assigned or started. Work already represented by PRs may continue through review, repair, CI, and auto-merge until the active queue drains.
- `PAUSED`: no new automated pipeline stage should start. Dispatcher, issue implementation, PR review, PR repair, and auto-merge jobs are gated off. Jobs that were already running when the mode changed are not forcibly terminated.

The normal Web UI control is:

```text
GitHub -> Actions -> Pi Automation Control -> Run workflow
```

Workflow:

```text
.github/workflows/pi-automation-control.yml
```

Choose `RUNNING`, `DRAINING`, or `PAUSED`. Selecting `RUNNING` also wakes the Pi Dispatcher so eligible work can resume without another manual action.

The repository variable can also be edited directly under:

```text
Settings -> Secrets and variables -> Actions -> Variables
```

The expected normal value is `RUNNING`.

The workflow guards treat an absent or unknown value as disabled (fail-closed). Set `RUNNING` explicitly to start new issue work, `DRAINING` to let active PRs finish, or `PAUSED` for a full stop. Deleting the variable does not resume automation.

## Issue implementation flow

Implementation starts when an issue receives:

```text
pi:ready
```

The dispatcher can set that label via its workflow. Because labels added with `GITHUB_TOKEN` do not themselves start another workflow, the dispatcher also sends `repository_dispatch` event `pi_dispatch_issue` to the issue workflow. A person can still start the existing path by applying `pi:ready` directly.

Workflow:

```text
.github/workflows/pi-issue-agent.yml
```

The issue workflow uses per-issue concurrency:

```text
pi-issue-<issue-number>
```

A new run for the same issue cancels the previous one.

### Implementer responsibilities

The Pi implementer must read:

```text
agents/implementer/AGENTS.md
```

The implementer must:

- inspect the issue, existing code, and existing tests before editing;
- implement only the requested change;
- add or update unit tests for every changed behavior;
- cover acceptance criteria and important edge cases;
- avoid unrelated refactors and dependency changes;
- avoid production social-network API calls in tests;
- leave the working tree ready for CI.

The implementer must not:

- commit;
- push;
- create or merge a pull request;
- modify GitHub labels or comments;
- expose credentials or production secrets.

GitHub operations are owned by the workflow, not by the model.
The agent steps do not receive `GH_TOKEN`, and checkout does not persist GitHub credentials.
Only the workflow's dedicated API and push steps receive the token.

## Mandatory verification before PR

After Pi finishes, the workflow independently runs:

```bash
pytest
ruff check .
```

A pull request must not be created or updated if either command fails.

This verification is mandatory even if the agent reports that it already ran the tests itself.

## Temporary worktree policy

Each implementation job runs in a unique temporary Git worktree under `RUNNER_TEMP`.

The issue branch naming convention is:

```text
pi/issue-<issue-number>
```

Temporary worktrees and task files must be removed in an `always()` cleanup step.

After Pi finishes, the workflow commits its changes to `pi/issue-<number>-checkpoint`
before running independent checks. A retry resumes that branch (or an existing PR
branch if no checkpoint exists) instead of resetting to `dev`. The checkpoint is
never a merge candidate. The workflow fetches current `dev`, integrates it, and
runs pytest and Ruff on the integrated tree. A conflict or failing check gets one
focused Pi repair attempt and another independent verification. On failure,
`pi:failed` includes a checkpoint link; the checkpoint remains available for
recovery. On success, the verified issue branch is pushed and the checkpoint is
removed only after a PR exists. Never delete a failed run's only checkpoint.

Local execution artifacts must never be committed. The workflow removes caches
before saving code; `.venv/` remains ignored while integrated tests run and is
removed before the verified branch is pushed. Excluded artifacts include:

```text
.venv/
.pytest_cache/
.ruff_cache/
htmlcov/
build/
dist/
.coverage
coverage.xml
__pycache__/
```

The repository `.gitignore` must also exclude local Python, test, build, environment, database, and secret artifacts.

## Commit and PR creation

If repository changes exist:

1. the workflow saves a recoverable checkpoint;
2. integrates `dev` and independently verifies the result;
3. pushes the verified issue branch;
4. creates or updates a pull request targeting `dev`;
5. triggers an independent Pi PR review.

The implementer itself never performs these GitHub operations.

The PR body links the issue with:

```text
Closes #<issue-number>
```

## PR review flow

The review workflow is:

```text
.github/workflows/pi-pr-review.yml
```

It is triggered by the repository event:

```text
pi_pr_review
```

For a hung or interrupted review, use **Pi PR Review → Run workflow** on
`dev` and enter its PR number. Review runs for the same PR share a concurrency
group with `cancel-in-progress: true`; the new run replaces the old one.

and may also be manually retriggered by reopening a PR.

Only same-repository branches matching:

```text
pi/issue-*
```

are accepted for the trusted self-hosted review path.

PRs from forks or unexpected branch names must not run on the trusted Pi reviewer.

## Reviewer responsibilities

The reviewer must read:

```text
agents/reviewer/AGENTS.md
```

The reviewer is independent from the implementer and must not change files.

It checks:

- linked issue compliance;
- acceptance criteria;
- correctness and important edge cases;
- regressions;
- unnecessary changes;
- test quality and missing tests;
- architecture consistency;
- security-sensitive changes;
- accidental generated/local artifacts.

The reviewer must not:

- modify files;
- commit or push;
- merge the PR;
- change issues or labels directly;
- post GitHub state changes directly.

The workflow interprets the reviewer verdict and performs the GitHub updates.

## Deterministic review checks

Every trusted Pi run loads `scripts/pi-bash-timeout.mjs` from the checked-out
`dev` control repository. It wraps Pi's built-in `bash` tool with a per-command
limit even if the model does not supply `timeout`. A shorter model-specified
timeout is honored; a longer one is capped. Review, Architect, and Dispatcher
use 600 seconds; PR repair uses 1200 seconds; implementation uses 1800 seconds.
Pi terminates the shell process tree when this limit expires. Job-level
`timeout-minutes` remains a separate bound for the entire run. The extension
path must come from the trusted control checkout, not a PR worktree.

Before asking Pi for a verdict, the review workflow runs:

```bash
pytest
ruff check .
```

The exit codes and logs are supplied to the reviewer.

A failing deterministic check can never receive a PASS verdict.
If the reviewer omits the required final verdict, the review workflow retries
the review once without rerunning the issue implementation. A second failure
sets `review:failed` for manual investigation. Review results are valid only
for the exact PR head and `dev` base recorded at review start.

## Reviewer verdict contract

The final reviewer response must begin with exactly one of:

```text
REVIEW_RESULT: PASS
```

or:

```text
REVIEW_RESULT: CHANGES_REQUESTED
```

The workflow maps the result to review labels and posts the review summary.
After a current PASS with successful pytest and Ruff checks is recorded, the
review workflow explicitly dispatches Pi Auto Merge on `dev`. The gate still
checks current CI, the reviewed PR head, and mergeability before merging.

Expected review labels include:

```text
review:ready
review:running
review:passed
review:changes-requested
review:failed
```

## Dispatcher queue

Only an open issue with `dispatcher:ready` is a dispatcher candidate. Its
`tasks/<issue-number>.md` file must exist on `dev`, declare the matching issue
number, a priority `P0`, `P1`, or `P2`, and completed dependencies. The
task file is the source of truth for priority. A file alone never starts work.

The dispatcher agent reads `agents/dispatcher/AGENTS.md` and
`docs/PROJECT_CONTEXT.md`. It recommends issue numbers but cannot mutate GitHub.
The workflow independently checks its output and the current GitHub state.
It classifies each candidate for direct implementation or Pi Architect. A
decomposed child may also go to Architect if its remaining scope is still too
large; its descendants form another level in the issue tree.
Before either agent plans, its trusted workflow snapshots open `dev` PRs,
active issue labels, and queued/running Actions jobs into the agent context.
Run names include issue or PR numbers where available so work in progress can
be linked back to its issue. The snapshot may be incomplete; the dispatcher
always rechecks fresh GitHub state before changing any label or dispatching.
All currently eligible candidates are dispatched in one run, ordered P0, P1,
P2 and then by ascending issue number. Dispatcher readiness is independent of
runner capacity: GitHub Actions may queue any excess Pi jobs, while the N150
autoscaler limits actual concurrent execution.

Dispatcher jobs use one repository-wide GitHub Actions concurrency group,
`pi-dispatcher`, with `cancel-in-progress: false`. Therefore only one
dispatcher job may execute at a time; additional merge/manual triggers wait
instead of interrupting the current dispatcher. Every queued dispatcher rebuilds
a fresh GitHub snapshot after it starts. Trigger payloads are wake-up signals,
not selection state. Apply is idempotent: an issue already made active by an
earlier dispatcher is a no-op and must never receive a duplicate
`pi_dispatch_issue` event.

The dispatcher workflow is:

```text
.github/workflows/pi-dispatcher.yml
```

It runs after a PR is merged into `dev`, or from a manual workflow run on `dev` for initial queue filling. Dispatcher jobs use one repository-wide concurrency group, `pi-dispatcher`, with `cancel-in-progress: false`. The dispatcher checks out `dev`, not the merged PR head. The write-capable workflow token is limited to validation and label steps; it is not passed to the Pi dispatcher process.

The auto-merge gate waits for an active `review:running` job to finish before
updating a PR branch that fell behind `dev`. A review made stale by a changed
base releases its running label without approving the old result; the next gate
run refreshes the branch and requests review of the new head.

For each accepted issue the workflow adds `pi:ready`, sends
`pi_dispatch_issue`, and removes `dispatcher:ready`. The last step occurs
**when work is assigned**, not when its PR merges. After an implementation PR merges into `dev`, GitHub closes the linked issue through `Closes #<issue-number>`. Pi Auto Merge also checks that the issue is completed, recovers interrupted finalization, and prompts the dispatcher to fill a free slot. Closing a PR without merging does not refill the queue. If no task is eligible, the dispatcher job succeeds without calling Pi.

Failures, missing task metadata, and stale states must be reported rather than
silently assigning a different issue. `pi:failed`, `pi:needs-human`, and
`pi:cancelled` require human attention before the issue may be made eligible
again. Task-file structure and label lifecycle are specified in `tasks/README.md`.

For a broad candidate, the dispatcher adds `architect:ready`, explicitly
dispatches `.github/workflows/pi-architect.yml` on `dev`, and then removes
`dispatcher:ready`. GitHub Actions does not run a new workflow on label events
made with `GITHUB_TOKEN`; the explicit dispatch is required. Pi Architect
reads the issue and downloaded planning skills, proposes two to six small tasks,
and makes no GitHub changes itself. Architect may also review an inactive
issue already awaiting the dispatcher: keep it, revise its issue and task
metadata, or split it. A kept or revised issue returns to its previous
dispatcher eligibility; a deferred issue stays deferred. The workflow
validates a split plan, creates
child issues and their task files on `dev`, gives children `dispatcher:ready`,
then explicitly dispatches Pi Dispatcher again. The parent gets
`architect:epic` and closes as completed when every child is completed after
merge into `dev`. If a child is also decomposed, it closes after its own
children complete; completion then propagates upward through all ancestors.
Architect runs share a repository-wide concurrency group with `queue: max`,
so a batch of review requests waits in order without replacing pending runs.
Separate contract tasks come first only for shared stable
interfaces; separate test tasks precede implementation only when they can
merge with passing CI. Otherwise each implementation issue includes its tests.
The skills and pinned upstream versions are recorded in `docs/skills-sources.md`.

## First dispatcher run

To approve a specific issue for automatic implementation:

1. Merge its `tasks/<issue-number>.md` file into `dev` and check its
   priority and dependencies.
2. Add `dispatcher:ready` to the open issue. This label alone does not
   launch Pi.
3. In GitHub Actions, open **Pi Dispatcher** and use **Run workflow** on
   `dev`, or let the next PR merge into `dev` start the dispatcher.
4. Check the dispatcher job log for the selected issue and the separate
   **Pi Issue Agent** run. On assignment, `pi:ready` appears and
   `dispatcher:ready` is removed.
5. If the issue is skipped, read the reason in the dispatcher job before
   changing its metadata or labels. Do not add `pi:ready` merely to bypass
   validation.

The dispatcher job skips Pi entirely when no eligible candidates exist. The first run also ensures the `dispatcher:ready` label exists.
A real dispatch depends on the N150 self-hosted runner and its configured
Pi/model endpoint being available.

## Issue status labels

The implementation workflow uses labels including:

```text
dispatcher:ready
pi:ready
pi:running
pi:mr-created
pi:needs-human
pi:failed
pi:cancelled
```

The workflow, not the model, owns label transitions.

## Autoscaler

The N150 runner autoscaler is managed by:

```text
infra/github-runner-autoscaler/
```

The manager must watch these trusted workflows:

```text
pi-issue-agent.yml
pi-pr-review.yml
pi-dispatcher.yml
pi-architect.yml
```

The N150 host's local `MAX_RUNNERS` sets the concurrent worker limit; the
tracked example defaults to two and does not override that local value.

Expected behavior:

```text
0 queued/busy jobs -> 0 workers
1 job              -> 1 worker
2+ jobs            -> up to MAX_RUNNERS workers
```

Additional jobs wait in the GitHub Actions queue.
When the N150 host sets `MODEL_STATUS_URL` to the active llama.cpp `/slots`
endpoint, the manager counts total slots and occupied slots before starting
more runners. It reserves a slot for every active runner, including pauses
between model requests. A vLLM `/metrics` endpoint instead defers new runners
while requests wait. Unreadable status also delays new runners. Active jobs
continue; the local `MAX_RUNNERS` remains the upper bound, and an unset URL
keeps the previous queue-only behavior.
When the queue is empty, the manager retires any surplus idle online runners
while leaving GitHub-busy workers alone. Otherwise an idle runner could take a
new job without going through the model admission check.

Each worker:

- is registered as an ephemeral GitHub Actions runner;
- handles one job;
- is removed after the job;
- uses host networking for access to the local model endpoint;
- does not receive the Docker socket;
- does not run privileged;
- does not mount the host root filesystem.

The manager alone has the Docker socket and the runner-administration PAT.

## Pi configuration isolation

The host Pi configuration is mounted read-only into each ephemeral container at:

```text
/pi-config-ro
```

At worker startup it is copied into that worker's private writable Pi home.

Never share a single writable Pi config directory between concurrent workers because Pi creates lock files and mutable auth/model metadata.

## Concurrency

Issue jobs are serialized per issue, but different issues may run in parallel.

PR review jobs are serialized per PR, but different PRs may run in parallel.

The autoscaler applies a shared overall worker limit.

## Repository protection

The intended repository policy is:

- `dev` is the default branch; Pi issue branches start from it and target it through pull requests;
- implementation PRs pass CI and independent Pi review before the auto-merge gate merges them into `dev`;
- release promotions from `dev` to `main` require CI and human review, and use merge commits;
- protect both `dev` and `main` against force pushes, deletion, and merges that bypass their required checks or reviews;
- automation may push only issue branches such as `pi/issue-*`; release PRs must not use the Pi issue auto-merge path.

Repository rulesets/branch protection must enforce these rules independently of agent prompts.

The repository should not rely on AI instructions as a security boundary.

## Secrets

Never commit:

- GitHub administration PATs;
- OAuth access or refresh tokens;
- client secrets;
- encryption keys;
- Authorization headers;
- cookies;
- local `.env` files;
- production credentials.

The runner-administration PAT stays only in the local autoscaler `.env` on N150.

Runtime application credentials are provided through environment variables or an appropriate secret mechanism.

## Failure handling

If implementation fails:

```text
pi:failed
```

If no repository changes are produced:

```text
pi:needs-human
```

If review execution fails:

```text
review:failed
```

If review identifies blocking problems:

```text
review:changes-requested
```

If review passes:

```text
review:passed
```

A failed review should not be treated as approval.

## Expected end-to-end flow

```text
Issue
  |
  | pi:ready
  v
Pi Implementer
  |
  | code + unit tests
  v
pytest + Ruff
  |
  | pass
  v
Commit + push pi/issue-*
  |
  v
Pull Request
  |
  v
Pi Reviewer
  |
  +--> pytest + Ruff
  |
  +--> PASS --------------------> review:passed
  |
  +--> CHANGES_REQUESTED -------> review:changes-requested
```

The implementation and review roles must remain separate.
