# CI and Agent Workflow Rules

This document defines the repository's CI/CD and AI-agent workflow conventions.

## Goals

The pipeline is designed to:

- keep `main` protected and review-driven;
- isolate untrusted public CI from trusted local AI execution;
- ensure every implementation includes tests;
- require deterministic verification before creating a pull request;
- review AI-generated pull requests independently before merge;
- keep self-hosted runners ephemeral and disposable.

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

Local execution artifacts must never be committed. The workflow removes common artifacts before committing, including:

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

If repository changes exist after verification:

1. the workflow commits them as the automation identity;
2. pushes the issue branch;
3. creates or updates a pull request targeting `main`;
4. triggers an independent Pi PR review.

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

Before asking Pi for a verdict, the review workflow runs:

```bash
pytest
ruff check .
```

The exit codes and logs are supplied to the reviewer.

A failing deterministic check can never receive a PASS verdict.

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
`tasks/<issue-number>.md` file must exist on `main`, declare the matching issue
number, a priority `P0`, `P1`, or `P2`, and completed dependencies. The
task file is the source of truth for priority. A file alone never starts work.

The dispatcher agent reads `agents/dispatcher/AGENTS.md` and
`docs/PROJECT_CONTEXT.md`. It recommends issue numbers but cannot mutate GitHub.
The workflow independently checks its output and the current GitHub state.
It counts at most two active issue slots, including an open implementation PR
awaiting review or merge. Eligible candidates are ordered P0, P1, P2 and then
by ascending issue number.

The dispatcher job runs after a PR is merged into `main`, or from a manual run
of `.github/workflows/pi-pr-review.yml` for initial queue filling. This
existing workflow file also contains the independent review job and is already
watched by the N150 autoscaler. The dispatcher checks out trusted `main`,
not the merged PR head. The write-capable workflow token is limited to
validation and label steps; it is not passed to the Pi dispatcher process.

For each accepted issue the workflow adds `pi:ready`, sends
`pi_dispatch_issue`, and removes `dispatcher:ready`. The last step occurs
**when work is assigned**, not when its PR merges. A merged implementation PR
closes its linked issue through `Closes #<issue-number>` and prompts the
dispatcher to fill a free slot. Closing a PR without merging does not refill
the queue. If no task is eligible, the dispatcher job succeeds without calling Pi.

Failures, missing task metadata, and stale states must be reported rather than
silently assigning a different issue. `pi:failed`, `pi:needs-human`, and
`pi:cancelled` require human attention before the issue may be made eligible
again. Task-file structure and label lifecycle are specified in `tasks/README.md`.

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

The manager watches both workflows:

```text
pi-issue-agent.yml
pi-pr-review.yml
```

The configured maximum is currently two concurrent ephemeral workers.

Expected behavior:

```text
0 queued/busy jobs -> 0 workers
1 job              -> 1 worker
2+ jobs            -> up to 2 workers
```

Additional jobs wait in the GitHub Actions queue.

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

- no direct changes to `main`;
- changes reach `main` through pull requests;
- no force pushes to `main`;
- no deletion of `main`;
- automation may push only issue branches such as `pi/issue-*`;
- PRs should pass CI and automated review before merge.

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
