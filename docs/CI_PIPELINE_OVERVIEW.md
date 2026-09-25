# CI/CD pipeline overview

This is a visual companion to [`docs/CI_RULES.md`](CI_RULES.md), which is the authoritative
source for every rule, gate, and label semantics summarized here. Read `CI_RULES.md` before
changing any workflow or script; this document only maps the pieces so the pipeline is easy to
hold in your head. Also see [`docs/PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) for product context,
[`docs/deploy.md`](deploy.md) for the Docker deployment, [`tasks/README.md`](../tasks/README.md)
for the task-file format, and `agents/*/AGENTS.md` for each Pi role's instructions.

## Two independent tracks

```text
                        GitHub repository (social-mcp)
                                   |
                +------------------+-------------------+
                |                                       |
        Public CI (ci.yml)                    Trusted Pi automation
        GitHub-hosted ubuntu-latest            self-hosted N150 runner only
        runs on every push and PR              labels: self-hosted, linux,
        permissions: contents: read            x64, n150, pi-agent
        safe for fork/external PRs             gated by PI_AUTOMATION_MODE
        (Ruff, pytest, node tests,             (dispatcher, architect,
         Docker Compose + /health)              implementer, reviewer,
                                                 fixer, auto-merge)
```

Public CI never touches the N150 host. Only same-repository `pi/issue-*` branches ever reach the
trusted runners (enforced in `pi-pr-review.yml`'s branch/repo/draft checks).

## End-to-end Pi pipeline

```text
 GitHub Issue
   + tasks/<n>.md (priority P0/P1/P2, depends_on)
   + label dispatcher:ready
          |
          v
 +---------------------------+
 |      Pi Dispatcher         |  pi-dispatcher.yml
 |                             |  triggers: PR merged into dev, or manual run
 |  classifies every           |  concurrency group "pi-dispatcher" (serialized,
 |  dispatcher:ready issue     |  cancel-in-progress: false)
 +---------------------------+
          |
   +------+-------------------------------+
   |                                      |
 small issue                        broad issue
   |                                      |
   | label pi:ready                       | label architect:ready
   | repository_dispatch                  | explicit workflow dispatch
   | pi_dispatch_issue                    | (ref: dev)
   v                                      v
 +---------------------------+   +----------------------------+
 |     Pi Issue Agent         |   |       Pi Architect          |
 |     pi-issue-agent.yml     |   |       pi-architect.yml      |
 |     self-hosted N150       |   |       self-hosted N150      |
 |     per-issue concurrency  |   |       group "pi-architect", |
 |     (new run cancels old)  |   |       queue: max            |
 +---------------------------+   +----------------------------+
   | temp worktree, branch          | keep / revise / split into
   |   pi/issue-<n>                 |   2-6 steps: contract -> test
   | implement + unit tests         |   -> implementation (ordered,
   | pytest + ruff (workflow-run,   |   dependency-checked)
   |   not just Pi's word)          | creates child issues +
   | commit -> checkpoint branch    |   tasks/<n>.md on dev
   | merge dev, one repair          | children get dispatcher:ready
   |   attempt if needed, re-verify | parent gets architect:epic,
   | push pi/issue-<n>              |   closes only when every
   | open/update PR "Closes #n"     |   child completes (recursive)
   | label pi:mr-created            |
   v                                v
 +---------------------------+   (each child re-enters
 |   Pull Request -> dev      |    Pi Dispatcher above)
 +---------------------------+
          |
          | repository_dispatch pi_pr_review
          v
 +---------------------------+
 |      Pi PR Review          |  pi-pr-review.yml, self-hosted
 |                             |  gate: base=dev, non-draft, same-repo,
 |  independent worktree at    |  head matches ^pi/issue-\d+$
 |  the PR head SHA; runs      |  per-PR concurrency (new run cancels old)
 |  pytest + ruff itself       |
 +---------------------------+
          |
   +------+-------------------------------+
   |                                      |
 REVIEW_RESULT: PASS                REVIEW_RESULT: CHANGES_REQUESTED
 and pytest/ruff both green          or a deterministic check failed
   |                                      |
   | label review:passed                  | label review:changes-requested
   | commit status pi-review=success      | repository_dispatch pi_pr_fix
   | explicit dispatch of                 |
   |   pi-auto-merge.yml                  v
   |                             +----------------------------+
   |                             |        Pi PR Fix             |
   |                             |        pi-pr-fix.yml         |
   |                             |        self-hosted N150      |
   |                             +----------------------------+
   |                               works on the existing
   |                               pi/issue-<n> branch (never
   |                               discards it), addresses
   |                               reviewer feedback, verifies
   |                               pytest+ruff, force-with-lease
   |                               push, then repository_dispatch
   |                               pi_pr_review again (loops back
   |                               to "Pi PR Review" above)
   v
 +---------------------------+
 |      Pi Auto Merge         |  pi-auto-merge.yml, GitHub-hosted
 |                             |  group "pi-auto-merge", serialized,
 |  requires on the SAME head  |  cancel-in-progress: false
 |  SHA: CI success, review    |
 |  commit status success,     |
 |  label review:passed        |
 |                             |
 |  refuses PRs touching       |
 |  .github/workflows/** or    |
 |  scripts/pi-*.mjs|.sh       |
 |  (self-modification guard)  |
 +---------------------------+
          |
          | squash-merge into dev
          | close linked issue
          | close architect:epic parents whose
          |   every child is now completed
          |   (recursively up the tree)
          | re-dispatch Pi Dispatcher on dev
          v
   back to "Pi Dispatcher" (fills the next free slot)
```

## PI_AUTOMATION_MODE gate

```text
 RUNNING    all stages run: dispatcher may start new issues; PRs flow through
            review, repair, CI, and auto-merge.

 DRAINING   no NEW issues are started (dispatcher/architect/issue-agent gated
            off), but PRs already in flight keep moving through review,
            repair, CI, and auto-merge until the queue drains.

 PAUSED     nothing new starts anywhere. Already-running jobs are not killed.

 (absent/unknown value)  same as PAUSED -- fails closed.
```

Set with the **Pi Automation Control** workflow (`pi-automation-control.yml`); `RUNNING` also
wakes the dispatcher. Per-workflow gating:

| Workflow | Requires |
|---|---|
| `pi-dispatcher.yml` | `RUNNING` |
| `pi-architect.yml` | `RUNNING` |
| `pi-issue-agent.yml` | `RUNNING` |
| `pi-pr-review.yml` | `RUNNING` or `DRAINING` |
| `pi-pr-fix.yml` | `RUNNING` or `DRAINING` |
| `pi-auto-merge.yml` | `RUNNING` or `DRAINING` |
| `ci.yml` | always (public, ungated) |

## Label state machines

```text
Issue:  dispatcher:ready --+--> pi:ready --> pi:running --> pi:mr-created --> (closed on merge)
                            |
                            +--> architect:ready --> architect:epic (parent; closes when
                                                       every child issue is completed)

Terminal, needs a human: pi:needs-human, pi:failed, pi:cancelled, pi:blocked

PR:     review:ready --> review:running --+--> review:passed
                                           |
                                           +--> review:changes-requested --(Pi PR Fix)--> review:ready (loop)
                                           |
                                           +--> review:failed (retry exhausted, needs a human)
```

Labels are only ever written by the workflow scripts (`scripts/pi-issue-status.sh`,
`scripts/pi-pr-review-status.sh`, `scripts/pi-dispatcher.mjs`, `scripts/pi-architect.mjs`,
`scripts/pi-auto-merge.mjs`) — never directly by the Pi model.

## N150 runner autoscaler

```text
 GitHub Actions queue
 (pi-issue-agent.yml, pi-pr-review.yml,
  pi-dispatcher.yml, pi-architect.yml)
          |
          | polled every POLL_SECONDS (default 10s)
          v
 +----------------------------+
 |   manager.sh (N150 host)    |
 |   - counts queued + pending |
 |   - counts busy runners     |
 |   - retires surplus idle    |
 |     runners when queue = 0  |
 |   - checks MODEL_STATUS_URL |---> llama.cpp /slots  (total vs. busy slots,
 |     for model capacity      |       reserves 1 slot per active runner)
 |                              |---> vLLM /metrics     (any waiting request
 |                              |       => 0 new runners)
 +----------------------------+
          |
          | docker run --rm --ephemeral, up to MAX_RUNNERS,
          | throttled by model capacity above
          v
 +----------------------------+
 |  ephemeral runner container |  host networking (reaches local model),
 |  registers, handles ONE job,|  no Docker socket, not privileged,
 |  then is removed            |  no host-root mount
 |                              |  gets /pi-config-ro (read-only host Pi
 |                              |  config), copied to a private writable
 |                              |  Pi home at startup (no shared locks)
 +----------------------------+
```

Only the manager holds the Docker socket and the runner-administration PAT
(`infra/github-runner-autoscaler/.env`, local to the N150 host, never committed).

## Workflow trigger reference

| Workflow | Runs on | Trigger | Concurrency |
|---|---|---|---|
| `ci.yml` | GitHub-hosted | push, pull_request, workflow_dispatch | per ref, cancel-in-progress |
| `pi-automation-control.yml` | GitHub-hosted | workflow_dispatch (mode input) | none |
| `pi-dispatcher.yml` | N150 self-hosted | PR merged into dev, workflow_dispatch | `pi-dispatcher`, serialized |
| `pi-architect.yml` | N150 self-hosted | issue labeled `architect:ready`, workflow_dispatch | `pi-architect`, queue: max |
| `pi-issue-agent.yml` | N150 self-hosted | issue labeled `pi:ready`, `repository_dispatch: pi_dispatch_issue` | per issue, cancel previous |
| `pi-pr-review.yml` | N150 self-hosted | `repository_dispatch: pi_pr_review`, PR reopened, workflow_dispatch | per PR, cancel previous |
| `pi-pr-fix.yml` | N150 self-hosted | `repository_dispatch: pi_pr_fix`, workflow_dispatch | per PR, cancel previous |
| `pi-auto-merge.yml` | GitHub-hosted | `workflow_run` completion of CI or Pi PR Review, workflow_dispatch | `pi-auto-merge`, serialized |
| `pi-usage.yml` | GitHub-hosted | `workflow_run` completion of Issue Agent/Review/Fix/Architect, workflow_dispatch | none |

## Bash timeout per phase

Enforced by the `scripts/pi-bash-timeout.mjs` Pi extension (loaded from the trusted `dev`
checkout only), capping or overriding any model-requested timeout. Independent of the job-level
`timeout-minutes`.

| Phase | `PI_BASH_TIMEOUT_SECONDS` |
|---|---|
| Dispatcher, Architect, PR Review | 600 |
| PR Fix (repair) | 1200 |
| Issue implementation | 1800 |

## Script responsibilities

| Script | Role |
|---|---|
| `scripts/pi-dispatcher.mjs` | snapshot + classify + apply dispatcher decisions, task-file validation |
| `scripts/pi-architect.mjs` | prepare/publish architect plans, parent/child issue linking |
| `scripts/pi-auto-merge.mjs` | the merge gate state machine |
| `scripts/pi-issue-status.sh` | issue label/comment state transitions |
| `scripts/pi-pr-review-status.sh` | PR review label/comment/commit-status transitions |
| `scripts/pi-bash-timeout.mjs`, `scripts/pi-bash-timeout-policy.mjs` | per-command Pi bash timeout cap |
| `scripts/pi-loop-guard.mjs`, `scripts/pi-loop-guard-policy.mjs` | Architect-only: block tool calls past a turn/repeat-call budget |
| `scripts/pi-log-filter.mjs` | streams/filters Pi's JSON event log into the Action log |
| `scripts/pi-review-result.mjs` | parses the mandatory `REVIEW_RESULT:` line from Pi's output |
| `scripts/pi-queue-context.mjs` | builds the live issues/PRs/Actions-queue snapshot fed to dispatcher and architect prompts |
| `scripts/pi-usage-collect.mjs`, `scripts/pi-usage-summary.mjs` | harvest token/cost usage from Pi run logs |
