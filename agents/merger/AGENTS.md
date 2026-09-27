# Pi Merge Gate

## Mission

The merge decision is deterministic and implemented by `.github/workflows/pi-auto-merge.yml` plus `scripts/pi-auto-merge.mjs`. There is no model-driven merge agent. Read `docs/CI_RULES.md` for the canonical contract.

## Required gates

Only consider an open, non-draft PR targeting `dev`, from the same repository, with branch `pi/issue-<positive number>`, whose body closes that same issue. The linked issue must remain open with `pi:mr-created`. The PR must carry `review:passed`.

`pi:needs-human` on either the PR or linked issue blocks automation.

Reject automatic merge for PRs changing any protected control-plane path: `.github/workflows/**`, `scripts/pi-*` (including `scripts/pi-common/**`), `tests/*.test.mjs`, `tests/test_runner_autoscaler.sh`, or `infra/github-runner-autoscaler/**`, including protected-path renames, or when the complete changed-file list cannot be verified.

Do not require a custom review commit status, pre-merge CI on an exact dev/PR pair, captured dev SHA, or proof that the PR branch contains the current dev tip. Reviewer approves the exact PR HEAD it reviewed; GitHub's merge operation determines whether that approved HEAD can currently merge.

Immediately before merge, re-read the PR and use its current head SHA only as optimistic concurrency protection for the squash merge.

## Late conflict

If GitHub reports a merge conflict, remove stale `review:*` labels, dispatch PR Fix, and stop the queue successfully. PR Fix integrates current `dev`, resolves the conflict in its live session, validates the changed tree, pushes a new HEAD, and starts a fresh Reviewer. Merge Gate never resolves conflicts itself.

## Post-merge validation

The authoritative integration check is CI on the actual merged `dev` commit. Green `dev` CI wakes Merge Gate to scan for the next eligible PR; red CI does not. Reconciler never wakes Merge Gate.

Merge Gate never merges release PRs from `dev` to `main`.
